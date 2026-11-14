// Маршрут `routerai` для адаптера pi-ai: модели каталога в формате pi-ai и профиль провайдера.
// RouterAI говорит на Chat Completions в диалекте OpenRouter, поэтому работает штатная
// реализация `openai-completions` из pi-ai — плагин только описывает ей модели.
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { Api, Model, OpenAICompletionsCompat, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { ModelCard } from './catalog.ts'
import { ROUTE } from './links.ts'

export const PROVIDER_NAME = 'RouterAI'

/** Каталог не сообщает предел вывода; этого хватает на длинные правки и не упирается в лимиты апстримов. */
const OUTPUT_CEILING = 32_768
/** Окно для модели, о которой каталог ещё ничего не сказал. */
const UNKNOWN_WINDOW = 128_000

function wireDialect(slug: string): OpenAICompletionsCompat {
  const dialect: OpenAICompletionsCompat = {
    // Усилие рассуждения уходит объектом `reasoning: { effort }`.
    thinkingFormat: 'openrouter',
    supportsReasoningEffort: true,
    // Расход токенов приходит последним чанком стрима.
    supportsUsageInStreaming: true,
    maxTokensField: 'max_tokens',
    // Расширения OpenAI, которые через агрегатор понимают не все поставщики.
    supportsStore: false,
    supportsDeveloperRole: false,
  }
  // Разметка `cache_control` нужна только моделям Anthropic; остальные кэшируют сами.
  if (/^~?anthropic\//.test(slug)) dialect.cacheControlFormat = 'anthropic'
  return dialect
}

/** RouterAI принимает усилия low/medium/high; прочие уровни harness модели не предлагает. */
function thinkingLevels(): ThinkingLevelMap {
  return { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }
}

export function describeModel(card: ModelCard, apiBase: string): Model<Api> {
  const window = card.window ?? UNKNOWN_WINDOW
  const model = {
    id: card.slug,
    name: card.title,
    provider: ROUTE,
    api: 'openai-completions',
    baseUrl: apiBase,
    input: card.vision ? ['text', 'image'] : ['text'],
    contextWindow: window,
    maxTokens: Math.min(OUTPUT_CEILING, window),
    reasoning: card.reasoning,
    // Цены каталога рублёвые, а pi-ai считает в своей валюте: стоимость ведёт сам плагин (costs.ts).
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: wireDialect(card.slug),
    ...card.reasoning ? { thinkingLevelMap: thinkingLevels() } : {},
  }
  return model as Model<Api>
}

/** Модель из списка пользователя, пока каталог не загрузился: консервативные возможности. */
export function describeUnknownModel(slug: string, apiBase: string): Model<Api> {
  return describeModel({ slug, title: slug, maker: '', alias: slug.startsWith('~'), tools: true, reasoning: false, vision: false, makes: ['text'] }, apiBase)
}

/**
 * pi-ai умеет сам искать ключи в окружении и на диске. Этому маршруту это не нужно и вредно:
 * ключ всегда выдаёт harness, поэтому pi-ai получает пустое хранилище и «слепой» контекст.
 */
export const isolatedAuth: PiAiAdapterOptions['auth'] = {
  credentials: new InMemoryCredentialStore(),
  authContext: { env: async () => undefined, fileExists: async () => false },
}

export function buildRoute(models: readonly Model<Api>[], apiBase: string, credential: CredentialRef): ResolvedPiAiProviderProfile {
  const provider = createProvider({
    id: ROUTE,
    name: PROVIDER_NAME,
    baseUrl: apiBase,
    models: [...models],
    api: openAICompletionsApi(),
    auth: {
      apiKey: {
        name: PROVIDER_NAME,
        // Ключ уже разрешён harness и приходит с запросом — остаётся передать его дальше.
        resolve: async ({ credential: given }) => ({ auth: given?.key === undefined ? {} : { apiKey: given.key }, source: PROVIDER_NAME }),
      },
    },
  })
  return {
    provider: ROUTE,
    displayName: PROVIDER_NAME,
    apiKeyEnv: credential,
    piProvider: provider,
    retryPolicy: resolveRetryPolicy(undefined, 'llm-routerai.retryPolicy'),
    // Те же пределы, что harness ставит маршрутам pi-ai по умолчанию.
    streamIdleTimeoutMs: 300_000,
    maxRequestImages: 50,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImageMaxBytes: 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    imageOffloadCountQuantum: 10,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
  }
}
