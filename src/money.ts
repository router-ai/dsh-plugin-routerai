// Рубли: форматирование сумм и цен. Модуль без зависимостей — общий для сервера и браузера.

/**
 * Сколько знаков после запятой показать: [обязательных, предельных]. Копейки показываются всегда,
 * а третий и четвёртый знак — только у мелких сумм и только когда они не нулевые («0,50 ₽», «0,042 ₽», «0,0066 ₽»).
 */
function fractionDigits(amount: number): [number, number] {
  const size = Math.abs(amount)
  // Целые суммы и крупные — без копеек: «15 ₽», «1 235 ₽».
  if (size === 0 || size >= 100 || Number.isInteger(amount)) return [0, 0]
  if (size >= 1) return [2, 2]
  return size >= 0.01 ? [2, 3] : [2, 4]
}

export function rub(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—'
  const [least, most] = fractionDigits(amount)
  const text = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: least, maximumFractionDigits: most }).format(amount)
  return `${text} ₽`
}

/** Цена модели, рубли за миллион токенов. */
export interface TokenPrice {
  input: number
  output: number
  /** Вход, прочитанный из кэша; без значения считается по цене обычного входа. */
  cachedInput?: number
  /** Запись в кэш; без значения считается по цене обычного входа. */
  cacheWrite?: number
}

/** «216 ₽ / 1 079 ₽» — вход и выход за миллион токенов. */
export function pricePair(price: TokenPrice | undefined): string {
  return price === undefined ? '' : `${rub(price.input)} / ${rub(price.output)}`
}

/** Размер контекстного окна: 1048576 → «1M», 200000 → «200K». */
export function windowLabel(tokens: number | undefined): string {
  if (tokens === undefined) return ''
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  return `${Math.round(tokens / 1000)}K`
}
