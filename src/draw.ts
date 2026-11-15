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
import { fileStem, readPicture } from './files.ts'
import { fitAspectRatio, fitCount, fitImageSize, fitOption, imageSizePixels } from './fit.ts'
import { DRAW_TOOL, MEDIA_FOLDER } from './links.ts'
import { drawPictures } from './media.ts'
import type { Picture } from './media.ts'
import { rub } from './money.ts'
import { allowedHint, buildMenu, pickModel, registerLiveTool } from './toolkit.ts'
import type { ModelMenu } from './toolkit.ts'
import { isImageModel } from './catalog.ts'

export { DRAW_TOOL, fileStem, MEDIA_FOLDER }
/** Предел числа картинок за вызов, если модель своего не сообщает. */
const DEFAULT_MOST = 4

export interface DrawDeps {
  apiBase: string
  readKey(): Promise<string | undefined>
  /** Модель для картинок из настроек; null — рисование выключено. */
  imageModel(): string | null
  /** Модели, из которых агент может выбирать сверх основной. */
  imageChoices(): readonly string[]
  findModel(slug: string): ModelCard | undefined
  attachments(): Context['attachments'] | undefined
  /** Картинка оплачена: учесть её в стоимости сессии. */
  charged(sessionId: string, model: string, rub: number): void
  /** Подписка на смену настроек и каталога. */
  watch(listener: () => void): () => void
}

const EXTENSIONS: Record<Picture['type'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }
const SHOWN_IN_CHAT: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] satisfies ImageMediaType[]

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

/** Размер по умолчанию — наименьший «полноценный»: цена в каталоге указана за него, крупнее стоит дороже. */
function defaultSize(sizes: readonly string[] | undefined): string | undefined {
  return sizes?.find(size => size.toLowerCase() === '1k')
}

const pictures = (shown: readonly ImageAttachmentRef[]): ContentBlock[] => shown.map(attachment => ({ type: 'image', attachment }))

/** Описание инструмента под выбранную модель: агент видит, что она умеет, и не просит невозможного. */
/** Одна строка о модели для меню: за что платим и чем она отличается. */
function menuLine(card: ModelCard): string {
  const traits = card.media
  const facts = [
    card.perImage !== undefined ? `от ${rub(card.perImage)} за картинку` : traits?.billedBy === 'token' ? 'оплата по токенам' : '',
    traits?.formats?.includes('svg') === true ? 'векторная графика (SVG)' : '',
    traits?.backgrounds?.includes('transparent') === true ? 'прозрачный фон' : '',
    (traits?.references ?? 1) > 0 ? 'правка исходных картинок' : 'без исходных картинок',
    traits?.qualities !== undefined ? 'настройка качества' : '',
  ].filter(fact => fact !== '')
  return `"${card.slug}" — ${card.title}: ${facts.join(', ')}`
}

function describeTool(card: ModelCard | undefined, menu: ModelMenu<ModelCard> | undefined) {
  const traits = card?.media
  const most = traits?.maxCount ?? DEFAULT_MOST
  const takes = traits?.references
  const unsupported = 'Выбранная модель этот параметр не поддерживает — не указывай его.'
  return {
    // Число, а не обозначение вида «2K»: такие значения слабые модели пишут без кавычек и портят JSON вызова.
    size: traits?.sizes === undefined ? unsupported
      : `Длинная сторона картинки в пикселях; больше — дороже. По умолчанию ${defaultSize(traits.sizes) === undefined ? 'выбирает модель' : 1024}.${allowedHint(traits.sizes.map(imageSizePixels).filter((pixels): pixels is number => pixels !== undefined))}`,
    quality: traits?.qualities === undefined ? unsupported : `Качество; выше — дороже.${allowedHint(traits.qualities)}`,
    background: traits?.backgrounds === undefined ? unsupported : `Фон; transparent — прозрачный (для логотипов и значков, нужен формат png или webp).${allowedHint(traits.backgrounds)}`,
    format: traits?.formats === undefined ? unsupported : `Формат файла.${allowedHint(traits.formats)}`,
    seed: traits?.seed === true ? 'Зерно (целое число): с тем же зерном и описанием модель повторит результат. Укажи, когда нужно воспроизвести или слегка изменить прошлую картинку.' : unsupported,
    model: menu === undefined || menu.allowed.length < 2 ? ''
      : `Какой моделью рисовать. По умолчанию "${menu.main}". Выбирай другую, только если задаче нужны её возможности. Допустимые параметры ниже указаны для модели по умолчанию; у других моделей они могут отличаться.\n${menu.allowed.map(slug => menuLine(menu.cards.get(slug)!)).join('\n')}`,
    references: takes === 0 ? 'Выбранная модель не принимает исходные картинки — не указывай этот параметр.'
      : `Пути к картинкам в рабочем каталоге, на основе которых нужно рисовать: чтобы изменить существующую картинку, перенести стиль или сохранить персонажа. В описании скажи, что с ними сделать.${takes === undefined ? '' : ` Не больше ${takes}.`}`,
    tool: 'Нарисовать картинку по текстовому описанию (иллюстрация, логотип, макет, схема)'
      + (takes === 0 ? '. ' : ' или изменить существующую картинку из проекта. ')
      + `Картинка появится в чате и сохранится в папку ${MEDIA_FOLDER} рабочего каталога. Вызов платный — используй, когда пользователь просит изображение.`
      + (card === undefined ? '' : ` Сейчас выбрана модель ${card.slug}.`),
    aspect: `Соотношение сторон. По умолчанию выбирает модель.${allowedHint(card?.media?.aspectRatios)}`,
    count: most === 1 ? 'Модель рисует одну картинку за вызов; для нескольких вариантов вызови инструмент несколько раз.' : `Сколько вариантов нарисовать, от 1 до ${most}. По умолчанию 1.`,
  }
}

