// Каталог моделей RouterAI (GET {API}/models): разбор ответа и локальная копия с фоновым обновлением.
import { JsonFile } from './storage.ts'
import type { TokenPrice } from './money.ts'

/** Модель каталога в том виде, в каком с ней работает плагин. */
export interface ModelCard {
  /** `vendor/model`; у алиасов («последняя модель семейства») спереди `~`. */
  slug: string
  title: string
  maker: string
  alias: boolean
  /** Контекстное окно в токенах. */
  window?: number
  price?: TokenPrice
  tools: boolean
  reasoning: boolean
  vision: boolean
  /** Что модель выдаёт. В пикер попадают только модели с `text`; остальные служат инструментам и голосовому вводу. */
  makes: Output[]
  /** Цена одной картинки, ₽ — только у моделей с оплатой за картинку. */
  perImage?: number
  /** Цена секунды, ₽ — у моделей распознавания речи и видео с посекундной оплатой. */
  perSecond?: number
  /** Длительности ролика в секундах, которые принимает видео-модель. */
  durations?: number[]
  /** Возможности модели для картинок или видео — то, под что инструменты подгоняют запрос. */
  media?: MediaTraits
}

export interface MediaTraits {
  /** Допустимые соотношения сторон; без списка модель принимает любое или не принимает параметр. */
  aspectRatios?: string[]
  /** Допустимые разрешения видео (480p, 720p, …). */
  resolutions?: string[]
  /** Сколько картинок модель выдаёт за один запрос. */
  maxCount?: number
  /** Какие опорные кадры принимает видео-модель. */
  frames?: ('first_frame' | 'last_frame')[]
  /** За что берётся плата: за картинку, за токены или за мегапиксели. От этого зависит, можно ли назвать цену заранее. */
  billedBy?: 'image' | 'token' | 'megapixel'
  /** Уровни размера картинки (1K, 2K, 4K…); от размера зависит цена. */
  sizes?: string[]
  qualities?: string[]
  /** Варианты фона; `transparent` — прозрачный. */
  backgrounds?: string[]
  /** Форматы файла картинки (png, jpeg, webp, svg, gif). */
  formats?: string[]
  /** Сколько исходных картинок модель принимает (правка, стиль, персонаж); 0 — не принимает. */
  references?: number
  /** Видео-модель не совмещает опорные кадры с референсами. */
  referencesExcludeFrames?: true
  /** Видео-модель умеет делать звуковую дорожку. */
  audio?: true
  /** Модель принимает зерно: с тем же зерном и описанием результат повторяется. */
  seed?: true
  /** Видео-модель принимает готовый ролик на входе (продление, правка, апскейл). */
  takesVideo?: true
  /** Модель работает только с готовым видео или аудио на входе (апскейл, аватары) — по одному описанию ролик не снимет. */
  needsSource?: true
}

export type Output = 'text' | 'image' | 'transcription' | 'video' | 'speech'

const OUTPUTS: readonly Output[] = ['text', 'image', 'transcription', 'video', 'speech']

export const isChatModel = (card: ModelCard): boolean => card.makes.includes('text')
export const isImageModel = (card: ModelCard): boolean => card.makes.includes('image')
export const isSpeechModel = (card: ModelCard): boolean => card.makes.includes('transcription')
export const isVideoModel = (card: ModelCard): boolean => card.makes.includes('video')
export const isVoiceModel = (card: ModelCard): boolean => card.makes.includes('speech')

const SLUG = /^~?[a-z0-9][\w.-]*\/[a-z0-9][\w.:-]*$/i

export function isModelSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && SLUG.test(value)
}

type Bag = Record<string, unknown>

