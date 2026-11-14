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

/** «(допустимо: a, b, c)» для описания параметра; пусто, если модель ограничений не сообщает. */
export function allowedHint(values: readonly (string | number)[] | undefined, unit = ''): string {
  return values === undefined || values.length === 0 ? '' : ` Допустимо: ${values.join(', ')}${unit}.`
}
