// Маршрут целиком: настоящий адаптер harness поверх заглушки RouterAI, отвечающей потоком Chat Completions.
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { RouterAiAdapter } from '../src/adapter.ts'
import type { RouteObserver } from '../src/adapter.ts'
import type { CallTokens } from '../src/costs.ts'
import type { MoneyProblem } from '../src/failures.ts'
import { describeProblem, recognize } from '../src/failures.ts'
import { buildRoute, describeModel, describeUnknownModel, isolatedAuth } from '../src/provider.ts'
import { sampleCards, sendJson, stubServer } from './helpers.ts'

const KEY = 'sk-unit-test-key-000000000000'

async function setUp(reply: 'stream' | { status: number; message: string }) {
  const stub = await stubServer((exchange, response) => {
    if (reply !== 'stream') return sendJson(response, reply.status, { error: { message: reply.message, code: reply.status } })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (data: object) => response.write(`data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: exchange.body.model, ...data })}\n\n`)
    event({ choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'прикидываю' } }] })
    event({ choices: [{ index: 0, delta: { content: 'Ответ ' } }] })
    event({ choices: [{ index: 0, delta: { content: 'RouterAI' }, finish_reason: 'stop' }] })
    event({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, cost: 0.01, prompt_tokens_details: { cached_tokens: 10 } } })
    response.end('data: [DONE]\n\n')
  })
  const apiBase = `${stub.origin}/api/v1`
  const models = sampleCards().map(card => describeModel(card, apiBase))
  const route = new Map([['routerai', buildRoute(models, apiBase, credentialRef('ROUTERAI_API_KEY'))]])
  const spent: { model: string; tokens: CallTokens }[] = []
  const refused: MoneyProblem[] = []
  const observer: RouteObserver = {
    caption: model => `подпись ${model}`,
    offered: model => model !== 'deepseek/deepseek-v4.1-flash',
    spent: (call, tokens) => { spent.push({ model: call.model, tokens }) },
    refused: (problem) => { refused.push(problem) },
  }
  const adapter = new RouterAiAdapter({
    profiles: () => route,
    auth: isolatedAuth,
    resolveApiKey: async () => KEY,
    prepareHeaders: (_request, headers) => { headers.set('X-Title', 'DeepSeek Harness'); return headers },
  }, observer)
  return { adapter, stub, spent, refused }
}

