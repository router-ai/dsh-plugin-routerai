import { describe, expect, it } from 'vitest'
import { ModelCatalog } from '../src/catalog.ts'
import { pricePair, rub, windowLabel } from '../src/money.ts'
import { sampleCards, scratchDir } from './helpers.ts'

const card = (slug: string) => {
  const found = sampleCards().find(item => item.slug === slug)
  if (found === undefined) throw new Error(`в образце нет ${slug}`)
  return found
}

describe('разбор каталога RouterAI', () => {
  it('берёт только модели с текстовым выводом и отбрасывает повреждённые записи', () => {
    const slugs = sampleCards().map(item => item.slug)
    expect(slugs).toEqual(expect.arrayContaining(['anthropic/claude-sonnet-5.5', '~anthropic/claude-sonnet-latest', 'yandex/gpt-pro-5']))
    for (const absent of ['google/gemini-embedding-2-preview', 'cohere/rerank-v3.5', 'recraft/recraft-v4-vector', 'broken entry']) expect(slugs).not.toContain(absent)
  })

  it('разделяет производителя и название, отмечает возможности', () => {
    expect(card('anthropic/claude-sonnet-5.5')).toMatchObject({ maker: 'Anthropic', title: 'Claude Sonnet 5.5', alias: false, tools: true, reasoning: true, vision: true, window: 1_000_000 })
    expect(card('~anthropic/claude-sonnet-latest').alias).toBe(true)
  })

  it('пересчитывает цену за токен в рубли за миллион', () => {
    const price = card('anthropic/claude-sonnet-5.5').price
    expect(price?.input).toBeCloseTo(215.74878, 4)
    expect(price?.output).toBeCloseTo(1078.7439, 4)
    expect(price?.cachedInput).toBeCloseTo(10.787439, 4)
    expect(price?.cacheWrite).toBeCloseTo(269.685975, 4)
  })

  it('не выдумывает цену за токены для моделей с оплатой за запрос', () => {
    expect(card('demo/per-request').price).toBeUndefined()
  })
})

describe('суммы и подписи', () => {
  it('округляет рубли по величине суммы', () => {
    expect(rub(1234.56)).toMatch(/^1\s235 ₽$/)
    expect(rub(12.5)).toBe('12,50 ₽')
    expect(rub(0.0421)).toBe('0,042 ₽')
    expect(rub(0.00655)).toBe('0,0066 ₽')
    expect(rub(0)).toBe('0 ₽')
    expect(rub(undefined)).toBe('—')
  })

  it('подписывает цену и окно', () => {
    expect(pricePair(card('anthropic/claude-sonnet-5.5').price)).toMatch(/^216 ₽ \/ 1\s079 ₽$/)
    expect(pricePair(undefined)).toBe('')
    expect(windowLabel(1_048_576)).toBe('1M')
    expect(windowLabel(200_000)).toBe('200K')
  })
})

describe('копия каталога', () => {
  it('скачивает один раз, пока копия свежая, и переживает перезапуск через файл', async () => {
    const file = `${await scratchDir()}/catalog.json`
    let downloads = 0
    let now = 1_000_000
    const options = { apiBase: 'https://api.test/v1', file, maxAgeMs: 60_000, clock: () => now, download: async () => { downloads += 1; return sampleCards() } }

    const first = new ModelCatalog(options)
    let notified = 0
    first.watch(() => { notified += 1 })
    await first.restore()
    expect(first.size).toBe(0)
    await Promise.all([first.sync(), first.sync()])
    expect(downloads).toBe(1)
    expect(notified).toBe(1)
    expect(first.find('openai/gpt-6.1-sol')?.maker).toBe('OpenAI')

    const second = new ModelCatalog(options)
    await second.restore()
    expect(second.size).toBe(first.size)
    await second.sync()
    expect(downloads).toBe(1)

    now += 61_000
    await second.sync()
    expect(downloads).toBe(2)
  })

  it('при сбое сети оставляет прежние данные и запоминает ошибку', async () => {
    let fail = false
    const catalog = new ModelCatalog({ apiBase: 'https://api.test/v1', maxAgeMs: 0, download: async () => { if (fail) throw new Error('сеть недоступна'); return sampleCards() } })
    await catalog.sync()
    const size = catalog.size
    fail = true
    await catalog.sync()
    expect(catalog.size).toBe(size)
    expect(catalog.lastError).toBe('сеть недоступна')
  })

  it('не берёт с диска копию, снятую с другого адреса API', async () => {
    const file = `${await scratchDir()}/catalog.json`
    await new ModelCatalog({ apiBase: 'https://one.test/v1', file, maxAgeMs: 60_000, download: async () => sampleCards() }).sync()
    const other = new ModelCatalog({ apiBase: 'https://two.test/v1', file, maxAgeMs: 60_000, download: async () => [] })
    await other.restore()
    expect(other.size).toBe(0)
  })
})
