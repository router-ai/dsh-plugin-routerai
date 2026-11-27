import { describe, expect, it } from 'vitest'
import { loadAccount, looksLikeApiKey, maskApiKey, tidyApiKey } from '../src/account.ts'
import { Bridge } from '../src/bridge.ts'
import type { BridgeEndpoint } from '../src/bridge.ts'
import { ModelCatalog } from '../src/catalog.ts'
import { CostBook } from '../src/costs.ts'
import { PreferenceStore } from '../src/preferences.ts'
import { createServer } from 'node:net'
import { browserLauncher, consentUrl, newChallenge, readPastedCode, startSignIn } from '../src/signin.ts'
import { accountReport } from '../src/slash.ts'
import { installLabel } from '../src/install.ts'
import { clientName } from '../src/signin.ts'
import { sampleCards, scratchDir, sendJson, stubServer } from './helpers.ts'

const GOOD = 'sk-good-key-0000000000000000'

/** Заглушка RouterAI: баланс, сведения о ключе, обмен кода на ключ. */
async function routerai(limit = 100) {
  const stub = await stubServer((exchange, response) => {
    if (exchange.path === '/api/v1/auth/keys') {
      const refusals: Record<string, string> = { 'old-code': 'Код авторизации истёк', 'spent-code': 'Код авторизации уже использован', 'foreign-code': 'Невалидный code_verifier' }
      return exchange.body.code === 'valid-code'
        ? sendJson(response, 200, { key: 'sk-issued-by-consent-page-0001' })
        : sendJson(response, 400, { error: 'invalid_grant', error_description: refusals[exchange.body.code] ?? 'Невалидный код авторизации' })
    }
    if (exchange.headers.authorization !== `Bearer ${GOOD}`) return sendJson(response, 401, { error: '401 Unauthorized' })
    if (exchange.path === '/api/v1/credits') return sendJson(response, 200, { data: { credits: 1073.22 } })
    if (exchange.path === '/api/v1/key') {
      return sendJson(response, 200, { data: { name: 'ноутбук', disabled: false, usage: 3.5, usage_monthly: 12, limit, limit_remaining: limit - 3.5, limit_reset: 'daily' } })
    }
    sendJson(response, 404, {})
  })
  return { ...stub, apiBase: `${stub.origin}/api/v1` }
}

describe('сведения об аккаунте', () => {
  it('читает баланс и лимит ключа', async () => {
    const { apiBase } = await routerai()
    const account = await loadAccount(apiBase, GOOD)
    expect(account).toMatchObject({ state: 'ok', balance: 1073.22, notes: [], key: { label: 'ноутбук', disabled: false, spent: 3.5, spentThisMonth: 12, cap: { amount: 100, left: 96.5, period: 'daily' } } })
    const report = accountReport(account)
    expect(report).toMatch(/На счёте 1\s073 ₽\./)
    expect(report).toContain('Ключ «ноутбук»: лимит 100 ₽ в сутки, осталось 96,50 ₽.')
  })

  it('нулевой лимит означает ключ без лимита', async () => {
    const { apiBase } = await routerai(0)
    const account = await loadAccount(apiBase, GOOD)
    expect(account.key?.cap).toBeUndefined()
    expect(accountReport(account)).toContain('без лимита расходов')
  })

  it('отвергнутый ключ и недоступный сервер различаются', async () => {
    const { apiBase } = await routerai()
    const rejected = await loadAccount(apiBase, 'sk-someone-elses-key-00000000')
    expect(rejected.state).toBe('rejected')
    expect(accountReport(rejected)).toContain('/routerai login')
    const offline = await loadAccount('http://127.0.0.1:9/api/v1', GOOD)
    expect(offline.state).toBe('offline')
    expect(offline.balance).toBeUndefined()
  })

  it('узнаёт ключ RouterAI и скрывает его середину', () => {
    expect(looksLikeApiKey('sk-AbCdEfGh_0123456789-ijklmnopqrSTU')).toBe(true)
    expect(looksLikeApiKey('sk-short')).toBe(false)
    expect(looksLikeApiKey('token-0123456789abcdefghij')).toBe(false)
    expect(maskApiKey('sk-AbCdEfGh_0123456789-ijklmnopqrSTU')).toBe('sk-AbCd…rSTU')
  })
})

