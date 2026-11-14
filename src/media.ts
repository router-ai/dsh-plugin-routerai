// Картинки и распознавание речи через RouterAI. Оба запроса синхронные:
// POST /images отдаёт картинки в base64, POST /audio/transcriptions — текст.
// В обоих ответах RouterAI сообщает стоимость в рублях (`usage.cost`).

export class MediaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

async function post(apiBase: string, path: string, apiKey: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json', 'X-Title': 'DeepSeek Harness' },
      body: JSON.stringify(body),
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
