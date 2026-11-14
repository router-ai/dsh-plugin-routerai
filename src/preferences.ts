// Выбор пользователя: какие модели показывать в пикере и мелкие настройки плагина.
// Хранится одним документом; пока пользователь ничего не менял, действует конфигурация плагина.
import { isModelSlug } from './catalog.ts'
import { JsonFile } from './storage.ts'

export const PICKER_LIMIT = 150

export interface Preferences {
  /** Модели пикера по порядку; undefined — список берётся из конфигурации. */
  models?: string[]
  /** Модель для заголовков сессий и сжатия контекста; null — та же, что в разговоре. */
  utilityModel: string | null
  /** Ниже этого баланса (₽) интерфейс предупреждает, что деньги заканчиваются. */
  lowBalance: number
  /** Модель, которой агент рисует картинки; null — рисование выключено. */
  imageModel: string | null
  /** Модель распознавания речи для голосового ввода. */
  speechModel: string
  /** Модель, которой агент снимает видео; null — видео выключено (так по умолчанию: ролики дорогие). */
  videoModel: string | null
  /** Потолок стоимости одного ролика, ₽: дороже инструмент снимать откажется. */
  videoBudget: number
}

export const DEFAULT_UTILITY_MODEL = 'deepseek/deepseek-v4.1-flash'
export const DEFAULT_IMAGE_MODEL = 'bytedance-seed/seedream-5-5'
export const DEFAULT_SPEECH_MODEL = 'openai/whisper-large-v3-turbo'

const INITIAL: Preferences = { utilityModel: DEFAULT_UTILITY_MODEL, lowBalance: 100, imageModel: DEFAULT_IMAGE_MODEL, speechModel: DEFAULT_SPEECH_MODEL, videoModel: null, videoBudget: 100 }

/** Привести список моделей к каноническому виду или объяснить, что с ним не так. */
export function cleanModelList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Список моделей должен быть массивом')
  const seen = new Set<string>()
  for (const item of value) {
    if (!isModelSlug(item)) throw new Error(`«${String(item)}» не похоже на идентификатор модели вида vendor/model`)
    seen.add(item)
  }
  if (seen.size > PICKER_LIMIT) throw new Error(`В пикере может быть не больше ${PICKER_LIMIT} моделей`)
  return [...seen]
}

function fromDisk(raw: unknown): Preferences | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const stored = raw as Record<string, unknown>
  const result: Preferences = { ...INITIAL }
  try {
    if (stored['models'] !== undefined) result.models = cleanModelList(stored['models'])
  } catch {
    // испорченный список — как будто его не задавали
  }
  if (stored['utilityModel'] === null || isModelSlug(stored['utilityModel'])) result.utilityModel = stored['utilityModel']
  if (typeof stored['lowBalance'] === 'number' && stored['lowBalance'] >= 0) result.lowBalance = stored['lowBalance']
  if (stored['imageModel'] === null || isModelSlug(stored['imageModel'])) result.imageModel = stored['imageModel']
  if (isModelSlug(stored['speechModel'])) result.speechModel = stored['speechModel']
  if (stored['videoModel'] === null || isModelSlug(stored['videoModel'])) result.videoModel = stored['videoModel']
  if (typeof stored['videoBudget'] === 'number' && stored['videoBudget'] > 0) result.videoBudget = stored['videoBudget']
  return result
}

export class PreferenceStore {
  private value: Preferences = { ...INITIAL }
  private readonly file: JsonFile<Preferences>
  private readonly listeners = new Set<() => void>()

  constructor(path: string, private readonly configuredModels: () => readonly string[]) {
    this.file = new JsonFile(path, fromDisk)
  }

  get current(): Readonly<Preferences> { return this.value }

  /** Модели пикера: выбор пользователя или, если его нет, список из конфигурации. */
  pickerModels(): readonly string[] {
    return this.value.models ?? this.configuredModels()
  }

  get customized(): boolean { return this.value.models !== undefined }

  watch(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async restore(): Promise<void> {
    const saved = await this.file.read()
    if (saved === undefined) return
    this.value = saved
    this.notify()
  }

  /** Применить изменения из интерфейса; неверные значения отклоняются с понятной ошибкой. */
  async change(patch: Record<string, unknown>): Promise<Preferences> {
    const next: Preferences = { ...this.value }
    if ('models' in patch) next.models = cleanModelList(patch['models'])
    if ('utilityModel' in patch) {
      const model = patch['utilityModel']
      if (model !== null && !isModelSlug(model)) throw new Error('Служебная модель: ожидался идентификатор vendor/model или null')
      next.utilityModel = model
    }
    if ('lowBalance' in patch) {
      const threshold = patch['lowBalance']
      if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) throw new Error('Порог баланса: ожидалось неотрицательное число')
      next.lowBalance = threshold
    }
    if ('imageModel' in patch) {
      const model = patch['imageModel']
      if (model !== null && !isModelSlug(model)) throw new Error('Модель для картинок: ожидался идентификатор vendor/model или null')
      next.imageModel = model
    }
    if ('speechModel' in patch) {
      const model = patch['speechModel']
      if (!isModelSlug(model)) throw new Error('Модель распознавания речи: ожидался идентификатор vendor/model')
      next.speechModel = model
    }
    if ('videoModel' in patch) {
      const model = patch['videoModel']
      if (model !== null && !isModelSlug(model)) throw new Error('Модель для видео: ожидался идентификатор vendor/model или null')
      next.videoModel = model
    }
    if ('videoBudget' in patch) {
      const budget = patch['videoBudget']
      if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) throw new Error('Потолок стоимости ролика: ожидалось положительное число')
      next.videoBudget = budget
    }
    await this.file.write(next)
    this.value = next
    this.notify()
    return next
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
