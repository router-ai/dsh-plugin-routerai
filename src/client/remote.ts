// Связь браузерной части с серверной (/api/routerai/…) и общее состояние для всех элементов интерфейса.
import { useSyncExternalStore } from 'react'
import type { CatalogEntry, Overview, SessionCostView } from '../bridge.ts'

export type { CatalogEntry, Overview, SessionCostView }

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

  signIn = () => this.act('sign-in', {}, false)
  cancelSignIn = () => this.act('sign-in/cancel', {}, false)
  signOut = () => this.act('sign-out', {})
  saveKey = (key: string) => this.act('key', { key })
  savePreferences = (patch: { models?: readonly string[]; utilityModel?: string | null; lowBalance?: number; imageModel?: string | null; speechModel?: string }) => this.act('preferences', patch, false)

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
