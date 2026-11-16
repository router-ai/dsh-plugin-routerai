// Мост между браузерной частью плагина и его серверной частью: несколько HTTP-адресов под
// /api/routerai/. Harness сам проверяет, что запрос пришёл от владельца, — сюда доходят только свои.
import { loadAccount, looksLikeApiKey, maskApiKey } from './account.ts'
import type { AccountView } from './account.ts'
import type { ModelCard, ModelCatalog } from './catalog.ts'
import { cachedShare } from './costs.ts'
import type { CostBook, SessionCost } from './costs.ts'
import type { MoneyProblem } from './failures.ts'
import type { PreferenceStore } from './preferences.ts'
import { startSignIn } from './signin.ts'
import type { PendingSignIn } from './signin.ts'

export const BRIDGE_ROOT = '/api/routerai'

const ACCOUNT_FRESH_MS = 30_000
const PROBLEM_SHOWN_MS = 20 * 60_000
const BODY_LIMIT = 100_000

/** Сводка для интерфейса: одна на все его части. */
export interface Overview {
  connected: boolean
  keyMask: string | null
  signIn: { stage: 'idle' } | WaitingSignIn | { stage: 'failed'; reason: string }
  account: AccountView | null
  picker: { models: string[]; custom: boolean }
  utilityModel: string | null
  lowBalance: number
  imageModel: string | null
  speechModel: string
  videoModel: string | null
  videoBudget: number
  imageChoices: string[]
  videoChoices: string[]
  voiceModel: string | null
  voice: string
  problem: MoneyProblem | null
}

/** Вход начат и ждёт пользователя. */
export interface WaitingSignIn {
  stage: 'waiting'
  /** Страница согласия с возвратом в локальный приёмник; `null`, когда приёмника нет. */
  url: string | null
  /** Страница согласия, которая покажет код для ручного ввода. */
  codeUrl: string
  /** Интерфейс ждёт код от пользователя, а не возврата браузера. */
  byCode: boolean
  /** Почему обычный вход недоступен (например, занят порт). */
  notice: string | null
}

/** Ответ на начало входа: всё, что нужно интерфейсу, чтобы открыть страницу и проверить приёмник. */
export interface SignInStart extends WaitingSignIn {
  attempt: string
  port: number | null
}

export type CatalogEntry = ModelCard

export type SessionCostView = SessionCost & { cachedShare: number | null }

export interface BridgeDeps {
  apiBase: string
  readKey(): Promise<string | undefined>
  storeKey(key: string): Promise<void>
  forgetKey(): Promise<void>
  catalog: ModelCatalog
  preferences: PreferenceStore
  costs: CostBook
  warn(message: string): void
  /** Порт и адрес локального приёмника возврата со страницы входа. */
  signInPort?: number
  signInHost?: string
}

export interface BridgeEndpoint {
  path: string
  methods: ('GET' | 'POST')[]
  fetch(request: Request): Promise<Response>
}

export class Bridge {
  private signIn: Overview['signIn'] = { stage: 'idle' }
  private pending: PendingSignIn | undefined
  /** Завершение текущей попытки вместе с сохранением ключа. */
  private settling: Promise<void> = Promise.resolve()
  private accountCache: { forKey: string; at: number; view: AccountView } | undefined
  private problem: MoneyProblem | null = null

  constructor(private readonly deps: BridgeDeps) {}

  /** RouterAI отказал из-за денег — интерфейс покажет предупреждение. */
  noteProblem(problem: MoneyProblem): void {
    this.problem = problem
    this.accountCache = undefined
  }

  /** Вызов прошёл — предупреждение о деньгах больше не актуально. */
  noteSuccess(): void {
    this.problem = null
  }

  async overview(fresh: boolean): Promise<Overview> {
    const key = await this.deps.readKey()
    const preferences = this.deps.preferences
    return {
      connected: key !== undefined,
      keyMask: key === undefined ? null : maskApiKey(key),
      signIn: this.signIn,
      account: key === undefined ? null : await this.account(key, fresh),
      picker: { models: [...preferences.pickerModels()], custom: preferences.customized },
      utilityModel: preferences.current.utilityModel,
      lowBalance: preferences.current.lowBalance,
      imageModel: preferences.current.imageModel,
      speechModel: preferences.current.speechModel,
      videoModel: preferences.current.videoModel,
      videoBudget: preferences.current.videoBudget,
      imageChoices: preferences.current.imageChoices,
      videoChoices: preferences.current.videoChoices,
      voiceModel: preferences.current.voiceModel,
      voice: preferences.current.voice,
      problem: this.problem !== null && Date.now() - this.problem.at < PROBLEM_SHOWN_MS ? this.problem : null,
    }
  }

  private async account(key: string, fresh: boolean): Promise<AccountView> {
    const cached = this.accountCache
    if (!fresh && cached !== undefined && cached.forKey === key && Date.now() - cached.at < ACCOUNT_FRESH_MS) return cached.view
    const view = await loadAccount(this.deps.apiBase, key)
    this.accountCache = { forKey: key, at: Date.now(), view }
    return view
  }

