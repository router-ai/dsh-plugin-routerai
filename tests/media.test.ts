import { describe, expect, it } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { fileStem } from '../src/draw.ts'
import { clipSeconds, readClip, readFrame } from '../src/film.ts'
import { fitAspectRatio, fitCount, fitDuration, fitImageSize, fitOption, fitResolution, imageSizePixels, ratioValue, resolutionHeight } from '../src/fit.ts'
import { drawPictures, makeFilm, MediaError, recognizeSpeech, sniffPictureType, speakText, wavSeconds } from '../src/media.ts'
import { buildMenu, pickModel } from '../src/toolkit.ts'
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

  it('передаёт размер, качество, фон, формат и исходные картинки', async () => {
    const stub = await stubServer((_exchange, response) => sendJson(response, 200, { data: [{ b64_json: PNG.toString('base64') }] }))
    await drawPictures(`${stub.origin}/api/v1`, KEY, {
      model: 'demo/painter', prompt: 'сделай фон прозрачным', size: '2K', quality: 'high', background: 'transparent', format: 'webp', seed: 42,
      references: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
    }, new AbortController().signal)
    expect(stub.seen[0]!.body).toEqual({
      model: 'demo/painter', prompt: 'сделай фон прозрачным', resolution: '2K', quality: 'high', background: 'transparent', output_format: 'webp', seed: 42,
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }],
    })
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

    const junk = await stubServer((_exchange, response) => sendJson(response, 200, { data: [{ b64_json: Buffer.from('это не картинка').toString('base64') }] }))
    await expect(drawPictures(`${junk.origin}/api/v1`, KEY, { model: 'm/x', prompt: 'p' }, signal)).rejects.toBeInstanceOf(MediaError)
  })

  it('векторную картинку принимает как SVG', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
    const vector = await stubServer((_exchange, response) => sendJson(response, 200, { data: [{ b64_json: Buffer.from(svg).toString('base64') }] }))
    const result = await drawPictures(`${vector.origin}/api/v1`, KEY, { model: 'm/x', prompt: 'p' }, new AbortController().signal)
    expect(result.pictures).toHaveLength(1)
    expect(result.pictures[0]!.type).toBe('image/svg+xml')
    expect(Buffer.from(result.pictures[0]!.bytes).toString()).toBe(svg)
  })

  it('определяет тип картинки по содержимому', () => {
    expect(sniffPictureType(new Uint8Array(PNG))).toBe('image/png')
    expect(sniffPictureType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffPictureType(new Uint8Array(Buffer.from('GIF89a')))).toBe('image/gif')
    expect(sniffPictureType(new Uint8Array(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')))).toBe('image/webp')
    expect(sniffPictureType(new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe('image/svg+xml')
    expect(sniffPictureType(new Uint8Array(Buffer.from('<?xml version="1.0"?>\n<svg/>')))).toBe('image/svg+xml')
    expect(sniffPictureType(new Uint8Array(Buffer.from('просто текст')))).toBeUndefined()
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

  it('передаёт последний кадр, референсы и звук', async () => {
    const stub = await studio([{ status: 'completed' }])
    await makeFilm(`${stub.origin}/api/v1`, KEY, { model: 'demo/director', prompt: 'переход', firstFrame: 'data:image/png;base64,AAAA', lastFrame: 'data:image/png;base64,ZZZZ', audio: false },
      new AbortController().signal, { pollMs: 5 })
    expect(stub.seen[0]!.body).toEqual({
      model: 'demo/director', prompt: 'переход', generate_audio: false,
      frame_images: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, frame_type: 'first_frame' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,ZZZZ' }, frame_type: 'last_frame' },
      ],
    })
    const withSource = await studio([{ status: 'completed' }])
    await makeFilm(`${withSource.origin}/api/v1`, KEY, { model: 'demo/director', prompt: 'продли ролик', sourceVideo: 'data:video/mp4;base64,AAAA', references: ['data:image/png;base64,CCCC'], seed: 7 }, new AbortController().signal, { pollMs: 5 })
    expect(withSource.seen[0]!.body).toEqual({
      model: 'demo/director', prompt: 'продли ролик', seed: 7,
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC' } }, { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }],
    })
    const withReferences = await studio([{ status: 'completed' }])
    await makeFilm(`${withReferences.origin}/api/v1`, KEY, { model: 'demo/director', prompt: 'герой идёт', references: ['data:image/png;base64,CCCC'] }, new AbortController().signal, { pollMs: 5 })
    expect(withReferences.seen[0]!.body).toEqual({ model: 'demo/director', prompt: 'герой идёт', input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC' } }] })
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

  it('подбирает ближайшую допустимую длительность и сообщает о замене', () => {
    expect(fitDuration(4, [3, 5, 10])).toMatchObject({ value: 3, note: expect.stringContaining('взято ближайшее, 3 с') })
    expect(fitDuration(8, [3, 5, 10]).value).toBe(10)
    expect(fitDuration(5, [3, 5, 10])).toEqual({ value: 5 })
    expect(fitDuration(undefined, [5, 10])).toEqual({ value: 5 })
    expect(fitDuration(7, undefined)).toEqual({ value: 7 })
    expect(fitDuration(undefined, undefined).value).toBeUndefined()
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
    await expect(readFrame(workspace, 'notes.txt')).rejects.toThrow(/нужна картинка PNG, JPEG, WebP или GIF/)
    await expect(readFrame(workspace, 'нет-такого.png')).rejects.toThrow(/не найден/)
  })
})

describe('подгонка запроса под модель', () => {
  it('оставляет поддержанное соотношение сторон и подбирает ближайшее к неподдержанному', () => {
    const allowed = ['1:1', '16:9', '9:16', 'auto']
    expect(fitAspectRatio('16:9', allowed)).toEqual({ value: '16:9' })
    expect(fitAspectRatio('AUTO', allowed)).toEqual({ value: 'auto' })
    expect(fitAspectRatio('2:3', allowed)).toMatchObject({ value: '9:16', note: expect.stringContaining('взято ближайшее, 9:16') })
    expect(fitAspectRatio('21:9', allowed).value).toBe('16:9')
    expect(fitAspectRatio('4:5', allowed).value).toBe('1:1')
  })

  it('не вмешивается, когда пожелания нет или модель ограничений не сообщает', () => {
    expect(fitAspectRatio(undefined, ['1:1'])).toEqual({ value: undefined })
    expect(fitAspectRatio('', ['1:1'])).toEqual({ value: undefined })
    expect(fitAspectRatio('7:3', undefined)).toEqual({ value: '7:3' })
    expect(fitAspectRatio('7:3', [])).toEqual({ value: '7:3' })
  })

  it('непонятное пожелание не отправляет и объясняет почему', () => {
    const fitted = fitAspectRatio('широкий', ['1:1', '16:9'])
    expect(fitted.value).toBeUndefined()
    expect(fitted.note).toContain('допустимо: 1:1, 16:9')
  })

  it('подбирает разрешение видео', () => {
    expect(fitResolution('1080p', ['480p', '720p'])).toMatchObject({ value: '720p', note: expect.stringContaining('720p') })
    expect(fitResolution('720p', ['480p', '720p'])).toEqual({ value: '720p' })
    expect(fitResolution('4k', ['720p', '1080p', '4K'])).toEqual({ value: '4K' })
    expect(fitResolution('360p', ['720p', '1080p']).value).toBe('720p')
    expect(fitResolution('2K', ['720p', '1080p', '4K']).value).toBe('1080p')
  })

  it('ограничивает число картинок пределом модели', () => {
    expect(fitCount(3, 1)).toMatchObject({ value: 1, note: expect.stringContaining('не больше 1 картинки') })
    expect(fitCount(3, 6)).toEqual({ value: 3 })
    expect(fitCount(undefined, 4)).toEqual({ value: 1 })
    expect(fitCount(0, 4)).toEqual({ value: 1 })
    expect(fitCount(9, 4).value).toBe(4)
  })

  it('подбирает размер картинки по ближайшему уровню', () => {
    const sizes = ['768', '1K', '1.5K', '2K', '4K']
    expect(fitImageSize('2k', sizes)).toEqual({ value: '2K' })
    expect(fitImageSize('2.5K', sizes)).toMatchObject({ value: '2K', note: expect.stringContaining('взято ближайшее, 2K') })
    expect(fitImageSize('512', sizes).value).toBe('768')
    expect(fitImageSize(undefined, sizes)).toEqual({ value: undefined })
    expect(imageSizePixels('1.5K')).toBe(1536)
    expect(imageSizePixels('768')).toBe(768)
  })

  it('качество, фон и формат применяет только если модель их знает', () => {
    expect(fitOption('Transparent', ['auto', 'transparent', 'opaque'], 'Фон')).toEqual({ value: 'transparent' })
    expect(fitOption('transparent', ['auto', 'opaque'], 'Фон')).toMatchObject({ value: undefined, note: expect.stringContaining('допустимо: auto, opaque') })
    expect(fitOption('high', undefined, 'Качество')).toMatchObject({ value: undefined, note: expect.stringContaining('не поддерживает') })
    expect(fitOption(undefined, ['png'], 'Формат')).toEqual({ value: undefined })
  })

  it('понимает обозначения соотношений и разрешений', () => {
    expect(ratioValue('16:9')).toBeCloseTo(1.7778, 3)
    expect(ratioValue('9:19.5')).toBeCloseTo(0.4615, 3)
    expect(ratioValue('auto')).toBeUndefined()
    expect(resolutionHeight('720p')).toBe(720)
    expect(resolutionHeight('4K')).toBe(2160)
    expect(resolutionHeight('как получится')).toBeUndefined()
  })
})

describe('исходное видео из проекта', () => {
  it('принимает mp4 и webm из рабочего каталога и ничего больше', async () => {
    const root = await scratchDir()
    const workspace = `${root}/project`
    await mkdir(workspace, { recursive: true })
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(32)])
    await writeFile(`${workspace}/clip.mp4`, mp4)
    await writeFile(`${workspace}/clip.webm`, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]))
    await writeFile(`${workspace}/notes.txt`, 'это не видео, а заметки')
    await writeFile(`${root}/outside.mp4`, mp4)
    expect(await readClip(workspace, 'clip.mp4')).toEqual({ url: `data:video/mp4;base64,${mp4.toString('base64')}` })
    expect((await readClip(workspace, 'clip.webm')).url).toMatch(/^data:video\/webm;base64,/)
    await expect(readClip(workspace, 'notes.txt')).rejects.toThrow(/нужен файл MP4 или WebM/)
    await expect(readClip(workspace, '../outside.mp4')).rejects.toThrow(/внутри рабочего каталога/)
    await expect(readClip(workspace, 'missing.mp4')).rejects.toThrow(/не найден/)
  })
})

describe('длительность ролика', () => {
  /** Заголовок mvhd: версия, время создания и изменения, шкала времени, длительность. */
  const mvhd = (version: 0 | 1, scale: number, duration: number) => {
    const body = Buffer.alloc(version === 1 ? 32 : 20)
    body[0] = version
    if (version === 1) { body.writeUInt32BE(scale, 20); body.writeBigUInt64BE(BigInt(duration), 24) } else { body.writeUInt32BE(scale, 12); body.writeUInt32BE(duration, 16) }
    return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(12), Buffer.from('moov'), Buffer.alloc(4), Buffer.from('mvhd'), body])
  }

  it('читается из заголовка MP4 обеих версий', () => {
    expect(clipSeconds(mvhd(0, 1000, 4040))).toBeCloseTo(4.04)
    expect(clipSeconds(mvhd(1, 90_000, 270_000))).toBeCloseTo(3)
  })

  it('неизвестна, если заголовка нет или он оборван', () => {
    expect(clipSeconds(Buffer.from('это не видео'))).toBeUndefined()
    expect(clipSeconds(Buffer.concat([Buffer.from('mvhd'), Buffer.alloc(6)]))).toBeUndefined()
    expect(clipSeconds(mvhd(0, 0, 100))).toBeUndefined()
  })
})

describe('озвучка текста', () => {
  /** Заглушка синтеза: отдаёт аудио с идентификатором генерации и отвечает на запрос её стоимости. */
  async function voiceBooth(reply: { type: string; body: Buffer; cost?: number }) {
    return stubServer((exchange, response) => {
      if (exchange.path === '/api/v1/audio/speech') return void response.writeHead(200, { 'content-type': reply.type, 'x-generation-id': 'gen-voice-1' }).end(reply.body)
      if (exchange.path === '/api/v1/generation?id=gen-voice-1') return sendJson(response, 200, reply.cost === undefined ? { data: {} } : { data: { id: 'gen-voice-1', total_cost: reply.cost } })
      sendJson(response, 404, {})
    })
  }

  it('запрашивает mp3, отдаёт файл как есть и узнаёт стоимость по идентификатору генерации', async () => {
    const mp3 = Buffer.from('ID3-это-как-будто-mp3')
    const stub = await voiceBooth({ type: 'audio/mpeg', body: mp3, cost: 0.048 })
    const spoken = await speakText(`${stub.origin}/api/v1`, KEY, { model: 'x-ai/grok-voice-tts-1.0', text: 'Привет!', voice: 'eve' }, new AbortController().signal)
    expect(stub.seen[0]!.body).toEqual({ model: 'x-ai/grok-voice-tts-1.0', input: 'Привет!', voice: 'eve', response_format: 'mp3' })
    expect(spoken.format).toBe('mp3')
    expect(Buffer.from(spoken.bytes).equals(mp3)).toBe(true)
    expect(spoken.cost).toBe(0.048)
    expect(spoken).not.toHaveProperty('seconds')
  })

  it('у моделей, отдающих только PCM, заворачивает звук в WAV и считает длительность', async () => {
    const pcm = Buffer.alloc(24_000 * 2 * 2) // две секунды, 24 кГц, моно, 16 бит
    const stub = await voiceBooth({ type: 'audio/pcm;rate=24000;channels=1', body: pcm })
    const spoken = await speakText(`${stub.origin}/api/v1`, KEY, { model: 'google/gemini-3.8-flash-tts', text: 'Привет!', voice: 'Kore' }, new AbortController().signal)
    expect(stub.seen[0]!.body.response_format).toBe('pcm')
    expect(spoken.format).toBe('wav')
    expect(spoken.seconds).toBeCloseTo(2)
    expect(Buffer.from(spoken.bytes).subarray(0, 4).toString()).toBe('RIFF')
    expect(wavSeconds(spoken.bytes)).toBeCloseTo(2)
    // Стоимость ещё не посчитана — озвучка всё равно удалась.
    expect(spoken).not.toHaveProperty('cost')
  }, 15_000)

  it('пересказывает отказ RouterAI, например про неизвестный голос', async () => {
    const stub = await stubServer((_exchange, response) => sendJson(response, 400, { error: { message: 'Unknown voice "robot"', code: 400 } }))
    await expect(speakText(`${stub.origin}/api/v1`, KEY, { model: 'm/x', text: 'т', voice: 'robot' }, new AbortController().signal)).rejects.toMatchObject({ message: 'Unknown voice "robot"', status: 400 })
  })
})

describe('выбор модели агентом', () => {
  const cards = new Map([['a/main', { kind: 'image' }], ['b/vector', { kind: 'image' }], ['c/film', { kind: 'video' }]])
  const menu = buildMenu('a/main', ['b/vector', 'c/film', 'd/unknown', 'a/main'], slug => cards.get(slug), card => card.kind === 'image')

  it('в меню попадают основная модель и разрешённые подходящие модели из каталога', () => {
    expect(menu.allowed).toEqual(['a/main', 'b/vector'])
    expect([...menu.cards.keys()]).toEqual(['a/main', 'b/vector'])
  })

  it('берёт выбор агента только из меню', () => {
    expect(pickModel(menu, undefined)).toEqual({ model: 'a/main' })
    expect(pickModel(menu, 'b/vector')).toEqual({ model: 'b/vector' })
    expect(pickModel(menu, 'z/expensive')).toMatchObject({ model: 'a/main', note: expect.stringContaining('не разрешена в настройках') })
  })
})
