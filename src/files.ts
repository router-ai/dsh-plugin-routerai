// Файлы проекта для инструментов рисования и видео: имена результатов и чтение исходных картинок.
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { sniffPictureType } from './media.ts'

const PICTURE_LIMIT = 10 * 1024 * 1024

/** Имя файла из пожелания модели или из описания: латиница, цифры, дефисы. */
export function fileStem(wish: string | undefined, prompt: string, now = new Date()): string {
  const base = (wish ?? '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  if (base !== '') return base
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const words = prompt.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 4).join('-') ?? ''
  return words === '' ? `image-${stamp}` : `${words.slice(0, 40)}-${stamp}`
}

/**
 * Прочитать картинку проекта в виде data-URI — так RouterAI принимает исходные изображения.
 * Файлы вне рабочего каталога не читаются: агент не должен отправлять наружу что попало.
 */
export async function readPicture(workspace: string, path: string, role = 'Картинка'): Promise<string> {
  const root = await realpath(workspace)
  const target = await realpath(isAbsolute(path) ? path : resolve(root, path)).catch(() => {
    throw new Error(`${role}: файл не найден — ${path}`)
  })
  const inside = relative(root, target)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${role}: файл должен лежать внутри рабочего каталога проекта — ${path}`)
  const bytes = await readFile(target)
  if (bytes.byteLength > PICTURE_LIMIT) throw new Error(`${role}: файл больше 10 МБ — ${path}`)
  const type = sniffPictureType(bytes)
  if (type === undefined || type === 'image/svg+xml') {
    throw new Error(`${role}: нужна картинка PNG, JPEG, WebP или GIF — ${path}${extname(path) === '' ? '' : ` (${extname(path)})`}`)
  }
  return `data:${type};base64,${bytes.toString('base64')}`
}
