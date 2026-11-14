// Инструмент агента «снять видео». Ролик делается несколько минут и стоит заметно дороже картинки,
// поэтому инструмент выключен, пока пользователь не выберет модель, и не снимает ролики дороже заданного потолка.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ModelCard } from './catalog.ts'
import { fileStem } from './draw.ts'
import { MEDIA_FOLDER, VIDEO_TOOL } from './links.ts'
import { makeFilm, sniffPictureType } from './media.ts'
import { rub } from './money.ts'

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
}

const FRAME_LIMIT = 10 * 1024 * 1024

/** Ближайшая длительность из тех, что принимает модель. */
export function fitDuration(wanted: number | undefined, allowed: readonly number[] | undefined): number | undefined {
  if (allowed === undefined || allowed.length === 0) return wanted
  if (wanted === undefined) return allowed[0]
  return allowed.reduce((best, option) => (Math.abs(option - wanted) < Math.abs(best - wanted) ? option : best))
}

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
}

export function registerFilmTool(ctx: Context, deps: FilmDeps): void {
  const tool = defineTool({
    name: VIDEO_TOOL,
    description: 'Снять короткое видео по текстовому описанию, при желании — оживить картинку (первый кадр). '
      + `Работа занимает несколько минут; ролик сохраняется в папку ${MEDIA_FOLDER} рабочего каталога. `
      + 'Вызов платный и заметно дороже картинки — используй, только когда пользователь прямо просит видео.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Что происходит в кадре: сцена, движение, камера, стиль.' },
      duration: { type: 'integer', description: 'Длительность в секундах. Допустимые значения зависят от модели; будет выбрано ближайшее.' },
      aspect_ratio: { type: 'string', description: 'Соотношение сторон, например 16:9, 9:16, 1:1.' },
      resolution: { type: 'string', description: 'Разрешение, например 480p, 720p, 1080p. Выше разрешение — дороже.' },
      first_frame: { type: 'string', description: 'Путь к картинке в рабочем каталоге, которая станет первым кадром (image-to-video).' },
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
        },
      },
      render: (_args, value) => {
        const filmed = value as unknown as Filmed
        const parts = [`Видео готово: ${filmed.file}`, `модель ${filmed.model}`]
        if (filmed.seconds !== null) parts.push(`длительность ${filmed.seconds} с`)
        if (filmed.cost !== null) parts.push(`стоимость ${rub(filmed.cost)}`)
        return [{ type: 'text', text: `${parts.join('; ')}.` }]
      },
      presentationMeta: (_args, value) => {
        const filmed = value as unknown as Filmed
        return { model: filmed.model, cost: filmed.cost, files: [filmed.file] }
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

      const card = deps.findModel(model)
      const seconds = fitDuration(args.duration, card?.durations)
      // Оценка до запуска: посекундная цена модели × длительность. Дороже потолка — не снимаем.
      if (card?.perSecond !== undefined && seconds !== undefined) {
        const estimate = card.perSecond * seconds
        if (estimate > deps.videoBudget()) {
          throw new Error(`Ролик на ${seconds} с обойдётся примерно в ${rub(estimate)} — это больше потолка ${rub(deps.videoBudget())} из Настроек → RouterAI. Сократите длительность или поднимите потолок.`)
        }
      }

      const film = await makeFilm(deps.apiBase, key, {
        model, prompt: args.prompt,
        ...seconds === undefined ? {} : { seconds },
        ...args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio },
        ...args.resolution === undefined ? {} : { resolution: args.resolution },
        ...args.first_frame === undefined ? {} : { firstFrame: await readFrame(workspace, args.first_frame) },
      }, run.signal, deps.pollMs === undefined ? {} : { pollMs: deps.pollMs })

      const folder = join(workspace, MEDIA_FOLDER)
      await mkdir(folder, { recursive: true })
      const file = join(folder, `${fileStem(args.file_name, args.prompt)}.mp4`)
      await writeFile(file, film.bytes)
      if (film.cost !== undefined) deps.charged(String(run.agent.id), model, film.cost)
      const filmed: Filmed = { model, cost: film.cost ?? null, file, seconds: seconds ?? null }
      return filmed as never
    },
  })

  ctx.effect(() => ctx.tools.register(tool, { when: () => deps.videoModel() !== null }), 'routerai: video tool')
}