function bag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Bag : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function amount(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** Каталог отдаёт цену за единицу; в «рубли за миллион» переводим только то, что тарифицируется по токенам. */
function tokenPrice(pricing: Bag, units: Bag): TokenPrice | undefined {
  const perMillion = (field: string): number | undefined => {
    const unit = units[field]
    if (unit !== undefined && unit !== 'token') return undefined
    const value = amount(pricing[field])
    return value === undefined ? undefined : value * 1_000_000
  }
  const input = perMillion('prompt')
  const output = perMillion('completion')
  if (input === undefined || output === undefined) return undefined
  const price: TokenPrice = { input, output }
  const cachedInput = perMillion('input_cache_read')
  const cacheWrite = perMillion('input_cache_write')
  if (cachedInput !== undefined) price.cachedInput = cachedInput
  if (cacheWrite !== undefined) price.cacheWrite = cacheWrite
  return price
}

/** Что каталог сообщает о возможностях модели для картинок или видео. */
function mediaTraits(raw: Bag, architecture: Bag, makes: readonly Output[]): MediaTraits | undefined {
  if (!makes.includes('image') && !makes.includes('video')) return undefined
  const traits: MediaTraits = {}
  const aspectRatios = strings(raw['supported_aspect_ratios'])
  if (aspectRatios.length > 0) traits.aspectRatios = aspectRatios
  if (makes.includes('image')) {
    const most = amount(raw['max_image_count'])
    if (most !== undefined && most >= 1) traits.maxCount = Math.floor(most)
    const units = Array.isArray(raw['image_pricing']) ? (raw['image_pricing'] as unknown[]).map(entry => bag(entry)['unit']) : []
    const unit = (['image', 'megapixel', 'token'] as const).find(candidate => units.includes(candidate))
    if (unit !== undefined) traits.billedBy = unit
    for (const [field, key] of [['supported_image_sizes', 'sizes'], ['supported_qualities', 'qualities'], ['supported_backgrounds', 'backgrounds'], ['supported_output_formats', 'formats']] as const) {
      const values = strings(raw[field])
      if (values.length > 0) traits[key] = values
    }
    if (raw['image_seed'] === true) traits.seed = true
    if (raw['supported_image_references'] === false) traits.references = 0
    else if (raw['supported_image_references'] === true) traits.references = Math.floor(amount(raw['max_image_references']) ?? 1)
  }
  if (makes.includes('video')) {
    const resolutions = strings(raw['supported_resolutions'])
    if (resolutions.length > 0) traits.resolutions = resolutions
    const frames = strings(raw['supported_frame_images']).filter((frame): frame is 'first_frame' | 'last_frame' => frame === 'first_frame' || frame === 'last_frame')
    if (frames.length > 0) traits.frames = frames
    // Модель без длительностей и без опорных кадров снимает не «с нуля»: ей нужно исходное видео или аудио.
    const durations = Array.isArray(raw['supported_durations']) ? raw['supported_durations'] as unknown[] : []
    const sources = strings(architecture['input_modalities'])
    if (raw['supports_reference_images'] === false) traits.references = 0
    else if (raw['supports_reference_images'] === true) traits.references = Math.floor(amount(raw['max_image_references']) ?? 1)
    if (raw['frames_exclusive_with_references'] === true && (traits.references ?? 0) > 0) traits.referencesExcludeFrames = true
    if (raw['generate_audio'] === true) traits.audio = true
    if (raw['seed'] === true) traits.seed = true
    if (strings(architecture['input_modalities']).includes('video')) traits.takesVideo = true
    if (durations.length === 0 && frames.length === 0 && (sources.includes('video') || sources.includes('audio'))) traits.needsSource = true
  }
  return traits
}

/** Цена за картинку из `image_pricing`; модели с оплатой по токенам или мегапикселям так не оценить. */
function firstImagePrice(pricing: unknown): number | undefined {
  if (!Array.isArray(pricing)) return undefined
  const perImage = pricing.map(bag).filter(entry => entry['unit'] === 'image').map(entry => amount(entry['price']))
  const known = perImage.filter((value): value is number => value !== undefined)
  return known.length === 0 ? undefined : Math.min(...known)
}

/** «Anthropic: Claude Sonnet 5.5» → производитель и название по отдельности. */
function splitName(name: string, slug: string): { maker: string; title: string } {
  const colon = name.indexOf(': ')
  if (colon > 0 && colon <= 40) return { maker: name.slice(0, colon), title: name.slice(colon + 2).trim() || slug }
  const vendor = slug.replace(/^~/, '').split('/')[0] ?? ''
  return { maker: vendor.charAt(0).toUpperCase() + vendor.slice(1), title: name.trim() || slug }
}

/** Одна запись ответа; undefined для повреждённых записей и моделей, с которыми плагин не работает (эмбеддинги, ранжирование). */
export function readModelCard(entry: unknown): ModelCard | undefined {
  const raw = bag(entry)
  if (!isModelSlug(raw['id'])) return undefined
  const architecture = bag(raw['architecture'])
  const declared = strings(architecture['output_modalities'])
  const makes = declared.length === 0 ? ['text' as const] : OUTPUTS.filter(output => declared.includes(output))
  if (makes.length === 0) return undefined
  const parameters = strings(raw['supported_parameters'])
  const slug = raw['id']
  const card: ModelCard = {
    slug,
    ...splitName(typeof raw['name'] === 'string' ? raw['name'] : '', slug),
    alias: slug.startsWith('~'),
    tools: parameters.includes('tools'),
    reasoning: parameters.includes('reasoning') || parameters.includes('reasoning_effort'),
    vision: strings(architecture['input_modalities']).includes('image'),
    makes,
  }
  const window = amount(raw['context_length'])
  if (window !== undefined && window > 0) card.window = window
  const price = tokenPrice(bag(raw['pricing']), bag(raw['pricing_units']))
  if (price !== undefined) card.price = price
  const perImage = firstImagePrice(raw['image_pricing'])
  if (perImage !== undefined) card.perImage = perImage
  if (bag(raw['pricing_units'])['seconds'] === 'second') {
    const perSecond = amount(bag(raw['pricing'])['seconds'])
    if (perSecond !== undefined) card.perSecond = perSecond
  }
  const media = mediaTraits(raw, architecture, makes)
  if (media !== undefined) card.media = media
  if (Array.isArray(raw['supported_durations'])) {
    const durations = (raw['supported_durations'] as unknown[]).filter((value): value is number => typeof value === 'number' && value > 0).sort((a, b) => a - b)
    if (durations.length > 0) card.durations = durations
  }
  return card
}

/** Ответ `GET /models` целиком. */
export function readModelList(payload: unknown): ModelCard[] {
  const entries = bag(payload)['data']
  if (!Array.isArray(entries)) return []
  const cards: ModelCard[] = []
  for (const entry of entries) {
    const card = readModelCard(entry)
    if (card !== undefined) cards.push(card)
  }
  return cards
}

export async function downloadModelList(apiBase: string, signal?: AbortSignal): Promise<ModelCard[]> {
  const deadline = AbortSignal.timeout(60_000)
  const response = await fetch(`${apiBase}/models`, {
    headers: { accept: 'application/json' },
    signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
  })
  if (!response.ok) throw new Error(`каталог RouterAI недоступен: HTTP ${response.status}`)
  const cards = readModelList(await response.json())
  if (cards.length === 0) throw new Error('каталог RouterAI вернул пустой список моделей')
  return cards
}

interface Snapshot {
  format: 6
  source: string
  savedAt: number
  cards: ModelCard[]
}

function acceptSnapshot(raw: unknown): Snapshot | undefined {
  const value = bag(raw)
  if (value['format'] !== 6 || typeof value['source'] !== 'string' || typeof value['savedAt'] !== 'number') return undefined
  if (!Array.isArray(value['cards'])) return undefined
  const cards = (value['cards'] as unknown[]).filter((card): card is ModelCard => isModelSlug(bag(card)['slug']) && Array.isArray(bag(card)['makes']))
  return { format: 6, source: value['source'], savedAt: value['savedAt'], cards }
}

export interface ModelCatalogOptions {
  apiBase: string
  /** Файл с последней удачной копией; без него каталог живёт только в памяти. */
  file?: string
  maxAgeMs: number
  download?: (apiBase: string) => Promise<ModelCard[]>
  clock?: () => number
}

/**
 * Копия каталога в памяти. Чтение всегда мгновенное: маршрут собирает список моделей
 * на каждый запрос и ждать сеть не может. Сеть трогает только `sync()`.
 */
export class ModelCatalog {
  private index = new Map<string, ModelCard>()
  private stamp = 0
  private running: Promise<void> | undefined
  private readonly listeners = new Set<() => void>()
  private readonly disk: JsonFile<Snapshot> | undefined
  private readonly download: (apiBase: string) => Promise<ModelCard[]>
  private readonly clock: () => number
  /** Последняя ошибка обновления — для диагностики в интерфейсе и логе. */
  lastError: string | undefined

  constructor(private readonly options: ModelCatalogOptions) {
    this.disk = options.file === undefined ? undefined : new JsonFile(options.file, acceptSnapshot)
    this.download = options.download ?? (apiBase => downloadModelList(apiBase))
    this.clock = options.clock ?? Date.now
  }

  get size(): number { return this.index.size }

  all(): ModelCard[] { return [...this.index.values()] }

  find(slug: string): ModelCard | undefined { return this.index.get(slug) }

  /** Подписка на замену содержимого; возвращает функцию отписки. */
  watch(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Поднять копию с диска (если она от того же API). */
  async restore(): Promise<void> {
    const saved = await this.disk?.read()
    if (saved === undefined || saved.source !== this.options.apiBase || saved.cards.length === 0) return
    this.adopt(saved.cards, saved.savedAt)
  }

  /** Обновить из сети, если копия устарела или её нет. Сбой оставляет прежнюю копию. */
  sync(force = false): Promise<void> {
    const fresh = this.index.size > 0 && this.clock() - this.stamp < this.options.maxAgeMs
    if (fresh && !force) return Promise.resolve()
    this.running ??= this.pull().finally(() => { this.running = undefined })
    return this.running
  }

  private async pull(): Promise<void> {
    try {
      const cards = await this.download(this.options.apiBase)
      this.lastError = undefined
      this.adopt(cards, this.clock())
      await this.disk?.write({ format: 6, source: this.options.apiBase, savedAt: this.stamp, cards })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  private adopt(cards: readonly ModelCard[], stamp: number): void {
    this.index = new Map(cards.map(card => [card.slug, card]))
    this.stamp = stamp
    for (const listener of this.listeners) listener()
  }
}
