// Инструмент агента «снять видео». Ролик делается несколько минут и стоит заметно дороже картинки,
// поэтому инструмент выключен, пока пользователь не выберет модель, и не снимает ролики дороже заданного потолка.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ModelCard } from './catalog.ts'
import { fileStem } from './draw.ts'
import { fitAspectRatio, fitDuration, fitResolution } from './fit.ts'
import { MEDIA_FOLDER, VIDEO_TOOL } from './links.ts'
import { makeFilm, sniffPictureType } from './media.ts'
import { rub } from './money.ts'
import { allowedHint, registerLiveTool } from './toolkit.ts'

export interface FilmDeps {
  apiBase: string
  readKey(): Promise<string | undefined>
  /** Модель для видео из настроек; null — видео выключено. */
  videoModel(): string | null
  /** Потолок стоимости одного ролика, ₽. */
  videoBudget(): number
  findModel(slug: string): ModelCard | undefined
  charged(sessionId: string, model: string, rub: number): void
  /** Пауза между проверками статуса; меняется только в тестах. */
  pollMs?: number
  /** Подписка на смену настроек и каталога. */
  watch(listener: () => void): () => void
}

const FRAME_LIMIT = 10 * 1024 * 1024

/** Прочитать первый кадр из файла проекта. Файлы вне рабочего каталога в RouterAI не уходят. */
export async function readFrame(workspace: string, path: string): Promise<string> {
  const root = await realpath(workspace)
  const target = await realpath(isAbsolute(path) ? path : resolve(root, path)).catch(() => {
    throw new Error(`Файл первого кадра не найден: ${path}`)
  })
  const inside = relative(root, target)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Первый кадр должен лежать внутри рабочего каталога проекта.')
  const bytes = await readFile(target)
  if (bytes.byteLength > FRAME_LIMIT) throw new Error('Файл первого кадра больше 10 МБ.')
  const type = sniffPictureType(bytes)
  if (type === undefined) throw new Error(`Первый кадр должен быть картинкой PNG, JPEG, WebP или GIF: ${path}${extname(path) === '' ? '' : ` (${extname(path)})`}`)
  return `data:${type};base64,${bytes.toString('base64')}`
}

interface Filmed {
  model: string
  cost: number | null
  file: string
  seconds: number | null
  /** Что пришлось изменить в запросе под возможности модели. */
  notes: string[]
}

function buildFilmTool(ctx: Context, deps: FilmDeps): ToolDefinition {
  const selected = deps.videoModel()
  const card = selected === null ? undefined : deps.findModel(selected)
  const traits = card?.media
  const takesFrame = traits?.frames === undefined || traits.frames.includes('first_frame')
  return defineTool({
    name: VIDEO_TOOL,
    description: 'Снять короткое видео по текстовому описанию' + (takesFrame ? ', при желании — оживить картинку (первый кадр). ' : '. ')
      + `Работа занимает несколько минут; ролик сохраняется в папку ${MEDIA_FOLDER} рабочего каталога. `
      + 'Вызов платный и заметно дороже картинки — используй, только когда пользователь прямо просит видео.'
      + (card === undefined ? '' : ` Сейчас выбрана модель ${card.slug}${card.perSecond === undefined ? '' : `, примерно ${rub(card.perSecond)} за секунду`}.`),
    parameters: {
      prompt: { type: 'string', required: true, description: 'Что происходит в кадре: сцена, движение, камера, стиль.' },
      duration: { type: 'integer', description: `Длительность в секундах; если модель такую не поддерживает, будет взята ближайшая.${allowedHint(card?.durations, ' с')}` },
      aspect_ratio: { type: 'string', description: `Соотношение сторон.${allowedHint(traits?.aspectRatios)}` },
      resolution: { type: 'string', description: `Разрешение; чем выше, тем дороже.${allowedHint(traits?.resolutions)}` },
      first_frame: { type: 'string', description: takesFrame ? 'Путь к картинке в рабочем каталоге, которая станет первым кадром (image-to-video).' : 'Выбранная модель не принимает первый кадр — не указывай этот параметр.' },
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
      const model = deps.videoModel()
      if (model === null) throw new Error('Видео выключено в Настройках → RouterAI.')
      const key = await deps.readKey()
      if (key === undefined) throw new Error('Нет ключа RouterAI. Войдите: Настройки → RouterAI или команда /routerai login.')
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined || run.agent === undefined) throw new Error('Некуда сохранить видео: у сессии нет рабочего каталога.')
      const workspace = await workingDirectory.ensure(run.agent, run.signal)

      // Всё, что можно проверить по каталогу, проверяется до платного запроса.
      const chosen = deps.findModel(model)
      const abilities = chosen?.media
      if (abilities?.needsSource === true) throw new Error(`Модель ${model} работает только с готовым видео или аудио и не снимает ролик по описанию. Выберите другую модель в Настройках → RouterAI.`)
      if (args.first_frame !== undefined && abilities?.frames !== undefined && !abilities.frames.includes('first_frame')) {
        throw new Error(`Модель ${model} не принимает первый кадр. Снимите ролик только по описанию или выберите другую модель в Настройках → RouterAI.`)
      }
      const duration = fitDuration(args.duration, chosen?.durations)
      const aspect = fitAspectRatio(args.aspect_ratio, abilities?.aspectRatios)
      const resolution = fitResolution(args.resolution, abilities?.resolutions)
      const notes = [duration.note, aspect.note, resolution.note].filter((note): note is string => note !== undefined)
      const seconds = duration.value

      // Оценка до запуска: посекундная цена модели × длительность. Дороже потолка — не снимаем.
      // Итог бывает выше оценки: первый кадр и высокое разрешение оплачиваются дополнительно.
      if (chosen?.perSecond !== undefined && seconds !== undefined) {
        const estimate = chosen.perSecond * seconds
        if (estimate > deps.videoBudget()) {
          throw new Error(`Ролик на ${seconds} с обойдётся примерно в ${rub(estimate)} — это больше потолка ${rub(deps.videoBudget())} из Настроек → RouterAI. Сократите длительность или поднимите потолок.`)
        }
      }

      const film = await makeFilm(deps.apiBase, key, {
        model, prompt: args.prompt,
        ...seconds === undefined ? {} : { seconds },
        ...aspect.value === undefined ? {} : { aspectRatio: aspect.value },
        ...resolution.value === undefined ? {} : { resolution: resolution.value },
        ...args.first_frame === undefined ? {} : { firstFrame: await readFrame(workspace, args.first_frame) },
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

export function registerFilmTool(ctx: Context, deps: FilmDeps): void {
  registerLiveTool(ctx, {
    label: 'routerai: video tool',
    build: () => buildFilmTool(ctx, deps),
    enabled: () => deps.videoModel() !== null,
    signature: () => {
      const model = deps.videoModel()
      const card = model === null ? undefined : deps.findModel(model)
      return JSON.stringify([model, card?.media ?? null, card?.durations ?? null, card?.perSecond ?? null])
    },
    watch: deps.watch,
  })
}
