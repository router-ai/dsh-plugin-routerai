/**
 * RouterAI — провайдер моделей для DeepSeek Harness.
 *
 * Плагин регистрирует маршрут `routerai`: запросы уходят в OpenAI-совместимый API RouterAI
 * через штатный адаптер pi-ai. Сверх этого плагин следит за каталогом моделей и ценами,
 * помогает получить ключ через браузер, показывает баланс и считает стоимость сессий,
 * даёт агенту инструменты для рисования картинок и съёмки видео и распознаёт речь для голосового ввода.
 *
 * Настройка из файла (обычно всё делается в Настройках → RouterAI):
 *
 * ```yaml
 * - id: llm-routerai
 *   config:
 *     models: [anthropic/claude-sonnet-5.5, deepseek/deepseek-v4.1-flash]
 * ```
 *
 * @module @router-ai/dsh-plugin-routerai
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type {} from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import z from '@deepseek-ai/schemastery'
import { RouterAiAdapter } from './adapter.ts'
import { Bridge } from './bridge.ts'
import { isChatModel, ModelCatalog } from './catalog.ts'
import { CostBook } from './costs.ts'
import { registerDrawTool } from './draw.ts'
import { registerFilmTool } from './film.ts'
import { API_BASE, KEYS_PAGE, ROUTE } from './links.ts'
import { pricePair, windowLabel } from './money.ts'
import { PreferenceStore } from './preferences.ts'
import { buildRoute, describeModel, describeUnknownModel, isolatedAuth } from './provider.ts'
import { registerSlashCommand } from './slash.ts'
import { registerSpeechProvider } from './speech.ts'
import { STARTER_MODELS } from './starter.ts'

export const name = 'llm-routerai'
export const inject = ['llm']

export interface Config {
  /** Модели пикера, пока пользователь не выбрал свои в настройках. */
  models: Volatile<string[]>
  /** Под каким именем искать ключ в хранилище учётных данных, окружении и .env. */
  apiKeyEnv: string
  baseURL: string
  /** Как часто сверять каталог моделей с RouterAI, часы. */
  catalogRefreshHours: number
}

export const Config: z<Config> = z.object({
  models: z.array(z.string()).default([...STARTER_MODELS]).volatile()
    .description('Модели RouterAI в пикере, по порядку. Выбор в Настройках → RouterAI имеет приоритет.'),
  apiKeyEnv: z.string().default('ROUTERAI_API_KEY')
    .description('Имя, под которым хранится ключ RouterAI (sk-…): учётные данные harness, переменная окружения или .env.'),
  baseURL: z.string().default(API_BASE)
    .description('Адрес API RouterAI.'),
  catalogRefreshHours: z.number().min(0.25).default(4)
    .description('Как часто обновлять каталог моделей и цены, в часах.'),
}) as unknown as z<Config>

/** Каталог состояния плагина внутри дома harness. */
function stateDir(): string {
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'routerai')
}

/** Запросы на заголовок сессии и сжатие контекста: им хватает недорогой модели. */
const UTILITY_PURPOSES = new Set(['session-title', 'compaction'])

