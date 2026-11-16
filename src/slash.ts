// Команда /routerai — всё то же, что в разделе настроек, но из чата (и там, где интерфейса нет).
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { loadAccount, looksLikeApiKey } from './account.ts'
import type { AccountView } from './account.ts'
import { isChatModel } from './catalog.ts'
import type { ModelCard, ModelCatalog } from './catalog.ts'
import { BILLING_PAGE, KEYS_PAGE } from './links.ts'
import { pricePair, rub, windowLabel } from './money.ts'
import { openBrowser, startSignIn } from './signin.ts'
import type { PendingSignIn } from './signin.ts'

export interface SlashDeps {
  apiBase: string
  credentialName: string
  readKey(): Promise<string | undefined>
  storeKey(key: string): Promise<void>
  forgetKey(): Promise<void>
  pickerModels(): readonly string[]
  catalog: ModelCatalog
  signInPort?: number
  signInHost?: string
  /** Имя приложения для страницы согласия. */
  appName?(): Promise<string>
  /** Открыть адрес в браузере; `false` — открыть нечем. По умолчанию — системный браузер. */
  openBrowser?(url: string): Promise<boolean>
}

const USAGE = `Команда /routerai:
  login            войти через routerai.ru — ключ выдаст сайт
  code <код>       завершить вход кодом со страницы RouterAI (когда браузер на другой машине)
  key sk-…         сохранить ключ, созданный вручную
  logout           удалить сохранённый ключ
  status           баланс аккаунта и состояние ключа
  models           модели, которые показывает пикер
  find <текст>     поиск по каталогу RouterAI`

const PERIODS = { daily: 'в сутки', weekly: 'в неделю', monthly: 'в месяц', other: '' } as const

/** Состояние аккаунта текстом — для чата. */
export function accountReport(account: AccountView): string {
  if (account.state === 'rejected') return 'RouterAI не принимает этот ключ: его отозвали или удалили. Получите новый командой /routerai login.'
  if (account.state === 'offline') return `Не удалось связаться с RouterAI (${account.notes.join('; ')}).`
  const lines: string[] = []
  if (account.balance !== undefined) lines.push(`На счёте ${rub(account.balance)}.`)
  const key = account.key
  if (key !== undefined) {
    const name = key.label === '' ? 'Ключ' : `Ключ «${key.label}»`
    if (key.disabled) lines.push(`${name} отключён — включить можно на ${KEYS_PAGE}.`)
    lines.push(key.cap === undefined
      ? `${name} без лимита расходов.`
      : `${name}: лимит ${rub(key.cap.amount)} ${PERIODS[key.cap.period]}`.trimEnd() + `, осталось ${rub(key.cap.left)}.`)
    lines.push(`Потрачено по ключу: ${rub(key.spent)}, за месяц ${rub(key.spentThisMonth)}.`)
  }
  lines.push(...account.notes.map(note => `Часть данных недоступна: ${note}`))
  lines.push(`Пополнение: ${BILLING_PAGE}`)
  return lines.join('\n')
}

function modelLine(card: ModelCard): string {
  const facts = [card.slug, pricePair(card.price) && `${pricePair(card.price)} за 1М токенов`, windowLabel(card.window), card.tools ? '' : 'без инструментов']
  return facts.filter(fact => fact !== '').join(' · ')
}

