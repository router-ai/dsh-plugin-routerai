// Метка установки. RouterAI выдаёт приложению один ключ на имя и при повторном входе перевыпускает его,
// поэтому у каждой установки плагина имя своё: вход на втором компьютере не отключает ключ первого.
import { randomBytes } from 'node:crypto'
import { JsonFile } from './storage.ts'

const LABEL = /^[a-z0-9-]{2,24}$/

interface Install {
  id: string
}

function newLabel(): string {
  // Четыре знака без похожих друг на друга символов: метку читает человек в списке ключей.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  return [...randomBytes(4)].map(byte => alphabet[byte % alphabet.length]).join('')
}

/** Прочитать метку установки или создать её при первом обращении. */
export function installLabel(file: string): () => Promise<string> {
  const store = new JsonFile<Install>(file, (raw) => {
    const id = (raw as Partial<Install> | null)?.id
    return typeof id === 'string' && LABEL.test(id) ? { id } : undefined
  })
  let known: Promise<string> | undefined
  return () => {
    known ??= (async () => {
      const saved = await store.read()
      if (saved !== undefined) return saved.id
      const id = newLabel()
      // Не удалось записать — метка проживёт до перезапуска; вход от этого не ломается.
      await store.write({ id }).catch(() => {})
      return id
    })()
    return known
  }
}
