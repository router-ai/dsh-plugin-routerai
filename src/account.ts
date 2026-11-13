// Что RouterAI знает о текущем ключе: баланс аккаунта (GET /credits) и сам ключ (GET /key).
// Все суммы — в рублях.

/** Ключи RouterAI начинаются с `sk-`, дальше — urlsafe-base64. */
export function looksLikeApiKey(text: string): boolean {
  return /^sk-[\w-]{16,200}$/.test(text)
}

/** Ключ для показа: начало и конец, середина скрыта. */
export function maskApiKey(key: string): string {
  return key.length < 14 ? 'sk-…' : `${key.slice(0, 7)}…${key.slice(-4)}`
}

export interface KeyFacts {
  label: string
  disabled: boolean
  /** Потрачено по ключу за текущий период лимита и за календарный месяц. */
  spent: number
  spentThisMonth: number
  /** Лимит расходов; отсутствует, если ключ без лимита. */
  cap?: { amount: number; left: number; period: 'daily' | 'weekly' | 'monthly' | 'other' }
}

export interface AccountView {
  /** `rejected` — RouterAI не признал ключ (отозван, удалён); `partial` — ответила только часть запросов. */
  state: 'ok' | 'partial' | 'rejected' | 'offline'
  balance?: number
  key?: KeyFacts
  notes: string[]
}

function number(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0
}

function keyFacts(data: Record<string, unknown>): KeyFacts {
  const facts: KeyFacts = {
    label: typeof data['name'] === 'string' ? data['name'] : '',
    disabled: data['disabled'] === true,
    spent: number(data['usage']),
    spentThisMonth: number(data['usage_monthly']),
  }
  // Нулевой лимит в ответе означает «лимита нет».
  const amount = number(data['limit'])
  if (amount > 0) {
    const period = data['limit_reset']
    facts.cap = {
      amount,
      left: Math.max(0, number(data['limit_remaining'])),
      period: period === 'daily' || period === 'weekly' || period === 'monthly' ? period : 'other',
    }
  }
  return facts
}

type Reply = { ok: true; data: Record<string, unknown> } | { ok: false; status: number | undefined; note: string }

async function ask(apiBase: string, path: string, apiKey: string): Promise<Reply> {
  try {
    const response = await fetch(`${apiBase}${path}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return { ok: false, status: response.status, note: `${path} → HTTP ${response.status}` }
    const body = await response.json() as { data?: unknown }
    return { ok: true, data: typeof body.data === 'object' && body.data !== null ? body.data as Record<string, unknown> : {} }
  } catch (error) {
    return { ok: false, status: undefined, note: `${path} → ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function loadAccount(apiBase: string, apiKey: string): Promise<AccountView> {
  const [credits, key] = await Promise.all([ask(apiBase, '/credits', apiKey), ask(apiBase, '/key', apiKey)])
  const view: AccountView = { state: 'ok', notes: [] }
  if (credits.ok) view.balance = number(credits.data['credits'])
  if (key.ok) view.key = keyFacts(key.data)
  const failed = [credits, key].filter((reply): reply is Extract<Reply, { ok: false }> => !reply.ok)
  view.notes = failed.map(reply => reply.note)
  if (failed.some(reply => reply.status === 401 || reply.status === 403)) view.state = 'rejected'
  else if (failed.length === 2) view.state = 'offline'
  else if (failed.length === 1) view.state = 'partial'
  return view
}