  /**
   * Начать вход. Страницу согласия открывает интерфейс. `receiver: false` — сразу вход по коду:
   * интерфейс открыт с другой машины, локальный приёмник браузеру не виден.
   */
  private async beginSignIn(receiver: boolean): Promise<SignInStart> {
    this.pending?.cancel()
    const attempt = await startSignIn(this.deps.apiBase, {
      receiver,
      ...this.deps.signInPort === undefined ? {} : { port: this.deps.signInPort },
      ...this.deps.signInHost === undefined ? {} : { host: this.deps.signInHost },
    })
    this.pending = attempt
    const waiting: WaitingSignIn = { stage: 'waiting', url: attempt.url, codeUrl: attempt.codeUrl, byCode: attempt.url === null, notice: attempt.receiverProblem }
    this.signIn = waiting
    this.settling = attempt.key.then(
      async (key) => {
        await this.deps.storeKey(key)
        this.accountCache = undefined
        this.problem = null
        if (this.pending === attempt) this.signIn = { stage: 'idle' }
      },
      (error: unknown) => {
        // Отменённую попытку уже сменила новая или сброс — её исход не показываем.
        if (this.pending !== attempt) return
        const reason = error instanceof Error ? error.message : String(error)
        this.signIn = { stage: 'failed', reason }
        this.deps.warn(`вход не завершён: ${reason}`)
      },
    ).finally(() => { if (this.pending === attempt) this.pending = undefined })
    return { ...waiting, attempt: attempt.attempt, port: attempt.port }
  }

  /** Приёмник из браузера не виден или пользователь сам выбрал вход по коду. */
  private switchToCode(): void {
    if (this.signIn.stage === 'waiting') this.signIn = { ...this.signIn, byCode: true }
  }

  private async submitCode(value: string): Promise<void> {
    const attempt = this.pending
    if (attempt === undefined) throw new Error('Вход не начат или уже завершён. Начните заново.')
    const settling = this.settling
    await attempt.submit(value)
    // Ключ сохраняет обработчик попытки; дожидаемся его, чтобы ответ ушёл уже с ключом.
    await settling
  }

  private abandonSignIn(): void {
    const attempt = this.pending
    this.pending = undefined
    this.signIn = { stage: 'idle' }
    attempt?.cancel()
  }

  endpoints(): BridgeEndpoint[] {
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
    const input = async (request: Request): Promise<Record<string, unknown>> => {
      const text = await request.text()
      if (text.length > BODY_LIMIT) throw new Error('Слишком большой запрос')
      const parsed: unknown = text === '' ? {} : JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Ожидался JSON-объект')
      return parsed as Record<string, unknown>
    }
    const param = (request: Request, name: string) => new URL(request.url).searchParams.get(name)

    const handlers: Record<string, ['GET' | 'POST', (request: Request) => Promise<unknown>]> = {
      overview: ['GET', request => this.overview(param(request, 'fresh') === '1')],
      catalog: ['GET', async () => {
        await this.deps.catalog.sync()
        return { models: this.deps.catalog.all() satisfies CatalogEntry[] }
      }],
      'session-cost': ['GET', async (request) => {
        const cost = this.deps.costs.of(param(request, 'id') ?? '')
        return { cost: cost === undefined ? null : { ...cost, cachedShare: cachedShare(cost.tokens) ?? null } satisfies SessionCostView }
      }],
      'sign-in': ['POST', async request => this.beginSignIn((await input(request))['receiver'] !== false)],
      'sign-in/by-code': ['POST', async () => { this.switchToCode(); return {} }],
      'sign-in/code': ['POST', async (request) => {
        await this.submitCode(String((await input(request))['value'] ?? ''))
        return {}
      }],
      'sign-in/cancel': ['POST', async () => { this.abandonSignIn(); return {} }],
      'sign-out': ['POST', async () => {
        this.abandonSignIn()
        await this.deps.forgetKey()
        this.accountCache = undefined
        return {}
      }],
      key: ['POST', async (request) => {
        const key = String((await input(request))['key'] ?? '').trim()
        if (!looksLikeApiKey(key)) throw new Error('Это не похоже на ключ RouterAI: он начинается с sk-')
        await this.deps.storeKey(key)
        this.accountCache = undefined
        this.problem = null
        return {}
      }],
      preferences: ['POST', async (request) => {
        await this.deps.preferences.change(await input(request))
        return {}
      }],
    }

    return Object.entries(handlers).map(([name, [method, handler]]) => ({
      path: `${BRIDGE_ROOT}/${name}`,
      methods: [method],
      fetch: async (request: Request) => {
        try {
          return reply(await handler(request))
        } catch (error) {
          return reply({ error: error instanceof Error ? error.message : String(error) }, 400)
        }
      },
    }))
  }
}
