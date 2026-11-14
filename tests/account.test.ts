import { describe, expect, it } from 'vitest'
import { loadAccount, looksLikeApiKey, maskApiKey } from '../src/account.ts'
import { Bridge } from '../src/bridge.ts'
import type { BridgeEndpoint } from '../src/bridge.ts'
import { ModelCatalog } from '../src/catalog.ts'
import { CostBook } from '../src/costs.ts'
import { PreferenceStore } from '../src/preferences.ts'
import { browserLauncher, consentUrl, newChallenge, startSignIn } from '../src/signin.ts'
import { accountReport } from '../src/slash.ts'
import { sampleCards, scratchDir, sendJson, stubServer } from './helpers.ts'

const GOOD = 'sk-good-key-0000000000000000'

/** Заглушка RouterAI: баланс, сведения о ключе, обмен кода на ключ. */
async function routerai(limit = 100) {
  const stub = await stubServer((exchange, response) => {
    if (exchange.path === '/api/v1/auth/keys') {
      return exchange.body.code === 'valid-code'
        ? sendJson(response, 200, { key: 'sk-issued-by-consent-page-0001' })
        : sendJson(response, 400, { error: 'invalid_grant', error_description: 'Невалидный код авторизации' })
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
      expect(args).toEqual([url])
      expect(program).not.toMatch(/cmd/i)
    }
  })

  it('после подтверждения меняет код на ключ', async () => {
    const { apiBase, seen } = await routerai()
    const attempt = await startSignIn(apiBase)
    const consent = new URL(attempt.url).searchParams
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
    const back = new URL(new URL(attempt.url).searchParams.get('callback_url')!)
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
      const consent = new URL(attempt.url).searchParams
      await fetch(`${consent.get('callback_url')}?${query(consent.get('state')!)}`)
      return outcome
    }
    expect(await finish(state => `error=access_denied&state=${state}`)).toContain('отклонили доступ')
    expect(await finish(state => `code=stale&state=${state}`)).toContain('Невалидный код авторизации')

    const cancelled = await startSignIn(apiBase)
    cancelled.cancel()
    await expect(cancelled.key).rejects.toThrow('Вход отменён')
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
    const started = (await send('sign-in', {})).body as { url: string }
    expect((await send('overview')).body.signIn).toEqual({ stage: 'waiting', url: started.url })
    const consent = new URL(started.url).searchParams
    await fetch(`${consent.get('callback_url')}?code=valid-code&state=${consent.get('state')}`)
    await expect.poll(key).toBe('sk-issued-by-consent-page-0001')
    await expect.poll(async () => (await send('overview')).body.signIn.stage).toBe('idle')
  })
})
