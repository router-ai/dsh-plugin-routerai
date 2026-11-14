// Инструмент агента «нарисовать картинку». Картинка показывается в чате и сохраняется
// в папку routerai-media рабочего каталога, чтобы ею можно было пользоваться дальше.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { DRAW_TOOL, MEDIA_FOLDER } from './links.ts'
import { drawPictures } from './media.ts'
import type { Picture } from './media.ts'
import { rub } from './money.ts'

export { DRAW_TOOL, MEDIA_FOLDER }
const MOST_PICTURES = 4

export interface DrawDeps {
  apiBase: string
  readKey(): Promise<string | undefined>
  /** Модель для картинок из настроек; null — рисование выключено. */
  imageModel(): string | null
  attachments(): Context['attachments'] | undefined
  /** Картинка оплачена: учесть её в стоимости сессии. */
  charged(sessionId: string, model: string, rub: number): void
}

const EXTENSIONS: Record<Picture['type'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

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
  /** Те же картинки как вложения чата. */
  shown: ImageAttachmentRef[]
}

function summary(drawn: Drawn): string {
  const count = Math.max(drawn.files.length, drawn.shown.length)
  const parts = [`Готово: ${count === 1 ? 'картинка' : `картинок: ${count}`}, модель ${drawn.model}`]
  if (drawn.cost !== null) parts.push(`стоимость ${rub(drawn.cost)}`)
  if (drawn.files.length > 0) parts.push(`файлы: ${drawn.files.join(', ')}`)
  return `${parts.join('; ')}.`
}

const pictures = (shown: readonly ImageAttachmentRef[]): ContentBlock[] => shown.map(attachment => ({ type: 'image', attachment }))

export function registerDrawTool(ctx: Context, deps: DrawDeps): void {
  const tool = defineTool({
    name: DRAW_TOOL,
    description: 'Нарисовать картинку по текстовому описанию (иллюстрация, логотип, макет, схема). '
      + `Картинка появится в чате и сохранится в папку ${MEDIA_FOLDER} рабочего каталога. Вызов платный — используй, когда пользователь просит изображение.`,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Подробное описание картинки: что изображено, стиль, цвета, композиция. Надписи на картинке указывай дословно.' },
      aspect_ratio: { type: 'string', description: 'Соотношение сторон, например 1:1, 16:9, 9:16, 4:3. По умолчанию выбирает модель.' },
      count: { type: 'integer', description: `Сколько вариантов нарисовать, от 1 до ${MOST_PICTURES}. По умолчанию 1.` },
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
        return { model: drawn.model, cost: drawn.cost, files: drawn.files }
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

      const count = Math.min(MOST_PICTURES, Math.max(1, args.count ?? 1))
      const result = await drawPictures(deps.apiBase, key, {
        model, prompt: args.prompt, count,
        ...args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio },
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
          shown.push(await attachments.saveImage({ data: picture.bytes, mediaType: picture.type, name: names[index]! }))
        }
      }

      if (result.cost !== undefined && run.agent !== undefined) deps.charged(String(run.agent.id), model, result.cost)
      const drawn: Drawn = { model, cost: result.cost ?? null, files, shown }
      return drawn as never
    },
  })

  // Инструмент виден агенту, только пока рисование включено в настройках.
  ctx.effect(() => ctx.tools.register(tool, { when: () => deps.imageModel() !== null }), 'routerai: draw tool')
}
