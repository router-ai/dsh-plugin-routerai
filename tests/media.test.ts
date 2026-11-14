import { describe, expect, it } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { fileStem } from '../src/draw.ts'
import { fitDuration, readFrame } from '../src/film.ts'
import { drawPictures, makeFilm, MediaError, recognizeSpeech, sniffPictureType, wavSeconds } from '../src/media.ts'
import { scratchDir, sendJson, stubServer } from './helpers.ts'

const KEY = 'sk-media-test-key-00000000000'
// Самый маленький корректный PNG: один прозрачный пиксель.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** Секунда тишины: WAV 16 кГц, моно, 16 бит. */
function silence(seconds: number): Uint8Array {
  const data = Buffer.alloc(16_000 * 2 * seconds)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return new Uint8Array(Buffer.concat([header, data]))
}

describe('картинки', () => {
  it('отправляет описание и параметры, возвращает картинки и стоимость', async () => {
    const stub = await stubServer((_exchange, response) => sendJson(response, 200, {
      created: 1, data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }, { b64_json: PNG.toString('base64') }], usage: { cost: 4.32 },
    }))
    const result = await drawPictures(`${stub.origin}/api/v1`, KEY, { model: 'demo/painter', prompt: 'рыжий кот', aspectRatio: '16:9', count: 2 }, new AbortController().signal)
    expect(stub.seen[0]).toMatchObject({ method: 'POST', path: '/api/v1/images', body: { model: 'demo/painter', prompt: 'рыжий кот', aspect_ratio: '16:9', n: 2 } })
    expect(stub.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(result.cost).toBe(4.32)
    expect(result.pictures).toHaveLength(2)
    expect(result.pictures[0]).toMatchObject({ type: 'image/png' })
    expect(Buffer.from(result.pictures[0]!.bytes).equals(PNG)).toBe(true)
  })

  it('необязательные параметры в запрос не попадают', async () => {
    const stub = await stubServer((_exchange, response) => sendJson(response, 200, { data: [{ b64_json: PNG.toString('base64') }] }))
    const result = await drawPictures(`${stub.origin}/api/v1`, KEY, { model: 'demo/painter', prompt: 'кот' }, new AbortController().signal)
    expect(stub.seen[0]!.body).toEqual({ model: 'demo/painter', prompt: 'кот' })
    expect(result).not.toHaveProperty('cost')
  })

  it('пересказывает отказ RouterAI и не принимает ответ без растровых картинок', async () => {
    const signal = new AbortController().signal
    const refused = await stubServer((_exchange, response) => sendJson(response, 402, { error: { message: 'Недостаточно средств на балансе', code: 402 } }))
    await expect(drawPictures(`${refused.origin}/api/v1`, KEY, { model: 'm/x', prompt: 'p' }, signal)).rejects.toMatchObject({ message: 'Недостаточно средств на балансе', status: 402 })

    const flat = await stubServer((_exchange, response) => sendJson(response, 401, { error: '401 Unauthorized' }))
    await expect(drawPictures(`${flat.origin}/api/v1`, KEY, { model: 'm/x', prompt: 'p' }, signal)).rejects.toThrow('401 Unauthorized')

    const vector = await stubServer((_exchange, response) => sendJson(response, 200, { data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }))
    await expect(drawPictures(`${vector.origin}/api/v1`, KEY, { model: 'm/x', prompt: 'p' }, signal)).rejects.toBeInstanceOf(MediaError)
  })

  it('определяет тип картинки по содержимому', () => {
    expect(sniffPictureType(new Uint8Array(PNG))).toBe('image/png')
    expect(sniffPictureType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffPictureType(new Uint8Array(Buffer.from('GIF89a')))).toBe('image/gif')
    expect(sniffPictureType(new Uint8Array(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')))).toBe('image/webp')
    expect(sniffPictureType(new Uint8Array(Buffer.from('<svg xmlns')))).toBeUndefined()
  })

  it('даёт файлу понятное имя', () => {
    const now = new Date('2026-11-14T09:30:05Z')
    expect(fileStem('Hero Banner.PNG', 'что угодно', now)).toBe('hero-banner')
    expect(fileStem(undefined, 'A red cat in a spacesuit, digital art', now)).toBe('a-red-cat-in-20261114-093005')
    expect(fileStem('', 'рыжий кот в скафандре', now)).toBe('image-20261114-093005')
    expect(fileStem('../../etc/passwd', 'x', now)).toBe('etc-passwd')
  })
})

describe('распознавание речи', () => {
  it('отправляет запись в base64 и возвращает текст, длительность и стоимость', async () => {
    const stub = await stubServer((_exchange, response) => sendJson(response, 200, { text: ' Привет, мир. ', usage: { seconds: 2, cost: 0.0007 } }))
    const wav = silence(2)
    const heard = await recognizeSpeech(`${stub.origin}/api/v1`, KEY, { model: 'demo/listener', wav, language: 'ru' }, new AbortController().signal)
    expect(heard).toEqual({ text: 'Привет, мир.', seconds: 2, cost: 0.0007 })
    const sent = stub.seen[0]!
    expect(sent.path).toBe('/api/v1/audio/transcriptions')
    expect(sent.body).toMatchObject({ model: 'demo/listener', language: 'ru', input_audio: { format: 'wav' } })
    expect(Buffer.from(sent.body.input_audio.data, 'base64').equals(Buffer.from(wav))).toBe(true)
  })

  it('без языка не подсказывает его; пустой ответ — пустой текст', async () => {
    const stub = await stubServer((_exchange, response) => sendJson(response, 200, {}))
    const heard = await recognizeSpeech(`${stub.origin}/api/v1`, KEY, { model: 'demo/listener', wav: silence(1) }, new AbortController().signal)
    expect(heard).toEqual({ text: '' })
    expect(stub.seen[0]!.body).not.toHaveProperty('language')
  })

  it('считает длительность записи по заголовку WAV', () => {
    expect(wavSeconds(silence(3))).toBeCloseTo(3)
    expect(wavSeconds(new Uint8Array(10))).toBe(0)
  })
})

describe('видео', () => {
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64)])

  /** Заглушка задачи на видео: статусы по очереди, затем файл. */
  async function studio(statuses: object[]) {
    let polls = 0
    const stub = await stubServer((exchange, response) => {
      if (exchange.method === 'POST' && exchange.path === '/api/v1/videos') return sendJson(response, 202, { id: 'job-1', status: 'queued', polling_url: 'x' })
      if (exchange.path === '/api/v1/videos/job-1') { const state = statuses[Math.min(polls, statuses.length - 1)]; polls += 1; return sendJson(response, 200, { id: 'job-1', ...state }) }
      if (exchange.path === '/api/v1/videos/job-1/content') return void response.writeHead(200, { 'content-type': 'video/mp4' }).end(MP4)
      sendJson(response, 404, {})
    })
    return stub
  }

  it('создаёт задачу, ждёт готовности и скачивает ролик со стоимостью', async () => {
    const stub = await studio([{ status: 'in_progress' }, { status: 'completed', usage: { cost: 1.62 } }])
    const seen: string[] = []
    const film = await makeFilm(`${stub.origin}/api/v1`, KEY, { model: 'demo/director', prompt: 'кот бежит', seconds: 3, aspectRatio: '16:9', resolution: '480p', firstFrame: 'data:image/png;base64,AAAA' },
      new AbortController().signal, { pollMs: 5, onStatus: status => seen.push(status) })
    expect(stub.seen[0]!.body).toEqual({
      model: 'demo/director', prompt: 'кот бежит', duration: 3, aspect_ratio: '16:9', resolution: '480p',
      frame_images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, frame_type: 'first_frame' }],
    })
    expect(seen).toEqual(['queued', 'in_progress', 'completed'])
    expect(film).toMatchObject({ jobId: 'job-1', cost: 1.62 })
    expect(Buffer.from(film.bytes).equals(MP4)).toBe(true)
    expect(stub.seen.every(exchange => exchange.headers.authorization === `Bearer ${KEY}`)).toBe(true)
  })

  it('сообщает причину, если задача не удалась, и не ждёт дольше отведённого', async () => {
    const failed = await studio([{ status: 'failed', error: 'content policy' }])
    await expect(makeFilm(`${failed.origin}/api/v1`, KEY, { model: 'm/x', prompt: 'p' }, new AbortController().signal, { pollMs: 5 })).rejects.toThrow('RouterAI не снял видео: content policy')
    const slow = await studio([{ status: 'in_progress' }])
    await expect(makeFilm(`${slow.origin}/api/v1`, KEY, { model: 'm/x', prompt: 'p' }, new AbortController().signal, { pollMs: 5, patienceMs: 30 })).rejects.toThrow(/не было готово/)
  })

  it('отмена прекращает ожидание', async () => {
    const stub = await studio([{ status: 'in_progress' }])
    const controller = new AbortController()
    const pending = makeFilm(`${stub.origin}/api/v1`, KEY, { model: 'm/x', prompt: 'p' }, controller.signal, { pollMs: 10_000 })
    setTimeout(() => { controller.abort(new Error('пользователь остановил')) }, 30)
    await expect(pending).rejects.toThrow('пользователь остановил')
  })

  it('подбирает ближайшую допустимую длительность', () => {
    expect(fitDuration(4, [3, 5, 10])).toBe(3)
    expect(fitDuration(8, [3, 5, 10])).toBe(10)
    expect(fitDuration(undefined, [5, 10])).toBe(5)
    expect(fitDuration(7, undefined)).toBe(7)
    expect(fitDuration(undefined, undefined)).toBeUndefined()
  })

  it('первый кадр берёт только из рабочего каталога и только картинку', async () => {
    const root = await scratchDir()
    const workspace = `${root}/project`
    await mkdir(`${workspace}/art`, { recursive: true })
    await writeFile(`${workspace}/art/cat.png`, PNG)
    await writeFile(`${workspace}/notes.txt`, 'не картинка')
    await writeFile(`${root}/secret.png`, PNG)
    await symlink(`${root}/secret.png`, `${workspace}/link.png`)

    expect(await readFrame(workspace, 'art/cat.png')).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(await readFrame(workspace, `${workspace}/art/cat.png`)).toMatch(/^data:image\/png;base64,/)
    await expect(readFrame(workspace, '../secret.png')).rejects.toThrow(/внутри рабочего каталога/)
    await expect(readFrame(workspace, 'link.png')).rejects.toThrow(/внутри рабочего каталога/)
    await expect(readFrame(workspace, 'notes.txt')).rejects.toThrow(/должен быть картинкой/)
    await expect(readFrame(workspace, 'нет-такого.png')).rejects.toThrow(/не найден/)
  })
})
