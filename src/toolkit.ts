// Общее для инструментов рисования и видео: регистрация, которая следит за выбранной моделью.
// Описание инструмента — единственное, что агент знает о его возможностях, поэтому оно собирается
// под выбранную модель и обновляется, когда меняется модель или приходит свежий каталог.
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export interface LiveToolOptions {
  /** Собрать определение инструмента для текущего состояния. */
  build(): ToolDefinition
  /** Всё, от чего зависит описание; пока строка не изменилась, инструмент не трогаем. */
  signature(): string
  /** Доступен ли инструмент агенту на этом шаге. */
  enabled(): boolean
  /** Подписка на изменения настроек и каталога; возвращает отписку. */
  watch(listener: () => void): () => void
  label: string
}

export function registerLiveTool(ctx: Context, options: LiveToolOptions): void {
  ctx.effect(() => {
    let current: string | undefined
    let unregister: (() => void) | undefined
    const sync = () => {
      const next = options.signature()
      if (next === current) return
      unregister?.()
      current = next
      unregister = ctx.tools.register(options.build(), { when: () => options.enabled() })
    }
    sync()
    const stop = options.watch(sync)
    return () => {
      stop()
      unregister?.()
    }
  }, options.label)
}

/**
 * Допустимые значения для описания параметра; пусто, если модель ограничений не сообщает.
 * Строки даются в кавычках, как их нужно записать в аргументах: слабые модели иначе пишут 480p без кавычек
 * и получают некорректный JSON.
 */
export function allowedHint(values: readonly (string | number)[] | undefined, unit = ''): string {
  if (values === undefined || values.length === 0) return ''
  return ` Допустимо: ${values.map(value => (typeof value === 'string' ? JSON.stringify(value) : String(value))).join(', ')}${unit}.`
}

/** Модели, между которыми агент может выбирать: основная из настроек плюс разрешённые пользователем. */
export interface ModelMenu<Card> {
  /** Основная модель — используется, когда агент не выбирал. */
  main: string
  /** Все разрешённые модели, основная первой. */
  allowed: string[]
  cards: Map<string, Card>
}

export function buildMenu<Card>(main: string, extras: readonly string[], find: (slug: string) => Card | undefined, fits: (card: Card) => boolean): ModelMenu<Card> {
  const cards = new Map<string, Card>()
  const allowed = [main]
  const mainCard = find(main)
  if (mainCard !== undefined) cards.set(main, mainCard)
  for (const slug of extras) {
    const card = find(slug)
    // В меню попадают только модели, которые каталог знает и которые подходят инструменту.
    if (slug === main || card === undefined || !fits(card)) continue
    allowed.push(slug)
    cards.set(slug, card)
  }
  return { main, allowed, cards }
}

/** Какую модель взять: выбор агента, если он из меню, иначе основную — с пояснением. */
export function pickModel(menu: ModelMenu<unknown>, wish: string | undefined): { model: string; note?: string } {
  if (wish === undefined || wish.trim() === '' || wish === menu.main) return { model: menu.main }
  if (menu.allowed.includes(wish)) return { model: wish }
  return { model: menu.main, note: `Модель ${wish} не разрешена в настройках — использована ${menu.main}` }
}
