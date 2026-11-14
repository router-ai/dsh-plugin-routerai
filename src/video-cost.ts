// Оценка стоимости ролика до запроса — по сетке цен `video_pricing` из каталога RouterAI.
// Цена секунды зависит от разрешения, звука и способа генерации; отдельно оплачиваются входные картинки,
// у части моделей — входное видео, а апскейл считается по размеру кадра результата. `pricing.seconds`
// из каталога — лишь самая дешёвая секунда, по ней потолок стоимости соблюсти нельзя.
import type { ModelCard, VideoPrice } from './catalog.ts'
import { ratioValue, resolutionHeight } from './fit.ts'

/** Что известно о будущем ролике. */
export interface FilmPlan {
  /** Длительность результата; у обработки готового видео — длительность исходника. */
  seconds?: number
  /** Разрешение, которое уйдёт в запросе; без него модель выбирает сама. */
  resolution?: string
  aspectRatio?: string
  /** true/false — явное пожелание о звуке; undefined — решает модель. */
  audio?: boolean
  /** Задан первый или последний кадр. */
  frames: number
  /** Число картинок-референсов. */
  references: number
  /** Готовое видео на входе. */
  source?: { seconds?: number; width?: number; height?: number }
  /** Апскейл: кратность увеличения и режим, которые уйдут в запросе. */
  upscale?: { factor: number; creative: boolean }
}

export interface Estimate {
  rub: number
  /** Из чего сложилась сумма — для сообщения пользователю. */
  basis: string
}

const LONG_AFTER_SECONDS = 10
const UPSCALE_MARGIN = 1.1

const sameResolution = (a: string | null, b: string | undefined) => a !== null && b !== undefined && a.toLowerCase() === b.toLowerCase()

/** Цена единицы для нужного разрешения: своя строка, иначе общая; без известного разрешения — самая дорогая. */
function priceFor(rows: readonly VideoPrice[], resolution: string | undefined): number | undefined {
  if (rows.length === 0) return undefined
  // Строк на одно разрешение бывает несколько (например, обычный и «длинный» тариф) — берём дорогую.
  const exact = rows.filter(row => sameResolution(row.resolution, resolution))
  if (exact.length > 0) return Math.max(...exact.map(row => row.price))
  const general = rows.filter(row => row.resolution === null)
  if (resolution !== undefined && general.length > 0) return Math.max(...general.map(row => row.price))
  // Разрешение не задано или для него нет строки: берём худший случай, чтобы потолок не оказался дырявым.
  return Math.max(...rows.map(row => row.price))
}

/** Строки подходящего варианта тарифа; порядок проверки — от частного к общему. */
function secondRows(rows: readonly VideoPrice[], plan: FilmPlan): VideoPrice[] {
  const seconds = rows.filter(row => row.unit === 'second')
  const of = (...variants: (string | null)[]) => seconds.filter(row => variants.includes(row.variant))
  if (plan.source !== undefined) {
    const continued = of('with_video_input', 'video_continuation')
    if (continued.length > 0) return continued
  }
  if (plan.references > 0 && of('reference').length > 0) return of('reference')
  const withAudio = of('with_audio')
  const withoutAudio = of('without_audio')
  if (withAudio.length > 0 || withoutAudio.length > 0) {
    if (plan.audio === false && withoutAudio.length > 0) return withoutAudio
    if (plan.audio === true && withAudio.length > 0) return withAudio
    // Звук не оговорён — модель решает сама; считаем по более дорогому варианту.
    return [...withAudio, ...withoutAudio]
  }
  const byImage = of('image_to_video')
  const byText = of('text_to_video')
  if (byImage.length > 0 || byText.length > 0) {
    const wanted = plan.frames > 0 ? byImage : byText
    return wanted.length > 0 ? wanted : [...byImage, ...byText]
  }
  // «Длинный ролик» тарифицируется дороже, а порог каталог не называет — для роликов длиннее 10 с считаем по худшему случаю.
  return (plan.seconds ?? 0) > LONG_AFTER_SECONDS ? [...of(null), ...of('long')] : of(null)
}

/** Ширина кадра по разрешению и соотношению сторон (по умолчанию 16:9). */
function frameSize(resolution: string | undefined, aspectRatio: string | undefined): { width: number; height: number } | undefined {
  const height = resolution === undefined ? undefined : resolutionHeight(resolution)
  if (height === undefined) return undefined
  const ratio = (aspectRatio === undefined ? undefined : ratioValue(aspectRatio)) ?? 16 / 9
  // Для вертикального кадра «720p» означает короткую сторону.
  return ratio >= 1 ? { width: Math.round(height * ratio), height } : { width: height, height: Math.round(height / ratio) }
}

