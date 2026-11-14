// Инструмент агента «снять видео». Ролик делается несколько минут и стоит заметно дороже картинки,
// поэтому инструмент выключен, пока пользователь не выберет модель, и не снимает ролики дороже заданного потолка.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ModelCard } from './catalog.ts'
import { fileStem, readPicture } from './files.ts'
import { fitAspectRatio, fitDuration, fitResolution, resolutionHeight } from './fit.ts'
import { MEDIA_FOLDER, VIDEO_TOOL } from './links.ts'
import { makeFilm } from './media.ts'
import { rub } from './money.ts'
import { estimateFilm, priceTable } from './video-cost.ts'
import { allowedHint, buildMenu, pickModel, registerLiveTool } from './toolkit.ts'
import type { ModelMenu } from './toolkit.ts'
import { isVideoModel } from './catalog.ts'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export interface FilmDeps {
  apiBase: string
  readKey(): Promise<string | undefined>
  /** Модель для видео из настроек; null — видео выключено. */
  videoModel(): string | null
  /** Модели, из которых агент может выбирать сверх основной. */
  videoChoices(): readonly string[]
  /** Потолок стоимости одного ролика, ₽. */
  videoBudget(): number
  findModel(slug: string): ModelCard | undefined
  charged(sessionId: string, model: string, rub: number): void
  /** Пауза между проверками статуса; меняется только в тестах. */
  pollMs?: number
  /** Подписка на смену настроек и каталога. */
  watch(listener: () => void): () => void
}

interface Filmed {
  model: string
  cost: number | null
  file: string
  seconds: number | null
  /** Что пришлось изменить в запросе под возможности модели. */
  notes: string[]
}

const SOURCE_LIMIT = 30 * 1024 * 1024

/**
 * Размер кадра MP4 из заголовка видеодорожки (атом tkhd): нужен, чтобы оценить стоимость апскейла,
 * который тарифицируется по мегапикселям результата. undefined, если размер не найти.
 */
export function clipFrame(bytes: Uint8Array): { width: number; height: number } | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = data.indexOf('tkhd', 0, 'latin1'); at !== -1; at = data.indexOf('tkhd', at + 4, 'latin1')) {
    // Ширина и высота — последние восемь байт заголовка дорожки, числа с фиксированной точкой 16.16.
    const sizeAt = at + (data[at + 4] === 1 ? 92 : 80)
    if (sizeAt + 8 > data.length) continue
    const width = data.readUInt32BE(sizeAt) / 65_536
    const height = data.readUInt32BE(sizeAt + 4) / 65_536
    // У звуковой дорожки размер нулевой — ищем дальше.
    if (width >= 16 && height >= 16 && width <= 16_384 && height <= 16_384) return { width, height }
  }
  return undefined
}

/**
 * Длительность ролика MP4 в секундах из его заголовка (атом mvhd); undefined, если её не найти.
 * Нужна для оценки стоимости обработки готового видео: модели-обработчики берут плату за секунды исходника.
 */
export function clipSeconds(bytes: Uint8Array): number | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = data.indexOf('mvhd', 0, 'latin1')
  if (at === -1 || at + 5 > data.length) return undefined
  // После метки: версия и флаги, время создания и изменения (по 4 или 8 байт), шкала времени, длительность.
  const wide = data[at + 4] === 1
  const scaleAt = at + 8 + (wide ? 16 : 8)
  if (scaleAt + (wide ? 12 : 8) > data.length) return undefined
  const scale = data.readUInt32BE(scaleAt)
  const duration = wide ? Number(data.readBigUInt64BE(scaleAt + 4)) : data.readUInt32BE(scaleAt + 4)
  return scale > 0 && duration > 0 ? duration / scale : undefined
}

