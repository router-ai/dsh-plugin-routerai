// Инструмент агента «нарисовать картинку». Картинка показывается в чате и сохраняется
// в папку routerai-media рабочего каталога, чтобы ею можно было пользоваться дальше.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ModelCard } from './catalog.ts'
import { fitAspectRatio, fitCount } from './fit.ts'
import { DRAW_TOOL, MEDIA_FOLDER } from './links.ts'
import { drawPictures } from './media.ts'
import type { Picture } from './media.ts'
import { rub } from './money.ts'
import { allowedHint, registerLiveTool } from './toolkit.ts'

export { DRAW_TOOL, MEDIA_FOLDER }
/** Предел числа картинок за вызов, если модель своего не сообщает. */
const DEFAULT_MOST = 4

export interface DrawDeps {
  apiBase: string
  readKey(): Promise<string | undefined>
  /** Модель для картинок из настроек; null — рисование выключено. */
  imageModel(): string | null
  findModel(slug: string): ModelCard | undefined
  attachments(): Context['attachments'] | undefined
  /** Картинка оплачена: учесть её в стоимости сессии. */
  charged(sessionId: string, model: string, rub: number): void
  /** Подписка на смену настроек и каталога. */
  watch(listener: () => void): () => void
}

const EXTENSIONS: Record<Picture['type'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }
const SHOWN_IN_CHAT: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] satisfies ImageMediaType[]

/** Имя файла из пожелания модели или из описания картинки: латиница, цифры, дефисы. */
export function fileStem(wish: string | undefined, prompt: string, now = new Date()): string {
  const base = (wish ?? '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  if (base !== '') return base
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const words = prompt.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 4).join('-') ?? ''
  return words === '' ? `image-${stamp}` : `${words.slice(0, 40)}-${stamp}`
}

interface Drawn {
  model: string
  /** Стоимость в рублях; null, если RouterAI её не сообщил. */
  cost: number | null
  /** Пути сохранённых файлов. */
  files: string[]
  /** Те же картинки как вложения чата (кроме векторных — их чат не показывает). */
  shown: ImageAttachmentRef[]
  /** Что пришлось изменить в запросе под возможности модели. */
  notes: string[]
}

function summary(drawn: Drawn): string {
  const count = Math.max(drawn.files.length, drawn.shown.length)
  const parts = [`Готово: ${count === 1 ? 'картинка' : `картинок: ${count}`}, модель ${drawn.model}`]
  if (drawn.cost !== null) parts.push(`стоимость ${rub(drawn.cost)}`)
  if (drawn.files.length > 0) parts.push(`файлы: ${drawn.files.join(', ')}`)
  return [`${parts.join('; ')}.`, ...drawn.notes.map(note => `Обратите внимание: ${note}.`)].join('\n')
}

const pictures = (shown: readonly ImageAttachmentRef[]): ContentBlock[] => shown.map(attachment => ({ type: 'image', attachment }))

/** Описание инструмента под выбранную модель: агент видит, что она умеет, и не просит невозможного. */
function describeTool(card: ModelCard | undefined): { tool: string; aspect: string; count: string } {
  const most = card?.media?.maxCount ?? DEFAULT_MOST
  return {
    tool: 'Нарисовать картинку по текстовому описанию (иллюстрация, логотип, макет, схема). '
      + `Картинка появится в чате и сохранится в папку ${MEDIA_FOLDER} рабочего каталога. Вызов платный — используй, когда пользователь просит изображение.`
      + (card === undefined ? '' : ` Сейчас выбрана модель ${card.slug}.`),
    aspect: `Соотношение сторон. По умолчанию выбирает модель.${allowedHint(card?.media?.aspectRatios)}`,
    count: most === 1 ? 'Модель рисует одну картинку за вызов; для нескольких вариантов вызови инструмент несколько раз.' : `Сколько вариантов нарисовать, от 1 до ${most}. По умолчанию 1.`,
  }
}

