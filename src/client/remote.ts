// Связь браузерной части с серверной (/api/routerai/…) и общее состояние для всех элементов интерфейса.
import { useSyncExternalStore } from 'react'
import type { CatalogEntry, Overview, SessionCostView, SignInStart, WaitingSignIn } from '../bridge.ts'

export type { CatalogEntry, Overview, SessionCostView, WaitingSignIn }

async function request<T>(path: string, body?: unknown): Promise<T> {
  // Адрес считается от document.baseURI: harness может быть открыт не из корня сайта.
  const response = await fetch(new URL(`api/routerai/${path}`, document.baseURI), body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok || payload === null) throw new Error(payload?.error ?? `Сервер ответил ${response.status}`)
  return payload
}

export interface View {
  overview: Overview | null
  /** Ошибка последнего обращения к серверу. */
  failure: string | null
}

const IDLE_REFRESH_MS = 45_000
// Пока ключа нет, он может появиться в любой момент (команда /routerai, переменная окружения) — смотрим чаще.
const DISCONNECTED_REFRESH_MS = 8_000
const WAITING_REFRESH_MS = 1_200

/** Состояние плагина в этой вкладке. Опрашивает сервер редко, а пока идёт вход — часто. */
export class Remote {
  private view: View = { overview: null, failure: null }
  private readonly subscribers = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private catalogRequest: Promise<CatalogEntry[]> | undefined
  private stopped = false

  readonly read = (): View => this.view

  readonly subscribe = (subscriber: () => void): (() => void) => {
    this.subscribers.add(subscriber)
    return () => { this.subscribers.delete(subscriber) }
  }

  /** Запустить опрос; возвращает остановку. */
  run(): () => void {
    void this.pull()
    return () => {
      this.stopped = true
      clearTimeout(this.timer)
    }
  }

  async pull(fresh = false): Promise<void> {
    clearTimeout(this.timer)
    try {
      this.publish({ overview: await request<Overview>(fresh ? 'overview?fresh=1' : 'overview'), failure: null })
    } catch (error) {
      this.publish({ ...this.view, failure: error instanceof Error ? error.message : String(error) })
    }
    if (this.stopped) return
    const waiting = this.view.overview?.signIn.stage === 'waiting'
    const pause = waiting ? WAITING_REFRESH_MS : this.view.overview?.connected === false ? DISCONNECTED_REFRESH_MS : IDLE_REFRESH_MS
    this.timer = setTimeout(() => { void this.pull(waiting) }, pause)
  }

  private publish(view: View): void {
    this.view = view
    for (const subscriber of this.subscribers) subscriber()
  }

  private async act(path: string, body: unknown, fresh = true): Promise<void> {
    await request(path, body)
    await this.pull(fresh)
  }

  /**
   * Начать вход и открыть страницу согласия. Вкладка открывается сразу, по нажатию, а адрес получает позже:
   * окно, открытое после ожидания ответа, браузер заблокировал бы как всплывающее.
   * `byCode` — пользователь сам выбрал вход по коду.
   */
  signIn = async (byCode = false): Promise<void> => {
    const tab = embedded() ? null : window.open('', '_blank')
    try {
      // Интерфейс открыт с другой машины — локальный приёмник плагина браузеру заведомо не виден.
      const start = await request<SignInStart>('sign-in', { receiver: !byCode && onThisMachine() })
      let target = start.url
      if (target === null || byCode || !(embedded() || await receiverVisible(start))) {
        await request('sign-in/by-code', {})
        target = start.codeUrl
      }
      show(tab, target)
    } catch (error) {
      tab?.close()
      throw error
    } finally {
      await this.pull(false)
    }
  }

  /** Приёмник не помог (страница возврата не открылась) — перейти на вход по коду в уже начатой попытке. */
  useCode = async (codeUrl: string): Promise<void> => {
    openTab(codeUrl)
    await this.act('sign-in/by-code', {}, false)
  }

  submitCode = (value: string) => this.act('sign-in/code', { value })
  cancelSignIn = () => this.act('sign-in/cancel', {}, false)
  signOut = () => this.act('sign-out', {})
  saveKey = (key: string) => this.act('key', { key })
  savePreferences = (patch: { models?: readonly string[]; utilityModel?: string | null; lowBalance?: number; imageModel?: string | null; speechModel?: string; videoModel?: string | null; videoBudget?: number; imageChoices?: readonly string[]; videoChoices?: readonly string[]; voiceModel?: string | null; voice?: string }) => this.act('preferences', patch, false)

  /** Каталог запрашивается один раз за жизнь вкладки. */
  catalog(): Promise<CatalogEntry[]> {
    this.catalogRequest ??= request<{ models: CatalogEntry[] }>('catalog').then(reply => reply.models)
    this.catalogRequest.catch(() => { this.catalogRequest = undefined })
    return this.catalogRequest
  }

  async sessionCost(sessionId: string): Promise<SessionCostView | null> {
    return (await request<{ cost: SessionCostView | null }>(`session-cost?id=${encodeURIComponent(sessionId)}`)).cost
  }
}

export function useRemote(remote: Remote): View {
  return useSyncExternalStore(remote.subscribe, remote.read)
}

export function openTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Десктопное приложение: страница загружена не по http(s), ссылки оно отдаёт системному браузеру. */
function embedded(): boolean {
  return !/^https?:$/u.test(window.location.protocol)
}

/** Интерфейс открыт по локальному адресу — приёмник плагина может быть виден браузеру. */
function onThisMachine(): boolean {
  return embedded() || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname)
}

const PING_LIMIT_MS = 2000

/**
 * Достаёт ли браузер до локального приёмника плагина. Когда harness работает в контейнере или на другой машине,
 * интерфейс всё равно может быть открыт по 127.0.0.1 (проброшен только его порт), а приёмник — нет.
 * Сверяется метка попытки: на этом порту у пользователя может слушать посторонняя программа.
 */
async function receiverVisible(start: SignInStart): Promise<boolean> {
  if (start.port === null) return false
  try {
    const response = await fetch(`http://127.0.0.1:${start.port}/routerai/ping`, { cache: 'no-store', signal: AbortSignal.timeout(PING_LIMIT_MS) })
    const reply = await response.json() as { attempt?: unknown }
    return reply.attempt === start.attempt
  } catch {
    return false
  }
}

/** Загрузить адрес в заранее открытую вкладку; если её нет или её заблокировали — открыть обычным способом. */
function show(tab: Window | null, url: string): void {
  if (tab === null || tab.closed) {
    openTab(url)
    return
  }
  tab.opener = null
  tab.location.replace(url)
}
