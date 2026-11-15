// Распознавание речи RouterAI как провайдер голосового ввода DeepSeek Harness.
// Голосовой ввод — экспериментальный плагин harness; если он не включён, этот модуль не используется.
import type { Context } from '@deepseek-ai/cordis'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text'
import { recognizeSpeech, wavSeconds } from './media.ts'

export interface SpeechDeps {
  apiBase: string
  readKey(): Promise<string | undefined>
  speechModel(): string
}

export const SPEECH_PROVIDER = 'routerai'

/** Языки, которые предлагает выбор в интерфейсе; `auto` оставляет определение языка модели. */
const LANGUAGES = ['auto', 'ru', 'en', 'de', 'fr', 'es', 'it', 'pt', 'tr', 'uk', 'kk', 'zh', 'ja', 'ko']

export function registerSpeechProvider(ctx: Context, deps: SpeechDeps): void {
  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: { id: SPEECH_PROVIDER as unknown as SpeechProviderId, name: 'RouterAI', location: 'cloud', languages: LANGUAGES },
      transcribe: async (input, signal) => {
        const key = await deps.readKey()
        if (key === undefined) throw new Error('Нет ключа RouterAI. Войдите: Настройки → RouterAI или команда /routerai login.')
        const started = Date.now()
        const heard = await recognizeSpeech(deps.apiBase, key, {
          model: deps.speechModel(),
          wav: input.audio,
          ...input.language === 'auto' || input.language === '' ? {} : { language: input.language },
        }, signal)
        return { text: heard.text, audioSeconds: heard.seconds ?? wavSeconds(input.audio), inferenceSeconds: (Date.now() - started) / 1000 }
      },
    })
    return () => { void unregister() }
  }, 'routerai: speech provider')
}
