import { describe, expect, it } from 'vitest'
import { isChatModel, isImageModel, isSpeechModel, isVideoModel, ModelCatalog, readModelCard } from '../src/catalog.ts'
import { pricePair, rub, windowLabel } from '../src/money.ts'
import { sampleCards, scratchDir } from './helpers.ts'

const card = (slug: string) => {
  const found = sampleCards().find(item => item.slug === slug)
  if (found === undefined) throw new Error(`в образце нет ${slug}`)
  return found
}

describe('разбор каталога RouterAI', () => {
  it('берёт чат-модели, модели для картинок и речи; остальное и повреждённые записи отбрасывает', () => {
    const slugs = sampleCards().map(item => item.slug)
    expect(slugs).toEqual(expect.arrayContaining(['anthropic/claude-sonnet-5.5', '~anthropic/claude-sonnet-latest', 'yandex/gpt-pro-5', 'bytedance-seed/seedream-5-5', 'openai/whisper-large-v3-turbo']))
    for (const absent of ['google/gemini-embedding-2-preview', 'cohere/rerank-v3.5', 'broken entry']) expect(slugs).not.toContain(absent)
  })

  it('различает, что модель выдаёт, и знает цену картинки и секунды речи', () => {
    expect(card('anthropic/claude-sonnet-5.5').makes).toEqual(['text'])
    expect(isChatModel(card('anthropic/claude-sonnet-5.5'))).toBe(true)

    const painter = card('bytedance-seed/seedream-5-5')
    expect(painter.makes).toEqual(['image'])
    expect(isImageModel(painter)).toBe(true)
    expect(isChatModel(painter)).toBe(false)
    expect(painter.perImage).toBeCloseTo(2.1359416, 5)

    // Модель, которая и отвечает текстом, и рисует: годится и в пикер, и для картинок.
    expect(card('google/gemini-3.1-flash-image').makes).toEqual(['text', 'image'])
    expect(card('google/gemini-3.1-flash-image').perImage).toBeUndefined()

    expect(painter.media).toMatchObject({ billedBy: 'image', maxCount: expect.any(Number) })
    expect(painter.media?.aspectRatios).toContain('16:9')
    expect(painter.media).toMatchObject({ sizes: ['1K', '1.5K', '2K'], backgrounds: ['auto', 'transparent', 'opaque'], formats: ['png', 'jpeg'], references: 10 })
    expect(painter.media?.qualities).toBeUndefined()
    // Модель с оплатой по токенам: цену за картинку заранее не назвать.
    expect(card('google/gemini-3.1-flash-image').media?.billedBy).toBe('token')
    expect(card('anthropic/claude-sonnet-5.5').media).toBeUndefined()

    const director = card('tbc/mischief-1')
    expect(director.media).toMatchObject({ aspectRatios: ['16:9'], resolutions: ['480p', '720p'], frames: ['first_frame'] })
    expect(director.media?.needsSource).toBeUndefined()
    expect(isVideoModel(director)).toBe(true)
    expect(isChatModel(director)).toBe(false)
    expect(director.perSecond).toBeCloseTo(0.5339854, 6)
    expect(director.durations).toEqual([3, 5])

    const listener = card('openai/whisper-large-v3-turbo')
    expect(isSpeechModel(listener)).toBe(true)
    expect(listener.perSecond).toBeCloseTo(0.0003556342764, 9)
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

  it('читает, что видео-модель умеет с референсами, кадрами и звуком', () => {
    const film = (extra: object) => readModelCard({ id: 'demo/film', name: 'Demo: Film', architecture: { input_modalities: ['text', 'image'], output_modalities: ['video'] }, supported_durations: [5], ...extra })?.media
    expect(film({ supported_frame_images: ['first_frame', 'last_frame'], supports_reference_images: true, max_image_references: 9, frames_exclusive_with_references: true, generate_audio: true }))
      .toMatchObject({ frames: ['first_frame', 'last_frame'], references: 9, referencesExcludeFrames: true, audio: true })
    const plain = film({ supported_frame_images: ['first_frame'], supports_reference_images: false, frames_exclusive_with_references: true, generate_audio: null })
    expect(plain).toMatchObject({ references: 0 })
    expect(plain).not.toHaveProperty('audio')
    expect(plain).not.toHaveProperty('referencesExcludeFrames')
  })

  it('отмечает видео-модели, которым нужно готовое видео на входе', () => {
    const upscaler = readModelCard({ id: 'demo/upscale', name: 'Demo: Upscale', architecture: { input_modalities: ['text', 'video'], output_modalities: ['video'] } })
    expect(upscaler?.media).toEqual({ needsSource: true })
    const ordinary = readModelCard({ id: 'demo/film', name: 'Demo: Film', architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['video'] }, supported_durations: [5], supported_frame_images: ['first_frame'] })
    expect(ordinary?.media?.needsSource).toBeUndefined()
  })

  it('не выдумывает цену за токены для моделей с оплатой за запрос', () => {
    expect(card('demo/per-request').price).toBeUndefined()
  })
})

describe('суммы и подписи', () => {
  it('округляет рубли по величине суммы', () => {
    expect(rub(1234.56)).toMatch(/^1\s235 ₽$/)
    expect(rub(12.5)).toBe('12,50 ₽')
    expect(rub(15)).toBe('15 ₽')
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
