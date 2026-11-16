// Вход через браузер. RouterAI поддерживает выдачу ключа приложению по схеме
// «код авторизации + PKCE»: пользователь подтверждает доступ на routerai.ru/auth,
// браузер возвращается на локальный адрес с кодом, код меняется на ключ в POST /auth/keys.
// Когда браузеру локальный адрес недоступен (harness в контейнере, на другой машине), страница
// согласия открывается без адреса возврата: код показан на ней, и пользователь вставляет его сам.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Под этим именем приложение видно пользователю на странице согласия. RouterAI привязывает
 * выданный ключ к имени приложения и при повторном входе перевыпускает его, а не создаёт новый,
 * поэтому имя должно оставаться постоянным.
 */
export const CLIENT_NAME = 'DeepSeek Harness'

const WAIT_LIMIT_MS = 15 * 60_000
const RETURN_PATH = '/routerai/return'
const PING_PATH = '/routerai/ping'

const urlSafe = (bytes: Buffer): string => bytes.toString('base64url')

export interface Challenge {
  /** Секрет, который знает только этот процесс; предъявляется при обмене кода. */
  secret: string
  /** SHA-256 от секрета — уходит на страницу согласия. */
  digest: string
  /** Метка запроса: по ней ответ браузера сверяется с начатым входом. */
  ticket: string
}

export function newChallenge(): Challenge {
  const secret = urlSafe(randomBytes(40))
  return { secret, digest: urlSafe(createHash('sha256').update(secret).digest()), ticket: urlSafe(randomBytes(18)) }
}

/** Адрес страницы согласия. Она живёт на сайте, а не под /api. Без `returnTo` страница покажет код для ручного ввода. */
export function consentUrl(apiBase: string, challenge: Challenge, returnTo?: string): string {
  const page = new URL('/auth', apiBase)
  page.search = new URLSearchParams({
    app_name: CLIENT_NAME,
    key_label: CLIENT_NAME,
    ...returnTo === undefined ? {} : { callback_url: returnTo },
    code_challenge: challenge.digest,
    code_challenge_method: 'S256',
    ...returnTo === undefined ? {} : { state: challenge.ticket },
  }).toString()
  return page.href
}

/** Отказ RouterAI при обмене кода — понятными словами. */
function redeemProblem(reason: string): string {
  const text = reason.toLowerCase()
  if (text.includes('истёк')) return 'Код устарел: он действует 5 минут. Начните вход заново.'
  if (text.includes('уже использован')) return 'Этот код уже использован. Начните вход заново.'
  if (text.includes('code_verifier') || text.includes('callback_url')) return 'Этот код выдан для другой попытки входа. Начните вход заново и возьмите новый код.'
  if (text.includes('невалидный код')) return 'RouterAI не узнал этот код. Проверьте, что он скопирован целиком.'
  return `RouterAI не выдал ключ: ${reason}`
}