function menuOf(deps: DrawDeps): ModelMenu<ModelCard> | undefined {
  const main = deps.imageModel()
  return main === null ? undefined : buildMenu(main, deps.imageChoices(), deps.findModel, isImageModel)
}

function buildDrawTool(ctx: Context, deps: DrawDeps): ToolDefinition {
  const selected = deps.imageModel()
  const menu = menuOf(deps)
  const text = describeTool(selected === null ? undefined : deps.findModel(selected), menu)
  return defineTool({
    name: DRAW_TOOL,
    description: text.tool,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Подробное описание картинки: что изображено, стиль, цвета, композиция. Надписи на картинке указывай дословно.' },
      aspect_ratio: { type: 'string', description: text.aspect },
      count: { type: 'integer', description: text.count },
      size: { type: 'integer', description: text.size },
      quality: { type: 'string', description: text.quality },
      background: { type: 'string', description: text.background },
      format: { type: 'string', description: text.format },
      references: { type: 'array', items: { type: 'string' }, description: text.references },
      seed: { type: 'integer', description: text.seed },
      // Параметр выбора модели есть, только когда пользователь разрешил больше одной.
      ...text.model === '' ? {} : { model: { type: 'string' as const, enum: menu!.allowed, description: text.model } },
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
      const current = menuOf(deps)
      if (current === undefined) throw new Error('Рисование картинок выключено в Настройках → RouterAI.')
      const picked = pickModel(current, (args as { model?: string }).model)
      const model = picked.model
      const key = await deps.readKey()
      if (key === undefined) throw new Error('Нет ключа RouterAI. Войдите: Настройки → RouterAI или команда /routerai login.')

      // Запрос подгоняется под возможности модели из каталога; о заменах агент узнает из результата.
      const traits = deps.findModel(model)?.media
      const count = fitCount(args.count, traits?.maxCount ?? DEFAULT_MOST)
      const aspect = fitAspectRatio(args.aspect_ratio, traits?.aspectRatios)
      const size = args.size === undefined ? { value: defaultSize(traits?.sizes) } : fitImageSize(String(args.size), traits?.sizes)
      const quality = fitOption(args.quality, traits?.qualities, 'Качество')
      const background = fitOption(args.background, traits?.backgrounds, 'Фон')
      const format = fitOption(args.format, traits?.formats, 'Формат')
      const seed = args.seed === undefined || traits?.seed === true ? args.seed : undefined
      const notes = [picked.note, count.note, aspect.note, size.note, quality.note, background.note, format.note,
        args.seed !== undefined && seed === undefined ? 'Модель не поддерживает зерно — результат не будет воспроизводимым' : undefined,
      ].filter((note): note is string => note !== undefined)

      // Исходные картинки читаются из проекта до платного запроса: ошибка в пути не должна стоить денег.
      const wanted = (args.references ?? []).filter(path => path.trim() !== '')
      let references: string[] = []
      if (wanted.length > 0) {
        if (traits?.references === 0) throw new Error(`Модель ${model} не принимает исходные картинки. Опишите желаемое словами или выберите другую модель в Настройках → RouterAI.`)
        const most = traits?.references ?? wanted.length
        if (wanted.length > most) notes.push(`Модель принимает не больше ${most} исходных картинок — взяты первые ${most} из ${wanted.length}`)
        const workspace = ctx.get('workingDirectory')
        if (workspace === undefined || run.agent === undefined) throw new Error('Исходные картинки недоступны: у сессии нет рабочего каталога.')
        const root = await workspace.ensure(run.agent, run.signal)
        references = await Promise.all(wanted.slice(0, most).map(path => readPicture(root, path, 'Исходная картинка')))
      }

      const result = await drawPictures(deps.apiBase, key, {
        model, prompt: args.prompt, count: count.value ?? 1,
        ...aspect.value === undefined ? {} : { aspectRatio: aspect.value },
        ...size.value === undefined ? {} : { size: size.value },
        ...quality.value === undefined ? {} : { quality: quality.value },
        ...background.value === undefined ? {} : { background: background.value },
        ...format.value === undefined ? {} : { format: format.value },
        ...references.length === 0 ? {} : { references },
        ...seed === undefined ? {} : { seed },
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
      const menu = menuOf(deps)
      return JSON.stringify(menu === undefined ? null : menu.allowed.map(slug => [slug, menu.cards.get(slug)?.media ?? null, menu.cards.get(slug)?.perImage ?? null]))
    },
    watch: deps.watch,
  })
}
