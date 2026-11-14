import { readdir, readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { cachedShare, CostBook, priceCall } from '../src/costs.ts'
import { DEFAULT_UTILITY_MODEL, PreferenceStore } from '../src/preferences.ts'
import { JsonFile } from '../src/storage.ts'
import { sampleCards, scratchDir } from './helpers.ts'

describe('JsonFile', () => {
  it('пишет документ целиком и не оставляет временных файлов при одновременных записях', async () => {
    const dir = await scratchDir()
    const file = new JsonFile<{ n: number }>(`${dir}/deep/state.json`, raw => raw as { n: number })
    await Promise.all(Array.from({ length: 25 }, (_, n) => file.write({ n })))
    expect(await file.read()).toEqual({ n: 24 })
    expect(await readdir(`${dir}/deep`)).toEqual(['state.json'])
  })

  it('отсутствующий, повреждённый и не прошедший проверку файл читается как «ничего»', async () => {
    const dir = await scratchDir()
    const strict = (raw: unknown) => (typeof raw === 'object' && raw !== null && 'ok' in raw ? raw as { ok: true } : undefined)
    const file = new JsonFile(`${dir}/state.json`, strict)
    expect(await file.read()).toBeUndefined()
    await writeFile(file.path, '{ не json')
    expect(await file.read()).toBeUndefined()
    await writeFile(file.path, '{"other":1}')
    expect(await file.read()).toBeUndefined()
    await writeFile(file.path, '{"ok":true}')
    expect(await file.read()).toEqual({ ok: true })
  })
})

describe('настройки', () => {
  it('пока пользователь не выбирал модели, действует конфигурация', async () => {
    const store = new PreferenceStore(`${await scratchDir()}/preferences.json`, () => ['a/one', 'b/two'])
    await store.restore()
    expect(store.pickerModels()).toEqual(['a/one', 'b/two'])
    expect(store.customized).toBe(false)
    expect(store.current).toMatchObject({ utilityModel: DEFAULT_UTILITY_MODEL, lowBalance: 100, imageModel: 'bytedance-seed/seedream-5-5', speechModel: 'openai/whisper-large-v3-turbo', videoModel: null, videoBudget: 100 })
  })

  it('сохраняет выбор, убирает повторы и переживает перезапуск', async () => {
    const path = `${await scratchDir()}/preferences.json`
    const store = new PreferenceStore(path, () => ['a/one'])
    let notified = 0
    store.watch(() => { notified += 1 })
    await store.change({ models: ['c/three', 'c/three', '~d/four-latest'], utilityModel: null, lowBalance: 25 })
    expect(notified).toBe(1)
    const reopened = new PreferenceStore(path, () => ['a/one'])
    await reopened.restore()
    expect(reopened.pickerModels()).toEqual(['c/three', '~d/four-latest'])
    expect(reopened.customized).toBe(true)
    expect(reopened.current).toMatchObject({ utilityModel: null, lowBalance: 25 })
  })

  it('отклоняет неверные значения и ничего при этом не меняет', async () => {
    const store = new PreferenceStore(`${await scratchDir()}/preferences.json`, () => ['a/one'])
    await expect(store.change({ models: ['не модель'] })).rejects.toThrow(/не модель/)
    await expect(store.change({ models: 'a/one' })).rejects.toThrow(/массив/)
    await expect(store.change({ lowBalance: -1 })).rejects.toThrow(/Порог/)
    await expect(store.change({ utilityModel: 42 })).rejects.toThrow(/Служебная модель/)
    expect(store.customized).toBe(false)
  })
})

describe('стоимость сессий', () => {
  const sonnet = sampleCards().find(card => card.slug === 'anthropic/claude-sonnet-5.5')

  it('считает вызов по всем видам токенов', () => {
    const cost = priceCall(sonnet, { inputTokens: 1000, cacheReadTokens: 10_000, cacheWriteTokens: 2000, outputTokens: 500 })
    expect(cost).toBeCloseTo((1000 * 215.74878 + 10_000 * 10.787439 + 2000 * 269.685975 + 500 * 1078.7439) / 1e6, 8)
    expect(priceCall(undefined, { inputTokens: 5 })).toBeUndefined()
  })

  it('копит сумму, токены и разбивку по моделям; вызовы без цены считает отдельно', async () => {
    const book = new CostBook(`${await scratchDir()}/costs.json`)
    book.addCall('s1', 'anthropic/claude-sonnet-5.5', sonnet, { inputTokens: 1000, outputTokens: 100 })
    book.addCall('s1', 'anthropic/claude-sonnet-5.5', sonnet, { inputTokens: 0, cacheReadTokens: 3000, outputTokens: 0 })
    book.addCall('s1', 'unknown/model', undefined, { inputTokens: 10 })
    const cost = book.of('s1')
    expect(cost).toMatchObject({ calls: 3, unpriced: 1, last: { model: 'unknown/model', rub: 0 }, tokens: { input: 1010, cached: 3000, cacheWrites: 0, output: 100 } })
    expect(cost?.total).toBeCloseTo((1000 * 215.74878 + 100 * 1078.7439 + 3000 * 10.787439) / 1e6, 8)
    expect(cost?.perModel['anthropic/claude-sonnet-5.5']?.calls).toBe(2)
    expect(cachedShare(cost!.tokens)).toBeCloseTo(3000 / 4010)
    expect(book.of('s2')).toBeUndefined()
  })

  it('готовая сумма (картинка) входит в итог, но не считается запросом к чат-модели', async () => {
    const book = new CostBook(`${await scratchDir()}/costs.json`)
    book.addCall('s1', 'anthropic/claude-sonnet-5.5', sonnet, { inputTokens: 1_000_000 })
    book.addCharge('s1', 'bytedance-seed/seedream-5-5', 2.16)
    const cost = book.of('s1')
    expect(cost?.total).toBeCloseTo(215.74878 + 2.16, 4)
    expect(cost).toMatchObject({ calls: 1, last: { model: 'bytedance-seed/seedream-5-5', rub: 2.16 } })
    expect(cost?.perModel['bytedance-seed/seedream-5-5']).toEqual({ calls: 1, rub: 2.16 })
  })

  it('сохраняется на диск и поднимается обратно', async () => {
    const path = `${await scratchDir()}/costs.json`
    const book = new CostBook(path)
    book.addCall('s1', 'anthropic/claude-sonnet-5.5', sonnet, { inputTokens: 1_000_000 })
    await book.flush()
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('s1')
    const reopened = new CostBook(path)
    await reopened.restore()
    expect(reopened.of('s1')?.total).toBeCloseTo(215.74878, 4)
  })
})
