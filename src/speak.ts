// Инструмент агента «озвучить текст»: RouterAI синтезирует речь, аудиофайл сохраняется в проект.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { fileStem } from './files.ts'
import { MEDIA_FOLDER, SPEAK_TOOL } from './links.ts'
import { speakText } from './media.ts'
import { rub } from './money.ts'
import { registerLiveTool } from './toolkit.ts'

export interface SpeakDeps {
  apiBase: string
  readKey(): Promise<string | undefined>
  /** Модель озвучки из настроек; null — озвучка выключена. */
  voiceModel(): string | null
  /** Голос по умолчанию из настроек. */
  voice(): string
  charged(sessionId: string, model: string, rub: number): void
  watch(listener: () => void): () => void
}

/** Длиннее этого текст не отправляем: случайная озвучка целого файла стоила бы заметных денег. */
const TEXT_LIMIT = 6000

interface SpokenResult {
  model: string
  voice: string
  cost: number | null
  file: string
  seconds: number | null
}

function buildSpeakTool(ctx: Context, deps: SpeakDeps): ToolDefinition {
  const model = deps.voiceModel()
  return defineTool({
    name: SPEAK_TOOL,
    description: 'Озвучить текст: синтезировать речь и сохранить аудиофайл в папку '
      + `${MEDIA_FOLDER} рабочего каталога. Подходит для озвучки ролика, автоответчика, подкаста, демо. Вызов платный.`
      + (model === null ? '' : ` Сейчас выбрана модель ${model}, голос "${deps.voice()}".`),
    parameters: {
      text: { type: 'string', required: true, description: `Текст для озвучки, до ${TEXT_LIMIT} символов. Пиши так, как должно прозвучать: числа и сокращения лучше расшифровать словами.` },
      voice: { type: 'string', description: `Идентификатор голоса, если нужен не тот, что выбран в настройках ("${deps.voice()}"). У каждой модели свой набор голосов; не выдумывай идентификатор — указывай только тот, что назвал пользователь.` },
      file_name: { type: 'string', description: 'Имя файла без расширения, латиницей.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          voice: { type: 'string', required: true },
          cost: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          file: { type: 'string', required: true },
          seconds: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => {
        const spoken = value as unknown as SpokenResult
        const parts = [`Аудио готово: ${spoken.file}`, `модель ${spoken.model}, голос ${spoken.voice}`]
        if (spoken.seconds !== null) parts.push(`длительность ${Math.round(spoken.seconds)} с`)
        if (spoken.cost !== null) parts.push(`стоимость ${rub(spoken.cost)}`)
        return [{ type: 'text', text: `${parts.join('; ')}.` }]
      },
      presentationMeta: (_args, value) => {
        const spoken = value as unknown as SpokenResult
        return { model: `${spoken.model} · ${spoken.voice}`, cost: spoken.cost, files: [spoken.file] }
      },
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'other', title: `Озвучиваю: ${args.text.length > 80 ? `${args.text.slice(0, 79)}…` : args.text}` }),
    execute: async (args, run) => {
      const chosen = deps.voiceModel()
      if (chosen === null) throw new Error('Озвучка выключена в Настройках → RouterAI.')
      const key = await deps.readKey()
      if (key === undefined) throw new Error('Нет ключа RouterAI. Войдите: Настройки → RouterAI или команда /routerai login.')
      const text = args.text.trim()
      if (text === '') throw new Error('Нечего озвучивать: текст пустой.')
      if (text.length > TEXT_LIMIT) throw new Error(`Текст длиннее ${TEXT_LIMIT} символов (${text.length}). Разбейте его на части и озвучьте по отдельности.`)
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined || run.agent === undefined) throw new Error('Некуда сохранить аудио: у сессии нет рабочего каталога.')

      const voice = args.voice?.trim() || deps.voice()
      const spoken = await speakText(deps.apiBase, key, { model: chosen, text, voice }, run.signal)
      const folder = join(await workingDirectory.ensure(run.agent, run.signal), MEDIA_FOLDER)
      await mkdir(folder, { recursive: true })
      const file = join(folder, `${fileStem(args.file_name, text)}.${spoken.format}`)
      await writeFile(file, spoken.bytes)
      if (spoken.cost !== undefined) deps.charged(String(run.agent.id), chosen, spoken.cost)
      const result: SpokenResult = { model: chosen, voice, cost: spoken.cost ?? null, file, seconds: spoken.seconds ?? null }
      return result as never
    },
  })
}

export function registerSpeakTool(ctx: Context, deps: SpeakDeps): void {
  registerLiveTool(ctx, {
    label: 'routerai: speak tool',
    build: () => buildSpeakTool(ctx, deps),
    enabled: () => deps.voiceModel() !== null,
    signature: () => JSON.stringify([deps.voiceModel(), deps.voice()]),
    watch: deps.watch,
  })
}
