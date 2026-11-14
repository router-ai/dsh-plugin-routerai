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
  const takesLast = traits?.frames === undefined || traits.frames.includes('last_frame')
  const takes = traits?.references
  const refuse = 'Выбранная модель этого не поддерживает — не указывай параметр.'
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
      // Число, а не строка вида «480p»: такие значения слабые модели пишут без кавычек, и вызов становится некорректным JSON.
      resolution: { type: 'integer', description: `Высота кадра в пикселях; чем больше, тем дороже.${allowedHint(traits?.resolutions?.map(resolutionHeight).filter((height): height is number => height !== undefined))}` },
      first_frame: { type: 'string', description: takesFrame ? 'Путь к картинке в рабочем каталоге, которая станет первым кадром (image-to-video).' : 'Выбранная модель не принимает первый кадр — не указывай этот параметр.' },
      last_frame: { type: 'string', description: takesLast ? 'Путь к картинке, которой ролик должен закончиться: вместе с first_frame получится плавный переход между двумя картинками.' : refuse },
      references: { type: 'array', items: { type: 'string' }, description: takes === 0 ? refuse
        : `Пути к картинкам-референсам: персонаж, предмет или стиль, которые должны быть в ролике.${takes === undefined ? '' : ` Не больше ${takes}.`}${traits?.referencesExcludeFrames === true ? ' Нельзя совмещать с first_frame и last_frame.' : ''}` },
      audio: { type: 'boolean', description: traits?.audio === true ? 'Нужна ли звуковая дорожка. По умолчанию решает модель.' : refuse },
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
      const resolution = fitResolution(args.resolution === undefined ? undefined : `${args.resolution}p`, abilities?.resolutions)
      const notes = [duration.note, aspect.note, resolution.note].filter((note): note is string => note !== undefined)
      const mostReferences = abilities?.references ?? wanted.length
      if (wanted.length > mostReferences) notes.push(`Модель принимает не больше ${mostReferences} референсов — взяты первые ${mostReferences} из ${wanted.length}`)
      const audio = args.audio === undefined || abilities?.audio === true ? args.audio : undefined
      if (args.audio === true && audio === undefined) notes.push('Модель не делает звуковую дорожку — ролик без звука')
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
        ...args.first_frame === undefined ? {} : { firstFrame: await readPicture(workspace, args.first_frame, 'Первый кадр') },
        ...args.last_frame === undefined ? {} : { lastFrame: await readPicture(workspace, args.last_frame, 'Последний кадр') },
        ...wanted.length === 0 ? {} : { references: await Promise.all(wanted.slice(0, mostReferences).map(path => readPicture(workspace, path, 'Референс'))) },
        ...audio === undefined ? {} : { audio },
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
      const model = deps.videoModel()
      const card = model === null ? undefined : deps.findModel(model)
      return JSON.stringify([model, card?.media ?? null, card?.durations ?? null, card?.perSecond ?? null])
    },
    watch: deps.watch,
  })
}