function buildDrawTool(ctx: Context, deps: DrawDeps): ToolDefinition {
  const selected = deps.imageModel()
  const text = describeTool(selected === null ? undefined : deps.findModel(selected))
  return defineTool({
    name: DRAW_TOOL,
    description: text.tool,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Подробное описание картинки: что изображено, стиль, цвета, композиция. Надписи на картинке указывай дословно.' },
      aspect_ratio: { type: 'string', description: text.aspect },
      count: { type: 'integer', description: text.count },
      file_name: { type: 'string', description: 'Имя файла без расширения, латиницей. По умолчанию составляется из описания.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          cost: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          files: { type: 'array', items: { type: 'string' }, required: true },
          shown: { type: 'array', items: { type: 'json' }, required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      // Модель получает сводку и сами картинки: зрячая модель сможет оценить результат.
      render: (_args, value) => {
        const drawn = value as unknown as Drawn
        return [{ type: 'text', text: summary(drawn) }, ...pictures(drawn.shown)]
      },
      // Сведения для карточки вызова в интерфейсе (см. client/DrawCard.tsx).
      presentationMeta: (_args, value) => {
        const drawn = value as unknown as Drawn
        return { model: drawn.model, cost: drawn.cost, files: drawn.files, notes: drawn.notes }
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'other', title: `Рисую: ${args.prompt.length > 80 ? `${args.prompt.slice(0, 79)}…` : args.prompt}` }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Картинка RouterAI', content: result.content.filter(block => block.type === 'image' || block.type === 'text') }),
    execute: async (args, run) => {
      const model = deps.imageModel()
      if (model === null) throw new Error('Рисование картинок выключено в Настройках → RouterAI.')
      const key = await deps.readKey()
      if (key === undefined) throw new Error('Нет ключа RouterAI. Войдите: Настройки → RouterAI или команда /routerai login.')

      // Запрос подгоняется под возможности модели из каталога; о заменах агент узнает из результата.
      const traits = deps.findModel(model)?.media
      const count = fitCount(args.count, traits?.maxCount ?? DEFAULT_MOST)
      const aspect = fitAspectRatio(args.aspect_ratio, traits?.aspectRatios)
      const notes = [count.note, aspect.note].filter((note): note is string => note !== undefined)

      const result = await drawPictures(deps.apiBase, key, {
        model, prompt: args.prompt, count: count.value ?? 1,
        ...aspect.value === undefined ? {} : { aspectRatio: aspect.value },
      }, run.signal)

      const stem = fileStem(args.file_name, args.prompt)
      const names = result.pictures.map((picture, index) => `${stem}${result.pictures.length > 1 ? `-${index + 1}` : ''}.${EXTENSIONS[picture.type]}`)

      const files: string[] = []
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory !== undefined && run.agent !== undefined) {
        const folder = join(await workingDirectory.ensure(run.agent, run.signal), MEDIA_FOLDER)
        await mkdir(folder, { recursive: true })
        for (const [index, picture] of result.pictures.entries()) {
          const path = join(folder, names[index]!)
          await writeFile(path, picture.bytes)
          files.push(path)
        }
      }

      const shown: ImageAttachmentRef[] = []
      const attachments = deps.attachments()
      if (attachments !== undefined) {
        for (const [index, picture] of result.pictures.entries()) {
          if (!SHOWN_IN_CHAT.includes(picture.type)) continue
          shown.push(await attachments.saveImage({ data: picture.bytes, mediaType: picture.type as ImageMediaType, name: names[index]! }))
        }
      }
      if (result.pictures.some(picture => picture.type === 'image/svg+xml')) {
        notes.push(files.length > 0 ? 'векторная картинка (SVG) сохранена в файл; в чате она не отображается' : 'векторную картинку (SVG) негде сохранить: у сессии нет рабочего каталога')
      }

      if (result.cost !== undefined && run.agent !== undefined) deps.charged(String(run.agent.id), model, result.cost)
      const drawn: Drawn = { model, cost: result.cost ?? null, files, shown, notes }
      return drawn as never
    },
  })
}

export function registerDrawTool(ctx: Context, deps: DrawDeps): void {
  registerLiveTool(ctx, {
    label: 'routerai: draw tool',
    build: () => buildDrawTool(ctx, deps),
    // Инструмент виден агенту, только пока рисование включено в настройках.
    enabled: () => deps.imageModel() !== null,
    signature: () => {
      const model = deps.imageModel()
      return JSON.stringify([model, model === null ? null : deps.findModel(model)?.media ?? null])
    },
    watch: deps.watch,
  })
}
