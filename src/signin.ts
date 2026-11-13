// Вход через браузер. RouterAI поддерживает выдачу ключа приложению по схеме
// «код авторизации + PKCE»: пользователь подтверждает доступ на routerai.ru/auth,
// браузер возвращается на локальный адрес с кодом, код меняется на ключ в POST /auth/keys.
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

/** Адрес страницы согласия. Она живёт на сайте, а не под /api. */
export function consentUrl(apiBase: string, challenge: Challenge, returnTo: string): string {
  const page = new URL('/auth', apiBase)
  page.search = new URLSearchParams({
    app_name: CLIENT_NAME,
    key_label: CLIENT_NAME,
    callback_url: returnTo,
    code_challenge: challenge.digest,
    code_challenge_method: 'S256',
    state: challenge.ticket,
  }).toString()
  return page.href
}

export async function redeemCode(apiBase: string, code: string, challenge: Challenge, returnTo: string): Promise<string> {
  const response = await fetch(`${apiBase}/auth/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code, code_verifier: challenge.secret, code_challenge_method: 'S256', callback_url: returnTo }),
    signal: AbortSignal.timeout(20_000),
  })
  const reply = await response.json().catch(() => ({})) as Record<string, unknown>
  if (response.ok && typeof reply['key'] === 'string' && reply['key'] !== '') return reply['key']
  const reason = reply['error_description'] ?? reply['error'] ?? `HTTP ${response.status}`
  throw new Error(`RouterAI не выдал ключ: ${String(reason)}`)
}

function answer(response: ServerResponse, status: number, headline: string, detail: string): void {
  const safe = (text: string) => text.replace(/[<>&"]/g, symbol => `&#${symbol.charCodeAt(0)};`)
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>RouterAI</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f5f7fb;color:#1b2333">
<main style="max-width:28rem;padding:2rem;text-align:center"><h1 style="font-size:1.4rem">${safe(headline)}</h1><p>${safe(detail)}</p></main></body></html>`)
}

export interface PendingSignIn {
  /** Эту страницу нужно открыть в браузере. */
  url: string
  /** Ключ — когда пользователь подтвердит доступ; отказ, отмена и тайм-аут дают ошибку. */
  key: Promise<string>
  cancel(): void
}

/** Начать вход: поднять локальный приёмник ответа и вернуть адрес страницы согласия. */
export async function startSignIn(apiBase: string): Promise<PendingSignIn> {
  const challenge = newChallenge()
  let returnTo = ''
  let finish: (outcome: { key: string } | { error: Error }) => void = () => {}
  const key = new Promise<string>((resolve, reject) => {
    finish = outcome => ('key' in outcome ? resolve(outcome.key) : reject(outcome.error))
  })
  // Вход может быть отменён, пока его результата никто не ждёт.
  key.catch(() => {})

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const target = new URL(request.url ?? '/', returnTo)
    if (target.pathname !== RETURN_PATH) {
      answer(response, 404, 'Страница не найдена', 'Этот адрес служит только для возврата со страницы входа RouterAI.')
      return
    }
    try {
      if (target.searchParams.get('state') !== challenge.ticket) throw new Error('Ответ не относится к начатому входу. Запустите вход ещё раз.')
      if (target.searchParams.get('error') === 'access_denied') throw new Error('Вы отклонили доступ на странице RouterAI.')
      const code = target.searchParams.get('code')
      if (code === null || code === '') throw new Error(`RouterAI вернул ошибку: ${target.searchParams.get('error') ?? 'нет кода авторизации'}`)
      const issued = await redeemCode(apiBase, code, challenge, returnTo)
      answer(response, 200, 'Готово', 'Ключ RouterAI сохранён в DeepSeek Harness. Эту вкладку можно закрыть.')
      finish({ key: issued })
    } catch (error) {
      const problem = error instanceof Error ? error : new Error(String(error))
      answer(response, 400, 'Войти не получилось', problem.message)
      finish({ error: problem })
    }
  }

  const server: Server = createServer((request, response) => { void handle(request, response) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Порт выбирает система; слушаем только локальный интерфейс.
    server.listen(0, '127.0.0.1', resolve)
  })
  returnTo = `http://127.0.0.1:${(server.address() as AddressInfo).port}${RETURN_PATH}`

  const timeout = setTimeout(() => { finish({ error: new Error('Вход не был подтверждён за 15 минут.') }) }, WAIT_LIMIT_MS)
  const shutdown = () => {
    clearTimeout(timeout)
    server.close()
    server.closeAllConnections()
  }
  void key.then(shutdown, shutdown)

  return {
    url: consentUrl(apiBase, challenge, returnTo),
    key,
    cancel: () => { finish({ error: new Error('Вход отменён.') }) },
  }
}

/** Как на этой системе открыть адрес в браузере по умолчанию. */
export function browserLauncher(url: string, platform: NodeJS.Platform = process.platform): { program: string; args: string[] } {
  if (platform === 'win32') {
    // Без оболочки: cmd.exe обрезал бы адрес на первом же «&».
    return { program: 'explorer.exe', args: [url] }
  }
  return { program: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] }
}

/** Попытаться открыть браузер. Не получилось — не беда: адрес показан пользователю. */
export function openBrowser(url: string): void {
  const { program, args } = browserLauncher(url)
  try {
    const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => {})
    child.unref()
  } catch {
    // нет графической среды
  }
}