describe('вход через браузер', () => {
  it('страница согласия открывается на сайте и получает параметры PKCE', () => {
    const challenge = newChallenge()
    const page = new URL(consentUrl('https://routerai.ru/api/v1', challenge, 'http://127.0.0.1:4100/routerai/return'))
    expect(page.origin + page.pathname).toBe('https://routerai.ru/auth')
    expect(Object.fromEntries(page.searchParams)).toMatchObject({
      app_name: 'DeepSeek Harness', code_challenge: challenge.digest, code_challenge_method: 'S256',
      state: challenge.ticket, callback_url: 'http://127.0.0.1:4100/routerai/return',
    })
    // RouterAI требует ровно 43 символа: SHA-256 в base64url без дополнения.
    expect(challenge.digest).toHaveLength(43)
    expect(challenge.secret).not.toBe(challenge.digest)
  })

  it('браузер запускается без оболочки, адрес передаётся целиком', () => {
    const url = 'https://routerai.ru/auth?a=1&b=2'
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const { program, args } = browserLauncher(url, platform)
      expect(args.at(-1)).toBe(url)
      expect(program).not.toMatch(/cmd|explorer/i)
    }
  })

  it('после подтверждения меняет код на ключ', async () => {
    const { apiBase, seen } = await routerai()
    const attempt = await startSignIn(apiBase)
    const consent = new URL(attempt.url!).searchParams
    const back = new URL(consent.get('callback_url')!)
    back.search = new URLSearchParams({ code: 'valid-code', state: consent.get('state')!, iss: 'https://routerai.ru' }).toString()
    const page = await fetch(back)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Ключ RouterAI сохранён')
    expect(await attempt.key).toBe('sk-issued-by-consent-page-0001')
    const exchange = seen.find(item => item.path === '/api/v1/auth/keys')!
    expect(exchange.body).toMatchObject({ code: 'valid-code', code_challenge_method: 'S256', callback_url: consent.get('callback_url') })
    expect(exchange.body.code_verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('ответ с чужой меткой отклоняется без обращения к RouterAI', async () => {
    const { apiBase, seen } = await routerai()
    const attempt = await startSignIn(apiBase)
    const outcome = attempt.key.then(() => 'ключ', (error: Error) => error.message)
    const back = new URL(new URL(attempt.url!).searchParams.get('callback_url')!)
    back.search = '?code=valid-code&state=forged'
    expect((await fetch(back)).status).toBe(400)
    expect(await outcome).toContain('не относится к начатому входу')
    expect(seen.filter(item => item.path === '/api/v1/auth/keys')).toHaveLength(0)
  })

  it('отказ пользователя, плохой код и отмена завершают вход ошибкой', async () => {
    const { apiBase } = await routerai()
    const finish = async (query: (state: string) => string) => {
      const attempt = await startSignIn(apiBase)
      const outcome = attempt.key.then(() => 'ключ', (error: Error) => error.message)
      const consent = new URL(attempt.url!).searchParams
      await fetch(`${consent.get('callback_url')}?${query(consent.get('state')!)}`)
      return outcome
    }
    expect(await finish(state => `error=access_denied&state=${state}`)).toContain('отклонили доступ')
    expect(await finish(state => `code=stale&state=${state}`)).toContain('RouterAI не узнал этот код')

    const cancelled = await startSignIn(apiBase)
    cancelled.cancel()
    await expect(cancelled.key).rejects.toThrow('Вход отменён')
  })
})

describe('проверка сохранённого ключа', () => {
  it('обрезает пробелы по краям; пустой ключ и ключ с лишними символами не пропускает', () => {
    expect(tidyApiKey('  sk-good-key-0000000000000000\n')).toEqual({ ok: true, key: 'sk-good-key-0000000000000000' })
    expect(tidyApiKey('   ')).toMatchObject({ ok: false })
    expect(tidyApiKey('sk-good key')).toMatchObject({ ok: false })
    expect(tidyApiKey('ключ sk-good-key')).toMatchObject({ ok: false })
    // Сам ключ в описание проблемы не попадает.
    expect(JSON.stringify(tidyApiKey('sk-secret part'))).not.toContain('sk-secret')
  })
})

describe('имя приложения установки', () => {
  it('метка создаётся один раз и переживает перезапуск; испорченный файл заменяется', async () => {
    const dir = await scratchDir()
    const first = await installLabel(`${dir}/install.json`)()
    expect(first).toMatch(/^[a-z0-9]{4}$/)
    expect(await installLabel(`${dir}/install.json`)()).toBe(first)
    expect(await installLabel(`${dir}/other/install.json`)()).not.toBe(undefined)
    expect(clientName(first)).toBe(`DeepSeek Harness · ${first}`)
    expect(clientName()).toBe('DeepSeek Harness')
  })

  it('обе страницы согласия называют приложение именем установки', async () => {
    const { apiBase } = await routerai()
    const attempt = await startSignIn(apiBase, { appName: clientName('k3f9') })
    for (const page of [attempt.url!, attempt.codeUrl]) {
      const query = new URL(page).searchParams
      expect(query.get('app_name')).toBe('DeepSeek Harness · k3f9')
      expect(query.get('key_label')).toBe('DeepSeek Harness · k3f9')
    }
    attempt.cancel()
  })
})

describe('вход по коду', () => {
  const exchanges = (seen: { path: string; body: any }[]) => seen.filter(item => item.path === '/api/v1/auth/keys')

  it('без приёмника страница согласия открывается без адреса возврата, код меняется без него', async () => {
    const { apiBase, seen } = await routerai()
    const attempt = await startSignIn(apiBase, { receiver: false })
    expect(attempt.url).toBeNull()
    expect(attempt.port).toBeNull()
    const consent = new URL(attempt.codeUrl).searchParams
    expect(consent.get('callback_url')).toBeNull()
    expect(consent.get('code_challenge')).toHaveLength(43)
    await attempt.submit('  valid-code \n')
    expect(await attempt.key).toBe('sk-issued-by-consent-page-0001')
    expect(exchanges(seen)[0]!.body).toMatchObject({ code: 'valid-code', code_challenge_method: 'S256' })
    expect(exchanges(seen)[0]!.body).not.toHaveProperty('callback_url')
  })

  it('обе страницы согласия одной попытки несут один и тот же code_challenge', async () => {
    const { apiBase } = await routerai()
    const attempt = await startSignIn(apiBase)
    expect(new URL(attempt.codeUrl).searchParams.get('code_challenge')).toBe(new URL(attempt.url!).searchParams.get('code_challenge'))
    attempt.cancel()
  })

  it('вставленный адрес возврата: код меняется с адресом приёмника, чужая метка отклоняется без запроса', async () => {
    const { apiBase, seen } = await routerai()
    const attempt = await startSignIn(apiBase)
    const consent = new URL(attempt.url!).searchParams
    const back = consent.get('callback_url')!
    await expect(attempt.submit(`${back}?code=valid-code&state=forged`)).rejects.toThrow('другой попытке входа')
    expect(exchanges(seen)).toHaveLength(0)
    await attempt.submit(`${back}?code=valid-code&state=${consent.get('state')}`)
    expect(await attempt.key).toBe('sk-issued-by-consent-page-0001')
    expect(exchanges(seen)[0]!.body).toMatchObject({ code: 'valid-code', callback_url: back })
  })

  it('отказ в обмене объясняется понятно и не завершает попытку', async () => {
    const { apiBase } = await routerai()
    const attempt = await startSignIn(apiBase, { receiver: false })
    await expect(attempt.submit('typo')).rejects.toThrow('RouterAI не узнал этот код')
    await expect(attempt.submit('old-code')).rejects.toThrow('Код устарел')
    await expect(attempt.submit('spent-code')).rejects.toThrow('уже использован')
    await expect(attempt.submit('foreign-code')).rejects.toThrow('другой попытки входа')
    await attempt.submit('valid-code')
    expect(await attempt.key).toBe('sk-issued-by-consent-page-0001')
  })

  it('один и тот же код не уходит в RouterAI дважды', async () => {
    const { apiBase, seen } = await routerai()
    const attempt = await startSignIn(apiBase, { receiver: false })
    await expect(attempt.submit('typo')).rejects.toThrow()
    await expect(attempt.submit('typo')).rejects.toThrow('уже был отправлен')
    expect(exchanges(seen)).toHaveLength(1)
    await attempt.submit('valid-code')
    await expect(attempt.submit('valid-code')).rejects.toThrow('уже завершён')
    expect(exchanges(seen)).toHaveLength(2)
  })

  it('разбирает вставленное: код, адрес, отказ; ключ вместо кода не принимает', () => {
    expect(readPastedCode(' abc-123\n')).toEqual({ code: 'abc-123', fromAddress: false })
    expect(readPastedCode('http://127.0.0.1:5000/routerai/return?code=c1&state=s1')).toEqual({ code: 'c1', state: 's1', fromAddress: true })
    expect(() => readPastedCode('http://127.0.0.1:5000/routerai/return?error=access_denied&state=s1')).toThrow('отклонили доступ')
    expect(() => readPastedCode('https://routerai.ru/auth?app_name=x')).toThrow('нет кода входа')
    expect(() => readPastedCode('sk-good-key-0000000000000000')).toThrow('Это ключ')
    expect(() => readPastedCode('   ')).toThrow('Вставьте код')
  })

  it('приёмник отвечает на проверку меткой попытки и разрешает чтение с любой страницы', async () => {
    const { apiBase } = await routerai()
    const attempt = await startSignIn(apiBase)
    const response = await fetch(`http://127.0.0.1:${attempt.port}/routerai/ping`)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({ attempt: attempt.attempt })
    // Метка попытки — не секрет входа.
    expect(attempt.url).not.toContain(attempt.attempt)
    attempt.cancel()
  })

  it('заданный порт используется; занятый порт оставляет вход по коду с объяснением', async () => {
    const { apiBase } = await routerai()
    const blocker = createServer()
    await new Promise<void>((resolve) => { blocker.listen(0, '127.0.0.1', resolve) })
    const port = (blocker.address() as { port: number }).port
    const busy = await startSignIn(apiBase, { port })
    expect(busy.url).toBeNull()
    expect(busy.receiverProblem).toContain(`Порт ${port}`)
    busy.cancel()
    await new Promise<void>((resolve) => { blocker.close(() => { resolve() }) })
    const free = await startSignIn(apiBase, { port })
    expect(free.port).toBe(port)
    expect(new URL(free.url!).searchParams.get('callback_url')).toBe(`http://127.0.0.1:${port}/routerai/return`)
    free.cancel()
  })
})

describe('мост для интерфейса', () => {
  async function setUp() {
    const { apiBase } = await routerai()
    const dir = await scratchDir()
    let key: string | undefined
    const catalog = new ModelCatalog({ apiBase, maxAgeMs: 3_600_000, download: async () => sampleCards() })
    const preferences = new PreferenceStore(`${dir}/preferences.json`, () => ['anthropic/claude-sonnet-5.5'])
    const costs = new CostBook(`${dir}/costs.json`)
    const bridge = new Bridge({
      apiBase, catalog, preferences, costs, warn: () => {},
      readKey: async () => key,
      storeKey: async (value) => { key = value },
      forgetKey: async () => { key = undefined },
    })
    const endpoints = bridge.endpoints()
    const send = async (target: string, body?: unknown) => {
      const [path] = target.split('?')
      const endpoint = endpoints.find(item => item.path === `/api/routerai/${path}`) as BridgeEndpoint
      const method = body === undefined ? 'GET' : 'POST'
      expect(endpoint.methods).toContain(method)
      const response = await endpoint.fetch(new Request(`http://localhost/api/routerai/${target}`, { method, ...body === undefined ? {} : { body: JSON.stringify(body) } }))
      return { status: response.status, body: await response.json() as any }
    }
    return { bridge, send, costs, key: () => key, catalog }
  }

  it('без ключа сообщает, что подключения нет, и отдаёт список из конфигурации', async () => {
    const { send } = await setUp()
    const { status, body } = await send('overview')
    expect(status).toBe(200)
    expect(body).toEqual({
      connected: false, keyMask: null, signIn: { stage: 'idle' }, account: null,
      picker: { models: ['anthropic/claude-sonnet-5.5'], custom: false },
      utilityModel: 'deepseek/deepseek-v4.1-flash', lowBalance: 100,
      imageModel: 'bytedance-seed/seedream-5-5', speechModel: 'openai/whisper-large-v3-turbo',
      videoModel: null, videoBudget: 100, imageChoices: [], videoChoices: [], voiceModel: 'x-ai/grok-voice-tts-1.0', voice: 'eve', problem: null,
    })
  })

  it('сохраняет ключ и показывает аккаунт; чужой формат ключа отклоняет', async () => {
    const { send, key } = await setUp()
    const refused = await send('key', { key: 'not-a-routerai-key' })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('sk-')
    expect(key()).toBeUndefined()

    expect((await send('key', { key: ` ${GOOD} ` })).status).toBe(200)
    const { body } = await send('overview')
    expect(body).toMatchObject({ connected: true, keyMask: 'sk-good…0000', account: { state: 'ok', balance: 1073.22 } })

    await send('sign-out', {})
    expect((await send('overview')).body.connected).toBe(false)
  })

  it('меняет настройки и объясняет отказ', async () => {
    const { send } = await setUp()
    expect((await send('preferences', { models: ['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol'], utilityModel: null, lowBalance: 10, imageModel: null, speechModel: 'openai/whisper-large-v3' })).status).toBe(200)
    expect((await send('overview')).body).toMatchObject({ picker: { models: ['openai/gpt-6.1-sol'], custom: true }, utilityModel: null, lowBalance: 10, imageModel: null, speechModel: 'openai/whisper-large-v3' })
    expect((await send('preferences', { speechModel: null })).status).toBe(400)
    expect((await send('preferences', { videoModel: 'tbc/mischief-1', videoBudget: 30 })).status).toBe(200)
    expect((await send('overview')).body).toMatchObject({ videoModel: 'tbc/mischief-1', videoBudget: 30 })
    expect((await send('preferences', { videoBudget: 0 })).status).toBe(400)
    expect((await send('preferences', { imageChoices: ['recraft/recraft-v4-vector', 'recraft/recraft-v4-vector'], voiceModel: null, voice: ' Kore ' })).status).toBe(200)
    expect((await send('overview')).body).toMatchObject({ imageChoices: ['recraft/recraft-v4-vector'], voiceModel: null, voice: 'Kore' })
    expect((await send('preferences', { voice: 'плохой; голос' })).status).toBe(400)
    expect((await send('preferences', { videoChoices: Array.from({ length: 9 }, (_, n) => `demo/model-${n}`) })).status).toBe(400)
    const refused = await send('preferences', { models: ['какая-то модель'] })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('какая-то модель')
  })

  it('отдаёт каталог и стоимость сессии', async () => {
    const { send, costs, catalog } = await setUp()
    const models = (await send('catalog')).body.models as { slug: string }[]
    expect(models.map(model => model.slug)).toContain('anthropic/claude-sonnet-5.5')

    expect((await send('session-cost?id=none')).body.cost).toBeNull()
    costs.addCall('s1', 'anthropic/claude-sonnet-5.5', catalog.find('anthropic/claude-sonnet-5.5'), { inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 10 })
    const cost = (await send('session-cost?id=s1')).body.cost
    expect(cost).toMatchObject({ calls: 1, unpriced: 0, cachedShare: 0.5 })
    expect(cost.total).toBeGreaterThan(0)
  })

  it('показывает отказ из-за денег, пока не пройдёт успешный вызов', async () => {
    const { send, bridge } = await setUp()
    bridge.noteProblem({ kind: 'key-cap', text: 'лимит исчерпан', at: Date.now() })
    expect((await send('overview')).body.problem).toMatchObject({ kind: 'key-cap' })
    bridge.noteSuccess()
    expect((await send('overview')).body.problem).toBeNull()
  })

  it('вход из интерфейса: ожидание, затем ключ', async () => {
    const { send, key } = await setUp()
    const started = (await send('sign-in', {})).body as { url: string; codeUrl: string; attempt: string; port: number }
    expect(started.port).toBeGreaterThan(0)
    expect(started.attempt).not.toBe('')
    expect((await send('overview')).body.signIn).toEqual({ stage: 'waiting', url: started.url, codeUrl: started.codeUrl, byCode: false, notice: null })
    const consent = new URL(started.url).searchParams
    await fetch(`${consent.get('callback_url')}?code=valid-code&state=${consent.get('state')}`)
    await expect.poll(key).toBe('sk-issued-by-consent-page-0001')
    await expect.poll(async () => (await send('overview')).body.signIn.stage).toBe('idle')
  })

  it('интерфейс с другой машины: вход сразу по коду, ключ сохранён к ответу на код', async () => {
    const { send, key } = await setUp()
    const started = (await send('sign-in', { receiver: false })).body
    expect(started).toMatchObject({ url: null, port: null, byCode: true })
    expect((await send('sign-in/code', { value: 'typo' })).status).toBe(400)
    expect((await send('overview')).body.signIn.stage).toBe('waiting')
    expect((await send('sign-in/code', { value: 'valid-code' })).status).toBe(200)
    expect(key()).toBe('sk-issued-by-consent-page-0001')
    expect((await send('overview')).body.signIn.stage).toBe('idle')
    expect((await send('sign-in/code', { value: 'valid-code' })).body.error).toContain('Вход не начат')
  })

  it('приёмник не виден из браузера: интерфейс переводит начатый вход на код', async () => {
    const { send, key } = await setUp()
    await send('sign-in', {})
    await send('sign-in/by-code', {})
    expect((await send('overview')).body.signIn).toMatchObject({ stage: 'waiting', byCode: true })
    await send('sign-in/code', { value: 'valid-code' })
    expect(key()).toBe('sk-issued-by-consent-page-0001')
  })
})