export function apply(ctx: Context, config: Config): void {
  const apiBase = config.baseURL.replace(/\/+$/, '')
  const credential = credentialRef(config.apiKeyEnv)
  const home = stateDir()
  const hours = (value: number) => value * 3_600_000

  const catalog = new ModelCatalog({ apiBase, file: join(home, 'catalog.json'), maxAgeMs: hours(config.catalogRefreshHours) })
  const preferences = new PreferenceStore(join(home, 'preferences.json'), () => config.models.get() ?? [])
  const costs = new CostBook(join(home, 'costs.json'), error => ctx.logger.warn('[routerai] не удалось сохранить расход: %s', String(error)))

  // Хранилище ключей, вложения и файловая система — необязательные сервисы harness.
  // Плагин получает их через ctx.inject и работает без них там, где их нет (например, в headless).
  const optional: { credentials?: Context['credentials']; attachments?: Context['attachments']; fs?: Context['fs'] } = {}
  const adopt = <K extends keyof typeof optional>(service: K) => {
    ctx.inject([service], (scope) => {
      scope.effect(() => {
        optional[service] = scope.get(service) as (typeof optional)[K]
        return () => { delete optional[service] }
      }, `routerai: ${service}`)
    })
  }
  adopt('credentials')
  adopt('attachments')
  adopt('fs')

  // ---- маршрут ---------------------------------------------------------------------------
  // Адаптер спрашивает профиль на каждом запросе, поэтому он собирается заранее и
  // пересобирается только когда меняется каталог, выбор моделей или конфигурация.
  let route: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const warnedAbout = new Set<string>()
  const routeChanged = () => {
    route = undefined
    ctx.emit('llm/models-updated', ROUTE)
  }

  const currentRoute = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    if (route !== undefined) return route
    const wanted = new Set(preferences.pickerModels())
    // Служебная модель должна быть известна маршруту, даже если в пикере её нет.
    const utility = preferences.current.utilityModel
    if (utility !== null) wanted.add(utility)
    const models = []
    for (const slug of wanted) {
      const card = catalog.find(slug)
      if (card !== undefined && isChatModel(card)) {
        models.push(describeModel(card, apiBase))
      } else if (catalog.size === 0) {
        models.push(describeUnknownModel(slug, apiBase))
      } else if (!warnedAbout.has(slug)) {
        warnedAbout.add(slug)
        ctx.logger.warn(`[routerai] ${slug}: в каталоге RouterAI нет такой чат-модели — в пикер она не попадёт`)
      }
    }
    route = new Map([[ROUTE, buildRoute(models, apiBase, credential)]])
    return route
  }

  // ---- ключ ------------------------------------------------------------------------------
  const readKey = async (): Promise<string | undefined> => {
    const found = optional.credentials !== undefined
      ? await optional.credentials.resolve(credential)
      : launchEnvironmentOf(ctx).get(credential)
    const value = found?.value
    return value === undefined || value === '' ? undefined : assertUsableApiKey(value, name, config.apiKeyEnv)
  }
  const keyVault = () => {
    if (optional.credentials === undefined) throw new Error('В этом режиме DeepSeek Harness нет хранилища ключей — задайте ключ переменной окружения.')
    return optional.credentials
  }
  const storeKey = async (key: string) => {
    await keyVault().set(credential, key)
    ctx.emit('llm/models-updated', ROUTE)
  }
  const forgetKey = async () => {
    await keyVault().unset(credential)
    ctx.emit('llm/models-updated', ROUTE)
  }

  const bridge = new Bridge({
    apiBase, readKey, storeKey, forgetKey, catalog, preferences, costs,
    warn: message => ctx.logger.warn(`[routerai] ${message}`),
  })

  const adapter = new RouterAiAdapter({
    profiles: currentRoute,
    auth: isolatedAuth,
    resolveApiKey: async () => {
      const key = await readKey()
      if (key === undefined) {
        throw new LlmError(
          `Нет ключа RouterAI (${config.apiKeyEnv}). Войдите командой /routerai login или создайте ключ на ${KEYS_PAGE} и сохраните его: /routerai key sk-…`,
          'MISSING_CREDENTIAL',
        )
      }
      return key
    },
    // По этим заголовкам RouterAI показывает в статистике, из какого приложения пришли запросы.
    prepareHeaders: (_request, headers) => {
      headers.set('X-Title', 'DeepSeek Harness')
      headers.set('HTTP-Referer', 'https://github.com/router-ai/dsh-plugin-routerai')
      return headers
    },
    resolveAttachments: () => optional.attachments,
    resolveImageAccess: (store, ref) => resolveImageAttachmentAccess(store, path => optional.fs?.processPathFromHostPath(path), ref),
    onReplayDegrade: ({ model, reason }) => {
      ctx.logger.warn(`[routerai] ${model}: служебные данные прошлых ответов переданы упрощённо (${reason})`)
    },
  }, {
    caption: (slug) => {
      const card = catalog.find(slug)
      if (card === undefined) return ''
      const price = pricePair(card.price)
      return [price && `${price} за 1М токенов`, card.window && `контекст ${windowLabel(card.window)}`].filter(Boolean).join(' · ')
    },
    offered: slug => preferences.pickerModels().includes(slug),
    spent: (call, tokens) => {
      bridge.noteSuccess()
      if (call.sessionId !== undefined) costs.addCall(String(call.sessionId), call.model, catalog.find(call.model), tokens)
    },
    refused: problem => bridge.noteProblem(problem),
  })

  ctx.llm.registerAdapter([ROUTE], adapter)

  // Заголовки сессий и сжатие контекста — на недорогую модель, если пользователь её не отключил.
  const rerouted = new WeakSet<object>()
  ctx.on('llm/stream', (options, next) => {
    const utility = preferences.current.utilityModel
    const purpose = (options as { purpose?: string }).purpose
    // Подменяем только на модель, которую каталог знает: иначе служебный запрос упал бы целиком.
    const applies = utility !== null && options.provider === ROUTE && options.model !== utility
      && purpose !== undefined && UTILITY_PURPOSES.has(purpose) && !rerouted.has(options)
      && catalog.find(utility) !== undefined
    if (!applies) return next()
    // Уровень рассуждения выбирали под основную модель; служебной он не нужен.
    const { reasoningEffort: _dropped, ...rest } = options
    const replacement = { ...rest, model: utility } as typeof options
    rerouted.add(replacement)
    return ctx.llm.stream(replacement)
  })

  ctx.on('loader/volatile-update', routeChanged)
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === credential) ctx.emit('llm/models-updated', ROUTE)
  })

  ctx.effect(() => {
    const stopWatching = [catalog.watch(routeChanged), preferences.watch(routeChanged)]
    void preferences.restore()
    void costs.restore()
    void catalog.restore().then(() => catalog.sync()).then(() => {
      if (catalog.lastError !== undefined) ctx.logger.warn(`[routerai] ${catalog.lastError}`)
    })
    const timer = setInterval(() => { void catalog.sync() }, hours(config.catalogRefreshHours))
    return () => {
      clearInterval(timer)
      for (const stop of stopWatching) stop()
      void costs.flush()
    }
  }, 'routerai: state')

  ctx.inject(['connection'], (scope) => {
    for (const endpoint of bridge.endpoints()) {
      scope.effect(() => scope.connection.fetch.register({ ...endpoint, requestBody: 'buffered' }), `routerai: ${endpoint.path}`)
    }
  })

  // Инструменты рисования и видео пересобирают своё описание, когда меняется выбранная модель или каталог.
  const watchMedia = (listener: () => void) => {
    const stops = [catalog.watch(listener), preferences.watch(listener)]
    return () => { for (const stop of stops) stop() }
  }

  ctx.inject(['tools'], (scope) => {
    registerDrawTool(scope, {
      apiBase, readKey,
      imageModel: () => preferences.current.imageModel,
      findModel: slug => catalog.find(slug),
      watch: watchMedia,
      attachments: () => optional.attachments,
      charged: (sessionId, model, rub) => { costs.addCharge(sessionId, model, rub) },
    })
    registerFilmTool(scope, {
      apiBase, readKey,
      videoModel: () => preferences.current.videoModel,
      videoBudget: () => preferences.current.videoBudget,
      findModel: slug => catalog.find(slug),
      watch: watchMedia,
      charged: (sessionId, model, rub) => { costs.addCharge(sessionId, model, rub) },
      // Переменная для стенда: мок отвечает мгновенно, ждать по 5 секунд между проверками незачем.
      ...process.env['ROUTERAI_VIDEO_POLL_MS'] === undefined ? {} : { pollMs: Number(process.env['ROUTERAI_VIDEO_POLL_MS']) },
    })
  })

  ctx.inject(['speechToText'], (scope) => {
    registerSpeechProvider(scope, { apiBase, readKey, speechModel: () => preferences.current.speechModel })
  })

  ctx.inject(['commands'], (scope) => {
    registerSlashCommand(scope, {
      apiBase, credentialName: config.apiKeyEnv, readKey, storeKey, forgetKey, catalog,
      pickerModels: () => preferences.pickerModels(),
    })
  })
}
