// Отказы RouterAI из-за денег. Машинных кодов у API нет, поэтому причина определяется
// по HTTP-статусу и тексту ответа, а пользователю показывается, что с этим делать.
import { BILLING_PAGE, KEYS_PAGE } from './links.ts'

export type MoneyProblemKind = 'no-funds' | 'key-cap' | 'key-off'

export interface MoneyProblem {
  kind: MoneyProblemKind
  /** Готовый текст для пользователя. */
  text: string
  at: number
}

const SIGNS: readonly [MoneyProblemKind, RegExp][] = [
  ['key-off', /api key is disabled/i],
  ['key-cap', /spending limit exceeded/i],
  ['no-funds', /недостаточно средств|insufficient balance/i],
]

export function recognize(failure: { message: string; status?: number | undefined }): MoneyProblemKind | undefined {
  for (const [kind, pattern] of SIGNS) {
    if (pattern.test(failure.message)) return kind
  }
  // 402 RouterAI отдаёт только при пустом балансе, даже если текст изменится.
  return failure.status === 402 ? 'no-funds' : undefined
}

export function explain(kind: MoneyProblemKind, original: string): string {
  switch (kind) {
    case 'no-funds':
      return `На балансе RouterAI закончились деньги. Пополнить счёт: ${BILLING_PAGE}`
    case 'key-off':
      return `Этот ключ RouterAI отключён. Включить его можно на ${KEYS_PAGE}, получить новый — командой /routerai login`
    case 'key-cap': {
      const numbers = /exceeded:\s*([\d.]+)\s*\/\s*([\d.]+)/i.exec(original)
      const spent = numbers === null ? '' : ` (потрачено ${numbers[1]} ₽ из ${numbers[2]} ₽)`
      return `Ключ RouterAI упёрся в свой лимит расходов${spent}. Лимит меняется на ${KEYS_PAGE}; команда /routerai login выдаст ключ с новым лимитом`
    }
  }
}

export function describeProblem(failure: { message: string; status?: number | undefined }): MoneyProblem | undefined {
  const kind = recognize(failure)
  return kind === undefined ? undefined : { kind, text: explain(kind, failure.message), at: Date.now() }
}