export function registerSlashCommand(ctx: Context, deps: SlashDeps): void {
  const good = (text: string): CommandResult => ({ kind: 'success', text })
  const bad = (text: string): CommandResult => ({ kind: 'error', text })

  /** Вход, который ждёт код от пользователя: между командами `login`/`code` и `code <код>`. */
  let byCode: PendingSignIn | undefined

  const named = async () => (deps.appName === undefined ? {} : { appName: await deps.appName() })

  function awaitCode(attempt: PendingSignIn): CommandResult {
    byCode?.cancel()
    byCode = attempt
    attempt.key.catch(() => {}).finally(() => { if (byCode === attempt) byCode = undefined })
    return good(`Откройте в браузере страницу входа и подтвердите доступ:\n${attempt.codeUrl}\n\nRouterAI покажет код. Вставьте его сюда: /routerai code <код>\nКод действует 5 минут.`)
  }

  async function signedIn(key: string): Promise<CommandResult> {
    await deps.storeKey(key)
    return good(`Вы вошли в RouterAI, ключ сохранён как ${deps.credentialName}.\n${accountReport(await loadAccount(deps.apiBase, key))}`)
  }

  async function run(verb: string, argument: string, signal: AbortSignal): Promise<CommandResult> {
    switch (verb) {
      case 'login': {
        byCode?.cancel()
        byCode = undefined
        const attempt = await startSignIn(deps.apiBase, {
          ...await named(),
          ...deps.signInPort === undefined ? {} : { port: deps.signInPort },
          ...deps.signInHost === undefined ? {} : { host: deps.signInHost },
        })
        // Браузера на этой машине может не быть (контейнер, SSH) — тогда вход завершается кодом.
        if (attempt.url === null || !(await (deps.openBrowser ?? openBrowser)(attempt.url))) return awaitCode(attempt)
        signal.addEventListener('abort', attempt.cancel, { once: true })
        ctx.logger.info(`[routerai] страница входа: ${attempt.url}`)
        return signedIn(await attempt.key)
      }
      case 'code': {
        if (argument === '') return awaitCode(await startSignIn(deps.apiBase, { receiver: false, ...await named() }))
        const attempt = byCode
        if (attempt === undefined) return bad('Вход по коду не начат. Выполните /routerai code без кода — команда даст ссылку.')
        await attempt.submit(argument)
        byCode = undefined
        return signedIn(await attempt.key)
      }
      case 'key': {
        if (!looksLikeApiKey(argument)) return bad(`Нужен ключ RouterAI вида sk-… Создать его можно на ${KEYS_PAGE}`)
        await deps.storeKey(argument)
        return good(`Ключ сохранён как ${deps.credentialName}.`)
      }
      case 'logout': {
        await deps.forgetKey()
        return good(`Ключ ${deps.credentialName} удалён из DeepSeek Harness. Если он задан переменной окружения или в .env, уберите его и оттуда.`)
      }
      case 'status': {
        const key = await deps.readKey()
        if (key === undefined) return bad('Ключа RouterAI пока нет. Войдите: /routerai login')
        return good(accountReport(await loadAccount(deps.apiBase, key)))
      }
      case 'models': {
        await deps.catalog.sync()
        const lines = deps.pickerModels().map((slug) => {
          const card = deps.catalog.find(slug)
          return card === undefined ? `${slug} · в каталоге не найдена` : modelLine(card)
        })
        return good(`${lines.join('\n')}\n\nСписок меняется в Настройках → RouterAI.`)
      }
      case 'find': {
        await deps.catalog.sync()
        const needle = argument.toLowerCase()
        const hits = deps.catalog.all().filter(isChatModel).filter(card => `${card.slug} ${card.maker} ${card.title}`.toLowerCase().includes(needle))
        if (hits.length === 0) return bad(`По запросу «${argument}» в каталоге RouterAI ничего нет.`)
        const shown = hits.slice(0, 30).map(modelLine)
        if (hits.length > shown.length) shown.push(`…и ещё ${hits.length - shown.length}. Уточните запрос.`)
        return good(shown.join('\n'))
      }
      default:
        return good(USAGE)
    }
  }

  ctx.commands.register({
    name: 'routerai',
    description: 'RouterAI: вход, баланс, модели',
    input: { hint: 'login | code <код> | key sk-… | logout | status | models | find <текст>' },
    // В аргументах бывает ключ — в журнал сессии строка не попадает.
    recordInput: false,
    handler: async ({ rawInput, signal }) => {
      const text = rawInput.trim()
      const gap = text.search(/\s/)
      const verb = (gap === -1 ? text : text.slice(0, gap)).toLowerCase()
      const argument = gap === -1 ? '' : text.slice(gap).trim()
      try {
        return await run(verb, argument, signal)
      } catch (error) {
        return bad(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
