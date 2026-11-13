// Общее для тестов: временный каталог, образец каталога RouterAI и маленький HTTP-сервер-заглушка.
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { readModelList } from '../src/catalog.ts'

export const sampleCards = () => readModelList(JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url), 'utf8')))

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

export async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'routerai-test-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export interface Exchange {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: any
}

/** Поднять заглушку на случайном порту; `respond` решает, что ответить. Останавливается после теста. */
export async function stubServer(respond: (exchange: Exchange, response: ServerResponse) => void): Promise<{ origin: string; seen: Exchange[] }> {
  const seen: Exchange[] = []
  const server = createServer((request, response) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      const text = Buffer.concat(parts).toString()
      const exchange: Exchange = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, body: text === '' ? undefined : JSON.parse(text) }
      seen.push(exchange)
      respond(exchange, response)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}