export async function redeemCode(apiBase: string, code: string, challenge: Challenge, returnTo?: string): Promise<string> {
  const response = await fetch(`${apiBase}/auth/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code, code_verifier: challenge.secret, code_challenge_method: 'S256', ...returnTo === undefined ? {} : { callback_url: returnTo } }),
    signal: AbortSignal.timeout(20_000),
  })
  const reply = await response.json().catch(() => ({})) as Record<string, unknown>
  if (response.ok && typeof reply['key'] === 'string' && reply['key'] !== '') return reply['key']
  throw new Error(redeemProblem(String(reply['error_description'] ?? reply['error'] ?? `HTTP ${response.status}`)))
}

/** Что вставил пользователь: код со страницы RouterAI или адрес, на который вернулся браузер. */
export function readPastedCode(input: string): { code: string; state?: string; fromAddress: boolean } {
  const text = input.replace(/\s+/g, '')
  if (text === '') throw new Error('Вставьте код со страницы RouterAI.')
  if (!/^https?:\/\//i.test(text)) {
    if (text.startsWith('sk-')) throw new Error('Это ключ, а не код входа. Ключ сохраняется в поле «Уже есть ключ?».')
    return { code: text, fromAddress: false }
  }
  let address: URL
  try {
    address = new URL(text)
  } catch {
    throw new Error('Не удалось разобрать адрес. Скопируйте его из адресной строки целиком.')
  }
  if (address.searchParams.get('error') === 'access_denied') throw new Error('Вы отклонили доступ на странице RouterAI.')
  const code = address.searchParams.get('code')
  if (code === null || code === '') throw new Error('В этом адресе нет кода входа. Скопируйте адрес вкладки, которая открылась после подтверждения.')
  const state = address.searchParams.get('state')
  return { code, fromAddress: true, ...state === null ? {} : { state } }
}

function answer(response: ServerResponse, status: number, headline: string, detail: string): void {
  const safe = (text: string) => text.replace(/[<>&"]/g, symbol => `&#${symbol.charCodeAt(0)};`)
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>RouterAI</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f5f7fb;color:#1b2333">
<main style="max-width:28rem;padding:2rem;text-align:center"><h1 style="font-size:1.4rem">${safe(headline)}</h1><p>${safe(detail)}</p></main></body></html>`)
}

export interface SignInOptions {
  /** Поднимать ли локальный приёмник. Без него остаётся только вход по коду. */
  receiver?: boolean
  /** Порт приёмника; 0 — выбирает система. */
  port?: number
  /** Адрес, на котором слушает приёмник. */
  host?: string
}

export interface PendingSignIn {
  /** Страница согласия с возвратом в приёмник; `null`, когда приёмника нет. */
  url: string | null
  /** Страница согласия, которая покажет код для ручного ввода. */
  codeUrl: string
  /** Метка попытки: по ней интерфейс узнаёт свой приёмник. Не секрет. */
  attempt: string
  /** Порт приёмника на 127.0.0.1. */
  port: number | null
  /** Почему приёмник не поднялся, если его просили. */
  receiverProblem: string | null
  /** Ключ — когда пользователь подтвердит доступ; отказ, отмена и тайм-аут дают ошибку. */
  key: Promise<string>
  /** Обменять вставленный код или адрес на ключ. Ошибка обмена попытку не завершает: код можно вставить ещё раз. */
  submit(input: string): Promise<void>
  cancel(): void
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

/** Начать вход: поднять локальный приёмник ответа (если нужен) и вернуть адреса страницы согласия. */
export async function startSignIn(apiBase: string, options: SignInOptions = {}): Promise<PendingSignIn> {
  const challenge = newChallenge()
  const attempt = urlSafe(randomBytes(12))
  let returnTo: string | undefined
  let settled = false
  // Один и тот же код нельзя предъявлять дважды: он одноразовый, повтор может отключить уже выданный ключ.
  const seen = new Set<string>()
  let finish: (outcome: { key: string } | { error: Error }) => void = () => {}
  const key = new Promise<string>((resolve, reject) => {
    finish = (outcome) => {
      settled = true
      if ('key' in outcome) resolve(outcome.key)
      else reject(outcome.error)
    }
  })
  // Вход может быть отменён, пока его результата никто не ждёт.
  key.catch(() => {})

  const redeem = async (code: string, withReturn: boolean): Promise<string> => {
    if (settled) throw new Error('Этот вход уже завершён.')
    if (seen.has(code)) throw new Error('Этот код уже был отправлен. Начните вход заново, если ключ не появился.')
    seen.add(code)
    try {
      return await redeemCode(apiBase, code, challenge, withReturn ? returnTo : undefined)
    } catch (error) {
      // Запрос не дошёл до RouterAI — код не предъявлен, его можно отправить ещё раз.
      if (error instanceof Error && (error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError')) {
        seen.delete(code)
        throw new Error('Не удалось связаться с RouterAI. Проверьте сеть и отправьте код ещё раз.', { cause: error })
      }
      throw error
    }
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const target = new URL(request.url ?? '/', returnTo)
    if (target.pathname === PING_PATH) {
      // Интерфейс проверяет, виден ли приёмник из браузера. В ответе только метка попытки.
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      response.end(JSON.stringify({ attempt }))
      return
    }
    if (target.pathname !== RETURN_PATH) {
      answer(response, 404, 'Страница не найдена', 'Этот адрес служит только для возврата со страницы входа RouterAI.')
      return
    }
    try {
      if (target.searchParams.get('state') !== challenge.ticket) throw new Error('Ответ не относится к начатому входу. Запустите вход ещё раз.')
      if (target.searchParams.get('error') === 'access_denied') throw new Error('Вы отклонили доступ на странице RouterAI.')
      const code = target.searchParams.get('code')
      if (code === null || code === '') throw new Error(`RouterAI вернул ошибку: ${target.searchParams.get('error') ?? 'нет кода авторизации'}`)
      const issued = await redeem(code, true)
      answer(response, 200, 'Готово', 'Ключ RouterAI сохранён в DeepSeek Harness. Эту вкладку можно закрыть.')
      finish({ key: issued })
    } catch (error) {
      const problem = error instanceof Error ? error : new Error(String(error))
      answer(response, 400, 'Войти не получилось', problem.message)
      if (!settled) finish({ error: problem })
    }
  }

  let server: Server | undefined
  let port: number | null = null
  let receiverProblem: string | null = null
  if (options.receiver !== false) {
    server = createServer((request, response) => { void handle(request, response) })
    try {
      // Порт по умолчанию выбирает система; слушаем только локальный интерфейс.
      await listen(server, options.port ?? 0, options.host ?? '127.0.0.1')
      port = (server.address() as AddressInfo).port
      // Адрес возврата всегда локальный: другой http-адрес RouterAI не примет.
      returnTo = `http://127.0.0.1:${port}${RETURN_PATH}`
    } catch (error) {
      server = undefined
      const code = (error as NodeJS.ErrnoException).code
      receiverProblem = code === 'EADDRINUSE'
        ? `Порт ${options.port ?? 0} для возврата со страницы входа занят другой программой.`
        : `Не удалось открыть порт для возврата со страницы входа: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const timeout = setTimeout(() => { finish({ error: new Error('Вход не был подтверждён за 15 минут.') }) }, WAIT_LIMIT_MS)
  const shutdown = () => {
    clearTimeout(timeout)
    server?.close()
    server?.closeAllConnections()
  }
  void key.then(shutdown, shutdown)

  return {
    url: returnTo === undefined ? null : consentUrl(apiBase, challenge, returnTo),
    codeUrl: consentUrl(apiBase, challenge),
    attempt,
    port,
    receiverProblem,
    key,
    submit: async (input) => {
      const pasted = readPastedCode(input)
      if (pasted.fromAddress && pasted.state !== undefined && pasted.state !== challenge.ticket) throw new Error('Этот адрес относится к другой попытке входа. Начните вход заново.')
      // Код из адреса выдан для адреса приёмника, код со страницы — без адреса возврата.
      finish({ key: await redeem(pasted.code, pasted.fromAddress && returnTo !== undefined) })
    },
    cancel: () => { if (!settled) finish({ error: new Error('Вход отменён.') }) },
  }
}

/** Как на этой системе открыть адрес в браузере по умолчанию. */
export function browserLauncher(url: string, platform: NodeJS.Platform = process.platform): { program: string; args: string[] } {
  if (platform === 'win32') {
    // Без оболочки: cmd.exe обрезал бы адрес на первом же «&».
    return { program: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  }
  return { program: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] }
}

/**
 * Попытаться открыть браузер. `false` — открыть нечем: программы нет или она сразу завершилась с ошибкой
 * (сервер без графической среды, контейнер).
 */
export function openBrowser(url: string, graceMs = 1500): Promise<boolean> {
  const { program, args } = browserLauncher(url)
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true })
      const timer = setTimeout(() => { resolve(true) }, graceMs)
      const settle = (opened: boolean) => {
        clearTimeout(timer)
        resolve(opened)
      }
      child.once('error', () => { settle(false) })
      // Код завершения rundll32 ничего не значит, поэтому по нему судим только вне Windows.
      child.once('exit', (code) => { settle(process.platform === 'win32' || code === 0) })
      child.unref()
    } catch {
      resolve(false)
    }
  })
}