/** Оценить стоимость; undefined — по каталогу её не посчитать. */
export function estimateFilm(card: ModelCard, plan: FilmPlan): Estimate | undefined {
  const rows = card.videoPricing ?? []
  const inputBilled = card.media?.videoInputBilled === true ? plan.source?.seconds ?? 0 : 0
  const outputSeconds = plan.seconds ?? plan.source?.seconds
  let total: number | undefined
  let basis = ''

  const megapixelRows = rows.filter(row => row.unit === 'megapixel_second')
  const tokenRows = rows.filter(row => row.unit === 'token')
  const perSecond = priceFor(secondRows(rows, plan), plan.resolution)

  if (megapixelRows.length > 0) {
    // Апскейл: мегапиксели кадра результата × секунды × цена режима. Без известных кратности и режима —
    // худший случай: наибольшая кратность и самый дорогой режим.
    const source = plan.source
    if (source?.width === undefined || source.height === undefined || outputSeconds === undefined) return undefined
    const factor = plan.upscale?.factor ?? card.media?.upscale?.max ?? 1
    const megapixels = source.width * factor * source.height * factor / 1_000_000
    const mode = plan.upscale === undefined ? undefined : megapixelRows.find(row => row.variant === (plan.upscale!.creative ? 'creative' : 'precise'))
    const price = mode?.price ?? Math.max(...megapixelRows.map(row => row.price))
    // Запас 10 %: провайдер округляет объём работы вверх (живой прогон: оценка 5,87 ₽, списано 6,41 ₽).
    total = megapixels * outputSeconds * price * UPSCALE_MARGIN
    basis = `${megapixels.toFixed(2)} Мп × ${outputSeconds.toFixed(1)} с`
  } else if (perSecond !== undefined) {
    if (outputSeconds === undefined) return undefined
    total = perSecond * (outputSeconds + inputBilled)
    basis = `${Math.round((outputSeconds + inputBilled) * 10) / 10} с${plan.resolution === undefined ? '' : ` в ${plan.resolution}`}`
  } else if (tokenRows.length > 0) {
    // Токенные модели: токенов = ширина × высота / 1024 × (24 × секунды + 1).
    const size = frameSize(plan.resolution, plan.aspectRatio)
    if (size === undefined || outputSeconds === undefined) return undefined
    // С входным видео его длительность прибавляется к секундам, а цена токена берётся из своей строки.
    const extra = plan.source?.seconds ?? 0
    const withInput = tokenRows.filter(row => row.variant === 'with_video_input')
    const silent = tokenRows.filter(row => row.variant === 'without_audio')
    const applicable = plan.source !== undefined && withInput.length > 0 ? withInput
      : plan.audio === false && silent.length > 0 ? silent
        : tokenRows.filter(row => row.variant !== 'with_video_input')
    const tokens = size.width * size.height / 1024 * (24 * (outputSeconds + extra) + 1)
    total = tokens * Math.max(...(applicable.length > 0 ? applicable : tokenRows).map(row => row.price))
    basis = `${Math.round((outputSeconds + extra) * 10) / 10} с, ${size.width}×${size.height}`
  } else if (rows.length === 0 && card.perSecond !== undefined && outputSeconds !== undefined) {
    // Каталог без сетки цен: остаётся цена самой дешёвой секунды. Оценка снизу, но лучше, чем ничего.
    total = card.perSecond * outputSeconds
    basis = `${Math.round(outputSeconds * 10) / 10} с по минимальной цене`
  }
  if (total === undefined) return undefined

  // Каждая входная картинка (кадры и референсы) может оплачиваться отдельно.
  const perImage = rows.find(row => row.unit === 'image' && row.variant === 'image_input')?.price
  const images = plan.frames + plan.references
  if (perImage !== undefined && images > 0) {
    total += perImage * images
    basis += ` + ${images} ${images === 1 ? 'входная картинка' : 'входных картинки'}`
  }
  const floor = rows.find(row => row.variant === 'minimum_per_generation')?.price
  if (floor !== undefined && total < floor) total = floor
  return { rub: total, basis }
}

/** Цены по разрешениям одной строкой — для описания инструмента: «480p — 2,14 ₽, 720p — 3,20 ₽». */
export function priceTable(card: ModelCard, format: (rub: number) => string): string {
  // Только основные тарифы: полная сетка у некоторых моделей — дюжина строк, агенту она ни к чему.
  const rows = (card.videoPricing ?? []).filter(row => row.unit === 'second' && [null, 'with_audio', 'without_audio'].includes(row.variant)).slice(0, 8)
  if (rows.length === 0) return ''
  const label = (row: VideoPrice) => [row.resolution, { with_audio: 'со звуком', without_audio: 'без звука', text_to_video: 'по тексту', image_to_video: 'по картинке', reference: 'по референсам', with_video_input: 'с входным видео', video_continuation: 'продолжение', long: 'длинный ролик' }[row.variant ?? '']]
    .filter(Boolean).join(' ')
  return rows.map(row => `${label(row) || 'секунда'} — ${format(row.price)}`).join(', ')
}
