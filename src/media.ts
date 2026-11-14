// Картинки, видео и распознавание речи через RouterAI.
// Картинки (POST /images) и речь (POST /audio/transcriptions) — синхронные запросы.
// Видео — задача: POST /videos её создаёт, GET /videos/{id} сообщает статус,
// GET /videos/{id}/content отдаёт готовый mp4. Стоимость в рублях приходит в `usage.cost`.

export class MediaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

async function post(apiBase: string, path: string, apiKey: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Record<string, unknown>> {
  return exchange(`${apiBase}${path}`, apiKey, body, signal, timeoutMs)
}

/** Запрос к RouterAI с разбором ответа и ошибок; без `body` — GET. */
async function exchange(url: string, apiKey: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'X-Title': 'DeepSeek Harness', ...body === undefined ? {} : { 'content-type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new MediaError(`RouterAI не ответил: ${error instanceof Error ? error.message : String(error)}`)
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || payload === null) {
    // Ошибки RouterAI бывают двух видов: { error: { message } } и { error: "текст" }.
    const problem = payload?.['error']
    const detail = typeof problem === 'string' ? problem : (problem as { message?: unknown } | undefined)?.message
    throw new MediaError(typeof detail === 'string' && detail !== '' ? detail : `RouterAI ответил HTTP ${response.status}`, response.status)
  }
  return payload
}

function cost(payload: Record<string, unknown>): number | undefined {
  const value = (payload['usage'] as { cost?: unknown } | undefined)?.cost
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface Picture {
  bytes: Uint8Array
  type: PictureType
}

/** Тип картинки по первым байтам: RouterAI указывает его не для всех моделей. */
export function sniffPictureType(bytes: Uint8Array): PictureType | undefined {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

export interface DrawRequest {
  model: string
  prompt: string
  /** Соотношение сторон, например 16:9; допустимые значения зависят от модели. */
  aspectRatio?: string
  count?: number
}

export async function drawPictures(apiBase: string, apiKey: string, request: DrawRequest, signal: AbortSignal): Promise<{ pictures: Picture[]; cost?: number }> {
  const payload = await post(apiBase, '/images', apiKey, {
    model: request.model,
    prompt: request.prompt,
    ...request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio },
    ...request.count === undefined ? {} : { n: request.count },
  }, signal, 240_000)
  const pictures: Picture[] = []
  for (const item of Array.isArray(payload['data']) ? payload['data'] as Record<string, unknown>[] : []) {
    if (typeof item?.['b64_json'] !== 'string') continue
    const bytes = new Uint8Array(Buffer.from(item['b64_json'], 'base64'))
    // Векторные и прочие форматы harness в чате не показывает — берём только растровые.
    const type = sniffPictureType(bytes)
    if (type !== undefined) pictures.push({ bytes, type })
  }
  if (pictures.length === 0) throw new MediaError('RouterAI не вернул ни одной картинки в поддерживаемом формате (PNG, JPEG, WebP, GIF)')
  const price = cost(payload)
  return price === undefined ? { pictures } : { pictures, cost: price }
}

/** Длительность записи по заголовку WAV; 0, если заголовок не разобрать. */
export function wavSeconds(wav: Uint8Array): number {
  if (wav.byteLength < 44) return 0
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const bytesPerSecond = view.getUint32(28, true)
  return bytesPerSecond > 0 ? (wav.byteLength - 44) / bytesPerSecond : 0
}

export interface Heard {
  text: string
  /** Длительность аудио по данным RouterAI, если он её сообщил. */
  seconds?: number
  cost?: number
}

/** Распознать запись (WAV). Язык — код ISO-639-1; без него RouterAI определяет язык сам. */
export async function recognizeSpeech(apiBase: string, apiKey: string, request: { model: string; wav: Uint8Array; language?: string }, signal: AbortSignal): Promise<Heard> {
  const payload = await post(apiBase, '/audio/transcriptions', apiKey, {
    model: request.model,
    input_audio: { data: Buffer.from(request.wav).toString('base64'), format: 'wav' },
    ...request.language === undefined ? {} : { language: request.language },
  }, signal, 120_000)
  const heard: Heard = { text: typeof payload['text'] === 'string' ? payload['text'].trim() : '' }
  const seconds = (payload['usage'] as { seconds?: unknown } | undefined)?.seconds
  if (typeof seconds === 'number' && seconds > 0) heard.seconds = seconds
  const price = cost(payload)
  if (price !== undefined) heard.cost = price
  return heard
}

export interface FilmRequest {
  model: string
  prompt: string
  /** Длительность в секундах; допустимые значения зависят от модели. */
  seconds?: number
  aspectRatio?: string
  /** Например 480p, 720p, 1080p. */
  resolution?: string
  /** Первый кадр ролика: картинка в виде data-URI. */
  firstFrame?: string
}

export interface Film {
  bytes: Uint8Array
  cost?: number
  jobId: string
}

export interface FilmOptions {
  /** Пауза между проверками статуса. */
  pollMs?: number
  /** Сколько всего ждать готовности. */
  patienceMs?: number
  /** Статус задачи сменился — для индикации хода работы. */
  onStatus?(status: string): void
}

const FAILED = new Set(['failed', 'cancelled', 'expired'])

/** Снять видео: создать задачу, дождаться готовности и скачать результат. */
export async function makeFilm(apiBase: string, apiKey: string, request: FilmRequest, signal: AbortSignal, options: FilmOptions = {}): Promise<Film> {
  const job = await post(apiBase, '/videos', apiKey, {
    model: request.model,
    prompt: request.prompt,
    ...request.seconds === undefined ? {} : { duration: request.seconds },
    ...request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio },
    ...request.resolution === undefined ? {} : { resolution: request.resolution },
    ...request.firstFrame === undefined ? {} : { frame_images: [{ type: 'image_url', image_url: { url: request.firstFrame }, frame_type: 'first_frame' }] },
  }, signal, 60_000)
  const jobId = typeof job['id'] === 'string' ? job['id'] : ''
  if (jobId === '') throw new MediaError('RouterAI не вернул идентификатор задачи на видео')

  const deadline = Date.now() + (options.patienceMs ?? 20 * 60_000)
  let state = job
  let seen = ''
  for (;;) {
    const status = typeof state['status'] === 'string' ? state['status'] : ''
    if (status !== seen) {
      seen = status
      options.onStatus?.(status)
    }
    if (status === 'completed') break
    if (FAILED.has(status)) {
      const reason = typeof state['error'] === 'string' && state['error'] !== '' ? state['error'] : `задача завершилась со статусом ${status}`
      throw new MediaError(`RouterAI не снял видео: ${reason}`)
    }
    if (Date.now() > deadline) throw new MediaError('Видео не было готово за отведённое время. Задача могла завершиться позже — проверьте раздел активности в кабинете RouterAI.')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, options.pollMs ?? 5000)
      const stop = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('Отменено')) }
      signal.addEventListener('abort', stop, { once: true })
    })
    state = await exchange(`${apiBase}/videos/${encodeURIComponent(jobId)}`, apiKey, undefined, signal, 30_000)
  }

  let download: Response
  try {
    download = await fetch(`${apiBase}/videos/${encodeURIComponent(jobId)}/content`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new MediaError(`Не удалось скачать видео: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!download.ok) throw new MediaError(`Не удалось скачать видео: HTTP ${download.status}`, download.status)
  const bytes = new Uint8Array(await download.arrayBuffer())
  if (bytes.byteLength === 0) throw new MediaError('RouterAI отдал пустой файл видео')
  const price = cost(state)
  return price === undefined ? { bytes, jobId } : { bytes, jobId, cost: price }
}
