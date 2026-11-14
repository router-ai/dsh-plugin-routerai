// Стоимость сессий в рублях. Harness сообщает плагину только число токенов каждого вызова,
// поэтому сумма — расчёт по ценам каталога, а не списание RouterAI.
import type { ModelCard } from './catalog.ts'
import { JsonFile } from './storage.ts'

/** Счётчики токенов одного вызова, как их отдаёт harness. */
export interface CallTokens {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface SessionCost {
  /** Сумма по всем вызовам сессии, ₽. */
  total: number
  calls: number
  /** Вызовы моделей без цены в каталоге — в сумму не вошли. */
  unpriced: number
  last: { model: string; rub: number } | null
  tokens: { input: number; cached: number; cacheWrites: number; output: number }
  /** Сколько вызовов и рублей пришлось на каждую модель. */
  perModel: Record<string, { calls: number; rub: number }>
  touchedAt: number
}

/** Стоимость одного вызова по цене модели; undefined, если цены нет. */
export function priceCall(card: ModelCard | undefined, tokens: CallTokens): number | undefined {
  const price = card?.price
  if (price === undefined) return undefined
  const million = 1_000_000
  return (
    (tokens.inputTokens ?? 0) * price.input
    + (tokens.cacheReadTokens ?? 0) * (price.cachedInput ?? price.input)
    + (tokens.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)
    + (tokens.outputTokens ?? 0) * price.output
  ) / million
}

/** Какая часть входа пришла из кэша; undefined, пока входа не было. */
export function cachedShare(tokens: SessionCost['tokens']): number | undefined {
  const input = tokens.input + tokens.cached + tokens.cacheWrites
  return input > 0 ? tokens.cached / input : undefined
}

const KEEP_SESSIONS = 300
const FLUSH_AFTER_MS = 1500

function blank(): SessionCost {
  return { total: 0, calls: 0, unpriced: 0, last: null, tokens: { input: 0, cached: 0, cacheWrites: 0, output: 0 }, perModel: {}, touchedAt: 0 }
}

type Book = Record<string, SessionCost>

export class CostBook {
  private sessions = new Map<string, SessionCost>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly file: JsonFile<Book>

  constructor(path: string, private readonly onWriteError: (error: unknown) => void = () => {}) {
    this.file = new JsonFile<Book>(path, raw => (typeof raw === 'object' && raw !== null ? raw as Book : undefined))
  }

  async restore(): Promise<void> {
    const saved = await this.file.read()
    if (saved !== undefined) this.sessions = new Map(Object.entries(saved))
  }

  of(sessionId: string): SessionCost | undefined {
    return this.sessions.get(sessionId)
  }

  /** Учесть вызов чат-модели. */
  addCall(sessionId: string, model: string, card: ModelCard | undefined, tokens: CallTokens): void {
    const rub = priceCall(card, tokens)
    const entry = this.open(sessionId)
    entry.calls += 1
    if (rub === undefined) entry.unpriced += 1
    entry.total += rub ?? 0
    entry.last = { model, rub: rub ?? 0 }
    entry.tokens.input += tokens.inputTokens ?? 0
    entry.tokens.cached += tokens.cacheReadTokens ?? 0
    entry.tokens.cacheWrites += tokens.cacheWriteTokens ?? 0
    entry.tokens.output += tokens.outputTokens ?? 0
    const share = entry.perModel[model] ?? { calls: 0, rub: 0 }
    entry.perModel[model] = { calls: share.calls + 1, rub: share.rub + (rub ?? 0) }
    this.close(sessionId, entry)
  }

  /** Учесть готовую сумму — например, картинку: RouterAI сам сообщает её стоимость. */
  addCharge(sessionId: string, model: string, rub: number): void {
    const entry = this.open(sessionId)
    entry.total += rub
    entry.last = { model, rub }
    const share = entry.perModel[model] ?? { calls: 0, rub: 0 }
    entry.perModel[model] = { calls: share.calls + 1, rub: share.rub + rub }
    this.close(sessionId, entry)
  }

  private open(sessionId: string): SessionCost {
    const existing = this.sessions.get(sessionId)
    return existing === undefined ? blank() : structuredClone(existing)
  }

  private close(sessionId: string, entry: SessionCost): void {
    entry.touchedAt = Date.now()
    // Перевставка держит недавние сессии в конце: при переполнении уходят самые давние.
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, entry)
    for (const stale of this.sessions.keys()) {
      if (this.sessions.size <= KEEP_SESSIONS) break
      this.sessions.delete(stale)
    }
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => { void this.flush() }, FLUSH_AFTER_MS)
  }

  async flush(): Promise<void> {
    clearTimeout(this.flushTimer)
    try {
      await this.file.write(Object.fromEntries(this.sessions))
    } catch (error) {
      this.onWriteError(error)
    }
  }
}