/** Прочитать готовый ролик из проекта: data-URI и длительность. Как и картинки — только из рабочего каталога. */
export async function readClip(workspace: string, path: string): Promise<{ url: string; seconds?: number; width?: number; height?: number }> {
  const root = await realpath(workspace)
  const target = await realpath(isAbsolute(path) ? path : resolve(root, path)).catch(() => {
    throw new Error(`Исходное видео: файл не найден — ${path}`)
  })
  const inside = relative(root, target)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Исходное видео: файл должен лежать внутри рабочего каталога проекта — ${path}`)
  if ((await stat(target)).size > SOURCE_LIMIT) throw new Error(`Исходное видео: файл больше 30 МБ — ${path}`)
  const bytes = await readFile(target)
  // У файлов mp4 и mov в байтах 4–7 стоит метка ftyp; у webm файл начинается с 1A 45 DF A3.
  const type = bytes.subarray(4, 8).toString('latin1') === 'ftyp' ? 'video/mp4' : bytes.readUInt32BE(0) === 0x1a45dfa3 ? 'video/webm' : undefined
  if (type === undefined) throw new Error(`Исходное видео: нужен файл MP4 или WebM — ${path}`)
  const seconds = clipSeconds(bytes)
  return { url: `data:${type};base64,${bytes.toString('base64')}`, ...seconds === undefined ? {} : { seconds }, ...clipFrame(bytes) }
}

/** Кратность апскейла по умолчанию: вдвое, если модель это позволяет. */
function defaultFactor(range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, 2))
}

/** Разрешение, которое уйдёт в запросе, если агент его не назвал: 720p или ближайшее к нему из доступных. */
function defaultResolution(resolutions: readonly string[] | undefined): string | undefined {
  return resolutions === undefined || resolutions.length === 0 ? undefined : fitResolution('720p', resolutions).value
}

function menuLine(card: ModelCard): string {
  const traits = card.media
  const facts = [
    card.perSecond !== undefined ? `от ${rub(card.perSecond)} за секунду`
      : card.videoPricing?.some(row => row.unit === 'megapixel_second') === true ? 'оплата по размеру кадра и длительности'
        : card.videoPricing === undefined ? 'цена в каталоге не указана — использовать нельзя' : '',
    card.durations === undefined ? '' : `${card.durations[0]}–${card.durations.at(-1)} с`,
    traits?.frames?.includes('last_frame') === true ? 'первый и последний кадр' : traits?.frames?.includes('first_frame') === true ? 'первый кадр' : '',
    (traits?.references ?? 0) > 0 ? 'референсы' : '',
    traits?.audio === true ? 'звук' : '',
    traits?.needsSource === true ? 'только обработка готового видео' : traits?.takesVideo === true ? 'принимает готовое видео' : '',
  ].filter(fact => fact !== '')
  return `"${card.slug}" — ${card.title}: ${facts.join(', ')}`
}

function menuOf(deps: FilmDeps): ModelMenu<ModelCard> | undefined {
  const main = deps.videoModel()
  return main === null ? undefined : buildMenu(main, deps.videoChoices(), deps.findModel, isVideoModel)
}

function buildFilmTool(ctx: Context, deps: FilmDeps): ToolDefinition {
  const menu = menuOf(deps)
  const selected = deps.videoModel()
  const card = selected === null ? undefined : deps.findModel(selected)
  const traits = card?.media
  const takesFrame = traits?.frames === undefined || traits.frames.includes('first_frame')
  const takesLast = traits?.frames === undefined || traits.frames.includes('last_frame')
  const takes = traits?.references
  const refuse = 'Выбранная модель этого не поддерживает — не указывай параметр.'
  return defineTool({
    name: VIDEO_TOOL,
    description: 'Снять короткое видео по текстовому описанию' + (takesFrame ? ', при желании — оживить картинку (первый кадр). ' : '. ')
      + `Работа занимает несколько минут; ролик сохраняется в папку ${MEDIA_FOLDER} рабочего каталога. `
      + 'Вызов платный и заметно дороже картинки — используй, только когда пользователь прямо просит видео.'
      + (card === undefined ? '' : ` Сейчас выбрана модель ${card.slug}${card.perSecond === undefined ? '' : `, от ${rub(card.perSecond)} за секунду`}.`)
      + (card === undefined || priceTable(card, rub) === '' ? '' : ` Цена секунды: ${priceTable(card, rub)}.`),
    parameters: {
      prompt: { type: 'string', required: true, description: 'Что происходит в кадре: сцена, движение, камера, стиль.' },
      duration: { type: 'integer', description: `Длительность в секундах; если модель такую не поддерживает, будет взята ближайшая.${allowedHint(card?.durations, ' с')}` },
      aspect_ratio: { type: 'string', description: `Соотношение сторон.${allowedHint(traits?.aspectRatios)}` },
      // Число, а не строка вида «480p»: такие значения слабые модели пишут без кавычек, и вызов становится некорректным JSON.
      resolution: { type: 'integer', description: `Высота кадра в пикселях; чем больше, тем дороже.${defaultResolution(traits?.resolutions) === undefined ? '' : ` По умолчанию ${resolutionHeight(defaultResolution(traits?.resolutions)!)}.`}${allowedHint(traits?.resolutions?.map(resolutionHeight).filter((height): height is number => height !== undefined))}` },
      first_frame: { type: 'string', description: takesFrame ? 'Путь к картинке в рабочем каталоге, которая станет первым кадром (image-to-video).' : 'Выбранная модель не принимает первый кадр — не указывай этот параметр.' },
      last_frame: { type: 'string', description: takesLast ? 'Путь к картинке, которой ролик должен закончиться: вместе с first_frame получится плавный переход между двумя картинками.' : refuse },
      references: { type: 'array', items: { type: 'string' }, description: takes === 0 ? refuse
        : `Пути к картинкам-референсам: персонаж, предмет или стиль, которые должны быть в ролике.${takes === undefined ? '' : ` Не больше ${takes}.`}${traits?.referencesExcludeFrames === true ? ' Нельзя совмещать с first_frame и last_frame.' : ''}` },
      audio: { type: 'boolean', description: traits?.audio === true ? 'Нужна ли звуковая дорожка. По умолчанию решает модель.' : refuse },
      source_video: { type: 'string', description: traits?.takesVideo === true
        ? `Путь к готовому ролику (MP4, WebM) в рабочем каталоге: чтобы продлить его, изменить или улучшить качество. В описании скажи, что с ним сделать. С исходным видео не указывай aspect_ratio и resolution — они берутся из ролика.${traits.needsSource === true ? ' Для этой модели параметр обязателен.' : ''}`
        : refuse },
      seed: { type: 'integer', description: traits?.seed === true ? 'Зерно (целое число): с тем же зерном и описанием модель повторит результат.' : refuse },
      upscale_factor: { type: 'number', description: traits?.upscale === undefined ? refuse
        : `Во сколько раз увеличить кадр исходного видео, от ${traits.upscale.min} до ${traits.upscale.max}. По умолчанию ${defaultFactor(traits.upscale)}. Цена растёт как квадрат кратности.` },
      creative: { type: 'boolean', description: traits?.upscale === undefined ? refuse
        : 'Креативный режим апскейла: модель дорисовывает детали, стоит дороже. По умолчанию выключен — точное увеличение без изменений в кадре.' },
      ...menu === undefined || menu.allowed.length < 2 ? {} : { model: { type: 'string' as const, enum: menu.allowed, description:
        `Какой моделью снимать. По умолчанию "${menu.main}". Выбирай другую, только если задаче нужны её возможности или цена. Допустимые параметры выше указаны для модели по умолчанию.\n${menu.allowed.map(slug => menuLine(menu.cards.get(slug)!)).join('\n')}` } },
      file_name: { type: 'string', description: 'Имя файла без расширения, латиницей.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          cost: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          file: { type: 'string', required: true },
          seconds: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          notes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => {
        const filmed = value as unknown as Filmed
        const parts = [`Видео готово: ${filmed.file}`, `модель ${filmed.model}`]
        if (filmed.seconds !== null) parts.push(`длительность ${filmed.seconds} с`)
        if (filmed.cost !== null) parts.push(`стоимость ${rub(filmed.cost)}`)
        return [{ type: 'text', text: [`${parts.join('; ')}.`, ...filmed.notes.map(note => `Обратите внимание: ${note}.`)].join('\n') }]
      },
      presentationMeta: (_args, value) => {
        const filmed = value as unknown as Filmed
        return { model: filmed.model, cost: filmed.cost, files: [filmed.file], notes: filmed.notes }
      },
    },
    // Запас над временем ожидания задачи: ещё нужно скачать файл.
    timeoutMs: 30 * 60_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'other', title: `Снимаю видео: ${args.prompt.length > 80 ? `${args.prompt.slice(0, 79)}…` : args.prompt}` }),
    execute: async (args, run) => {
      const current = menuOf(deps)
      if (current === undefined) throw new Error('Видео выключено в Настройках → RouterAI.')
      const picked = pickModel(current, (args as { model?: string }).model)
      const model = picked.model
      const key = await deps.readKey()
      if (key === undefined) throw new Error('Нет ключа RouterAI. Войдите: Настройки → RouterAI или команда /routerai login.')
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined || run.agent === undefined) throw new Error('Некуда сохранить видео: у сессии нет рабочего каталога.')
      const workspace = await workingDirectory.ensure(run.agent, run.signal)

      // Всё, что можно проверить по каталогу, проверяется до платного запроса.
      const chosen = deps.findModel(model)
      const abilities = chosen?.media
      if (args.source_video !== undefined && abilities !== undefined && abilities.takesVideo !== true) {
        throw new Error(`Модель ${model} не принимает готовое видео. Выберите модель с такой возможностью в Настройках → RouterAI.`)
      }
      if (abilities?.needsSource === true && args.source_video === undefined) {
        throw new Error(`Модель ${model} работает только с готовым видео: укажите source_video — путь к ролику в проекте — или выберите другую модель.`)
      }
      if (args.first_frame !== undefined && abilities?.frames !== undefined && !abilities.frames.includes('first_frame')) {
        throw new Error(`Модель ${model} не принимает первый кадр. Снимите ролик только по описанию или выберите другую модель в Настройках → RouterAI.`)
      }
      if (args.last_frame !== undefined && abilities?.frames !== undefined && !abilities.frames.includes('last_frame')) {
        throw new Error(`Модель ${model} не принимает последний кадр. Уберите его или выберите другую модель в Настройках → RouterAI.`)
      }
      const wanted = (args.references ?? []).filter(path => path.trim() !== '')
      if (wanted.length > 0 && abilities?.references === 0) throw new Error(`Модель ${model} не принимает картинки-референсы. Используйте первый кадр или выберите другую модель в Настройках → RouterAI.`)
      if (wanted.length > 0 && abilities?.referencesExcludeFrames === true && (args.first_frame !== undefined || args.last_frame !== undefined)) {
        throw new Error(`Модель ${model} не совмещает референсы с опорными кадрами: оставьте либо references, либо first_frame и last_frame.`)
      }
      const duration = fitDuration(args.duration, chosen?.durations)
      const aspect = fitAspectRatio(args.aspect_ratio, abilities?.aspectRatios)
      // Разрешение уходит в запросе всегда, когда модель их перечисляет: иначе она выберет сама,
      // и цена секунды окажется непредсказуемой. С готовым видео разрешение берётся из исходника.
      const resolution = args.resolution !== undefined ? fitResolution(`${args.resolution}p`, abilities?.resolutions)
        : args.source_video === undefined ? { value: defaultResolution(abilities?.resolutions) } : { value: undefined }
      const seed = args.seed === undefined || abilities?.seed === true ? args.seed : undefined
      const notes = [picked.note, duration.note, aspect.note, resolution.note,
        args.seed !== undefined && seed === undefined ? 'Модель не поддерживает зерно — результат не будет воспроизводимым' : undefined,
      ].filter((note): note is string => note !== undefined)
      const mostReferences = abilities?.references ?? wanted.length
      if (wanted.length > mostReferences) notes.push(`Модель принимает не больше ${mostReferences} референсов — взяты первые ${mostReferences} из ${wanted.length}`)
      if (args.audio === true && abilities?.audio !== true) notes.push('Модель не делает звуковую дорожку — ролик без звука')
      const seconds = duration.value

      const source = args.source_video === undefined ? undefined : await readClip(workspace, args.source_video)

      // Апскейл: кратность и режим уходят в запросе явно — от них зависит цена, и модель не должна выбирать их сама.
      const upscale = abilities?.upscale === undefined ? undefined : {
        factor: Math.min(abilities.upscale.max, Math.max(abilities.upscale.min, args.upscale_factor ?? defaultFactor(abilities.upscale))),
        creative: args.creative === true,
      }

      // Оценка до запуска — по сетке цен каталога: разрешение, звук, входные картинки и видео, размер кадра у апскейла.
      // Дороже потолка — не снимаем. Если каталог не даёт посчитать стоимость, потолок не сработал бы — такой запрос не отправляется.
      const audio = args.audio === undefined || abilities?.audio === true ? args.audio : undefined
      const estimate = chosen === undefined ? undefined : estimateFilm(chosen, {
        ...seconds === undefined ? {} : { seconds },
        ...resolution.value === undefined ? {} : { resolution: resolution.value },
        ...aspect.value === undefined ? {} : { aspectRatio: aspect.value },
        ...audio === undefined ? {} : { audio },
        frames: (args.first_frame === undefined ? 0 : 1) + (args.last_frame === undefined ? 0 : 1),
        references: Math.min(wanted.length, abilities?.references ?? wanted.length),
        ...source === undefined ? {} : { source },
        ...upscale === undefined ? {} : { upscale },
      })
      if (chosen !== undefined && estimate === undefined) {
        throw new Error(source !== undefined && (source.seconds === undefined || source.width === undefined)
          ? 'Не удалось определить длительность и размер кадра исходного видео, поэтому нельзя оценить стоимость. Используйте ролик в формате MP4.'
          : `Стоимость ролика у модели ${model} по каталогу RouterAI оценить нельзя — потолок из настроек не удалось бы соблюсти. Выберите другую модель в Настройках → RouterAI.`)
      }
      if (estimate !== undefined && estimate.rub > deps.videoBudget()) {
        throw new Error(`Ролик (${estimate.basis}) обойдётся примерно в ${rub(estimate.rub)} — это больше потолка ${rub(deps.videoBudget())} из Настроек → RouterAI. Сократите длительность, снизьте разрешение или поднимите потолок.`)
      }

      const film = await makeFilm(deps.apiBase, key, {
        model, prompt: args.prompt,
        ...seconds === undefined ? {} : { seconds },
        ...aspect.value === undefined ? {} : { aspectRatio: aspect.value },
        ...resolution.value === undefined ? {} : { resolution: resolution.value },
        ...args.first_frame === undefined ? {} : { firstFrame: await readPicture(workspace, args.first_frame, 'Первый кадр') },
        ...args.last_frame === undefined ? {} : { lastFrame: await readPicture(workspace, args.last_frame, 'Последний кадр') },
        ...wanted.length === 0 ? {} : { references: await Promise.all(wanted.slice(0, mostReferences).map(path => readPicture(workspace, path, 'Референс'))) },
        ...audio === undefined ? {} : { audio },
        ...seed === undefined ? {} : { seed },
        ...source === undefined ? {} : { sourceVideo: source.url },
        ...upscale === undefined ? {} : { upscaleFactor: upscale.factor, creativity: upscale.creative ? 1 as const : 0 as const },
      }, run.signal, deps.pollMs === undefined ? {} : { pollMs: deps.pollMs })

      const folder = join(workspace, MEDIA_FOLDER)
      await mkdir(folder, { recursive: true })
      const file = join(folder, `${fileStem(args.file_name, args.prompt)}.mp4`)
      await writeFile(file, film.bytes)
      if (film.cost !== undefined) deps.charged(String(run.agent.id), model, film.cost)
      const filmed: Filmed = { model, cost: film.cost ?? null, file, seconds: seconds ?? null, notes }
      return filmed as never
    },
  })
}

/** Прежнее имя чтения первого кадра — оставлено для тестов. */
export const readFrame = (workspace: string, path: string) => readPicture(workspace, path, 'Первый кадр')

export function registerFilmTool(ctx: Context, deps: FilmDeps): void {
  registerLiveTool(ctx, {
    label: 'routerai: video tool',
    build: () => buildFilmTool(ctx, deps),
    enabled: () => deps.videoModel() !== null,
    signature: () => {
      const menu = menuOf(deps)
      return JSON.stringify(menu === undefined ? null : menu.allowed.map((slug) => {
        const card = menu.cards.get(slug)
        return [slug, card?.media ?? null, card?.durations ?? null, card?.perSecond ?? null]
      }))
    },
    watch: deps.watch,
  })
}
