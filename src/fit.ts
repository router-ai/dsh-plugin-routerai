// Подгонка пожеланий агента под то, что умеет выбранная модель. У каждой модели свой набор
// соотношений сторон, разрешений и предел числа картинок; запрос с неподдерживаемым значением
// RouterAI отклоняет, поэтому лучше взять ближайшее допустимое и сказать об этом.

/** «16:9» → 1.777…; undefined для «auto» и всего, что не похоже на соотношение. */
export function ratioValue(ratio: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio.trim())
  if (match === null) return undefined
  const height = Number(match[2])
  return height > 0 ? Number(match[1]) / height : undefined
}

/** Высота кадра по обозначению разрешения: «720p» → 720, «2K» → 1440, «4K» → 2160. */
export function resolutionHeight(resolution: string): number | undefined {
  const text = resolution.trim().toLowerCase()
  const lines = /^(\d{3,4})p?$/.exec(text)
  if (lines !== null) return Number(lines[1])
  const thousands = /^(\d+(?:\.\d+)?)k$/.exec(text)
  // 1K ≈ 1080 строк, 2K ≈ 1440, 4K ≈ 2160: соответствие принятое, а не арифметическое.
  if (thousands !== null) return ({ 1: 1080, 2: 1440, 4: 2160 } as Record<number, number>)[Number(thousands[1])] ?? Math.round(Number(thousands[1]) * 540)
  return undefined
}

export interface Fitted<T> {
  /** Что отправить в запросе; undefined — не указывать, пусть решает модель. */
  value: T | undefined
  /** Пояснение, если пожелание пришлось заменить. */
  note?: string
}

function nearest(wanted: string, allowed: readonly string[], measure: (value: string) => number | undefined): string | undefined {
  const target = measure(wanted)
  if (target === undefined) return undefined
  let best: string | undefined
  let gap = Infinity
  for (const option of allowed) {
    const size = measure(option)
    if (size === undefined) continue
    // Сравниваем в логарифмах: 2:1 и 1:2 одинаково далеки от квадрата.
    const distance = Math.abs(Math.log(size / target))
    if (distance < gap) { gap = distance; best = option }
  }
  return best
}

function fitChoice(wanted: string | undefined, allowed: readonly string[] | undefined, measure: (value: string) => number | undefined, label: string): Fitted<string> {
  if (wanted === undefined || wanted.trim() === '') return { value: undefined }
  if (allowed === undefined || allowed.length === 0) return { value: wanted }
  const exact = allowed.find(option => option.toLowerCase() === wanted.trim().toLowerCase())
  if (exact !== undefined) return { value: exact }
  const close = nearest(wanted, allowed, measure)
  if (close === undefined) return { value: undefined, note: `${label} ${wanted} модель не поддерживает — оставлено значение по умолчанию (допустимо: ${allowed.join(', ')})` }
  return { value: close, note: `${label} ${wanted} модель не поддерживает — взято ближайшее, ${close} (допустимо: ${allowed.join(', ')})` }
}

export const fitAspectRatio = (wanted: string | undefined, allowed: readonly string[] | undefined): Fitted<string> =>
  fitChoice(wanted, allowed, ratioValue, 'Соотношение сторон')

/** Уровень размера картинки в пикселях по длинной стороне: «1K» → 1024, «1.5K» → 1536, «768» → 768. */
export function imageSizePixels(size: string): number | undefined {
  const text = size.trim().toLowerCase()
  const thousands = /^(\d+(?:\.\d+)?)k$/.exec(text)
  if (thousands !== null) return Math.round(Number(thousands[1]) * 1024)
  return /^\d{3,5}$/.test(text) ? Number(text) : undefined
}

export const fitImageSize = (wanted: string | undefined, allowed: readonly string[] | undefined): Fitted<string> =>
  fitChoice(wanted, allowed, imageSizePixels, 'Размер')

/** Параметр без «ближайшего» значения (качество, фон, формат): либо модель его знает, либо не отправляем. */
export function fitOption(wanted: string | undefined, allowed: readonly string[] | undefined, label: string): Fitted<string> {
  if (wanted === undefined || wanted.trim() === '') return { value: undefined }
  if (allowed === undefined || allowed.length === 0) return { value: undefined, note: `${label}: модель этот параметр не поддерживает — «${wanted}» не применено` }
  const exact = allowed.find(option => option.toLowerCase() === wanted.trim().toLowerCase())
  if (exact !== undefined) return { value: exact }
  return { value: undefined, note: `${label} «${wanted}» модель не поддерживает — не применено (допустимо: ${allowed.join(', ')})` }
}

export const fitResolution = (wanted: string | undefined, allowed: readonly string[] | undefined): Fitted<string> =>
  fitChoice(wanted, allowed, resolutionHeight, 'Разрешение')

/** Число картинок в пределах того, что модель выдаёт за один запрос. */
export function fitCount(wanted: number | undefined, most: number): Fitted<number> {
  const asked = Math.max(1, Math.round(wanted ?? 1))
  if (asked <= most) return { value: asked }
  return { value: most, note: `Модель рисует не больше ${most} ${most === 1 ? 'картинки' : 'картинок'} за запрос — нарисовано ${most} вместо ${asked}` }
}

/** Ближайшая длительность из тех, что принимает модель. */
export function fitDuration(wanted: number | undefined, allowed: readonly number[] | undefined): Fitted<number> {
  if (allowed === undefined || allowed.length === 0) return { value: wanted }
  if (wanted === undefined) return { value: allowed[0] }
  if (allowed.includes(wanted)) return { value: wanted }
  const close = allowed.reduce((best, option) => (Math.abs(option - wanted) < Math.abs(best - wanted) ? option : best))
  return { value: close, note: `Длительность ${wanted} с модель не поддерживает — взято ближайшее, ${close} с (допустимо: ${allowed.join(', ')})` }
}