const call = (model: string, extra: object = {}) => ({
  provider: 'routerai', model, maxTokens: 500,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Привет' }] }],
  ...extra,
}) as unknown as GenerateOptions

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('описание моделей для pi-ai', () => {
  const base = 'https://routerai.ru/api/v1'
  const model = (slug: string) => describeModel(sampleCards().find(card => card.slug === slug)!, base)

  it('переносит окно, зрение и рассуждение из каталога', () => {
    const sonnet = model('anthropic/claude-sonnet-5.5')
    expect(sonnet).toMatchObject({ id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', provider: 'routerai', api: 'openai-completions', baseUrl: base, contextWindow: 1_000_000, maxTokens: 32_768, reasoning: true, input: ['text', 'image'] })
    expect(sonnet.thinkingLevelMap).toMatchObject({ low: 'low', medium: 'medium', high: 'high', off: null, max: null })
  })

  it('разметку кэша включает только моделям Anthropic, в том числе алиасам', () => {
    expect(model('anthropic/claude-sonnet-5.5').compat).toMatchObject({ cacheControlFormat: 'anthropic', thinkingFormat: 'openrouter' })
    expect(model('~anthropic/claude-sonnet-latest').compat).toHaveProperty('cacheControlFormat', 'anthropic')
    expect(model('openai/gpt-6.1-sol').compat).not.toHaveProperty('cacheControlFormat')
  })

  it('модель без рассуждения и неизвестная каталогу модель описываются осторожно', () => {
    const plain = sampleCards().find(card => !card.reasoning)!
    expect(describeModel(plain, base)).toMatchObject({ reasoning: false })
    expect(describeModel(plain, base)).not.toHaveProperty('thinkingLevelMap')
    expect(describeUnknownModel('new/model', base)).toMatchObject({ id: 'new/model', name: 'new/model', input: ['text'], reasoning: false, contextWindow: 128_000 })
  })
})

describe('маршрут routerai', () => {
  it('в пикере показывает предложенные модели с подписями', async () => {
    const { adapter } = await setUp('stream')
    const listed = await adapter.listModels('routerai')
    expect(listed.map(model => model.id)).toContain('anthropic/claude-sonnet-5.5')
    expect(listed.map(model => model.id)).not.toContain('deepseek/deepseek-v4.1-flash')
    expect(listed.find(model => model.id === 'openai/gpt-6.1-sol')?.description).toBe('подпись openai/gpt-6.1-sol')
    // Скрытая из пикера модель остаётся доступной маршруту — на ней работают служебные запросы.
    await expect(adapter.resolveModel('routerai', 'deepseek/deepseek-v4.1-flash')).resolves.toBeDefined()
  })

  it('отправляет запрос в диалекте RouterAI и отдаёт текст, а токены — наблюдателю', async () => {
    const { adapter, stub, spent } = await setUp('stream')
    const chunks = await collect(adapter.stream(call('anthropic/claude-sonnet-5.5', { reasoningEffort: 'high', sessionId: 'session-1' })))

    const sent = stub.seen.at(-1)!
    expect(sent.path).toBe('/api/v1/chat/completions')
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent.headers['x-title']).toBe('DeepSeek Harness')
    expect(sent.body).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', stream: true, max_tokens: 500, reasoning: { effort: 'high' } })
    expect(sent.body).not.toHaveProperty('store')

    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => (chunk as { text: string }).text).join('')).toBe('Ответ RouterAI')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(spent).toEqual([{ model: 'anthropic/claude-sonnet-5.5', tokens: expect.objectContaining({ inputTokens: 20, cacheReadTokens: 10, outputTokens: 7 }) }])
  })

  it('наблюдает и за вызовом, подготовленным заранее', async () => {
    const { adapter, spent } = await setUp('stream')
    const prepared = await adapter.prepareCall('routerai', 'openai/gpt-6.1-sol')
    await collect(prepared.stream(call('openai/gpt-6.1-sol')))
    expect(spent.map(item => item.model)).toEqual(['openai/gpt-6.1-sol'])
  })

  it('отказ из-за пустого баланса превращает в понятное сообщение с кодом QUOTA', async () => {
    const { adapter, refused } = await setUp({ status: 402, message: 'Недостаточно средств на балансе: 0.0 ₽. Пожалуйста, пополните счет' })
    let failure: { code?: string; message?: string } | undefined
    try {
      const last = (await collect(adapter.stream(call('openai/gpt-6.1-sol')))).at(-1)
      if (last?.type === 'finish' && last.reason.kind === 'error') failure = last.reason.failure
    } catch (error) {
      failure = error as { code?: string; message?: string }
    }
    expect(failure?.code).toBe('QUOTA')
    expect(failure?.message).toContain('https://routerai.ru/settings/billing')
    expect(refused.map(problem => problem.kind)).toEqual(['no-funds'])
  })
})

describe('распознавание отказов из-за денег', () => {
  it('различает пустой баланс, лимит ключа и отключённый ключ', () => {
    expect(recognize({ status: 402, message: 'Недостаточно средств на балансе: 0.0 ₽' })).toBe('no-funds')
    expect(recognize({ status: 402, message: 'Insufficient balance' })).toBe('no-funds')
    expect(recognize({ status: 402, message: 'что-то новое' })).toBe('no-funds')
    expect(recognize({ status: 429, message: 'API key day spending limit exceeded: 100.5 / 100.0' })).toBe('key-cap')
    expect(recognize({ status: 429, message: 'Team member spending limit exceeded' })).toBe('key-cap')
    expect(recognize({ status: 429, message: 'API key is disabled' })).toBe('key-off')
  })

  it('не принимает за денежные обычные сбои', () => {
    expect(recognize({ status: 429, message: 'concurrency_limit_exceeded' })).toBeUndefined()
    expect(recognize({ status: 503, message: 'No available providers for model' })).toBeUndefined()
    expect(describeProblem({ message: 'network error' })).toBeUndefined()
  })

  it('в сообщении о лимите называет потраченное и лимит', () => {
    expect(describeProblem({ status: 429, message: 'API key day spending limit exceeded: 100.5 / 100.0' })?.text).toContain('потрачено 100.5 ₽ из 100.0 ₽')
  })
})
