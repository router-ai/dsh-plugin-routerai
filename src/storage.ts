// Небольшое файловое хранилище состояния плагина: один JSON-документ на файл.
// Запись идёт во временный файл с последующей подменой, чтобы обрыв питания или
// параллельная запись не оставили на диске половину документа.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Коды, с которыми Windows отказывает в подмене файла, пока его держит другой процесс. */
const BUSY_CODES = ['EBUSY', 'EPERM', 'EACCES']
const RENAME_ATTEMPTS = 10

let sequence = 0

async function swapIn(temporary: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retriable = process.platform === 'win32' && code !== undefined && BUSY_CODES.includes(code)
      if (!retriable || attempt === RENAME_ATTEMPTS) throw error
      await new Promise(resolve => setTimeout(resolve, 40 * attempt))
    }
  }
}

export class JsonFile<T> {
  /** Записи одного файла выстраиваются в очередь: последняя запись побеждает предсказуемо. */
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param path - путь к файлу.
   * @param accept - проверка прочитанного: возвращает значение или undefined, если документ не годится.
   */
  constructor(readonly path: string, private readonly accept: (raw: unknown) => T | undefined) {}

  /** Прочитать документ; undefined, если файла нет, он повреждён или не прошёл проверку. */
  async read(): Promise<T | undefined> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return undefined
    }
    try {
      return this.accept(JSON.parse(text))
    } catch {
      return undefined
    }
  }

  write(value: T): Promise<void> {
    const body = `${JSON.stringify(value, null, 1)}\n`
    const job = this.queue.then(() => this.replace(body))
    this.queue = job.catch(() => {})
    return job
  }

  private async replace(body: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    sequence += 1
    const temporary = `${this.path}.${process.pid}-${sequence}.part`
    try {
      await writeFile(temporary, body, 'utf8')
      await swapIn(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}
