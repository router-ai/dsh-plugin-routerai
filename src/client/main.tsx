// Браузерная часть плагина: встраивает элементы RouterAI в интерфейс DeepSeek Harness.
// Места встраивания («слоты») объявляют пакеты интерфейса harness; плагин регистрирует в них свои компоненты.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ComponentType } from 'react'
import { MoneyNotice } from './MoneyNotice.tsx'
import { Logo } from './parts.tsx'
import { Remote } from './remote.ts'
import { SessionCost } from './SessionCost.tsx'
import { SettingsPage } from './SettingsPage.tsx'
import { SidebarBalance } from './SidebarBalance.tsx'
import { mountStyles } from './styles.ts'
import { DICTIONARIES, NAMESPACE } from './texts.ts'
import type { Translate } from './texts.ts'

export const name = 'routerai-client'
export const inject = ['slots', 'locale']

const PACKAGE = '@router-ai/dsh-plugin-routerai'

/** Регистрация в слоте: параметры слота и компонент. Набор параметров у каждого слота свой. */
interface Placement {
  slot: string
  options?: Record<string, unknown>
  // Свойства компоненту передаёт harness; здесь их тип не сверить со слотом, сверка — в самих компонентах.
  component: ComponentType<any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function apply(ctx: Context): void {
  // Слоты типизированы закрытой картой harness, которую сторонний плагин расширить не может,
  // поэтому обращаемся к сервисам через минимальные собственные описания.
  const slots = ctx.slots as unknown as {
    inject(slot: string, setup: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  const locale = ctx.locale as unknown as {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): Translate
  }

  ctx.effect(() => locale.register(NAMESPACE, DICTIONARIES), 'routerai: texts')
  ctx.effect(() => mountStyles(PACKAGE), 'routerai: styles')
  const t = locale.bind(NAMESPACE)

  const remote = new Remote()
  ctx.effect(() => remote.run(), 'routerai: remote state')

  const shared = () => ({ remote })
  const placements: Placement[] = [
    { slot: 'settings.section', options: { id: 'routerai', order: 5, label: () => t('section'), inject: shared }, component: SettingsPage },
    { slot: 'settings.section.icon', options: { id: 'routerai' }, component: ({ size }: { size: number }) => <Logo size={size} /> },
    { slot: 'sidebar.footer.action', options: { id: 'routerai-balance', inject: shared }, component: SidebarBalance },
    {
      slot: 'conversation.composer.dock',
      options: { id: 'routerai-session-cost', order: 5, inject: (sessionId?: string) => ({ remote, sessionId }) },
      component: SessionCost,
    },
    {
      slot: 'shell.quota-notice',
      options: {
        // Уведомление о квоте общее для всех провайдеров; своё показываем, только если отказал именно RouterAI.
        select: (owner: { code: string }) => (owner.code === 'QUOTA' && remote.read().overview?.problem != null ? owner : null),
        inject: shared,
      },
      component: MoneyNotice,
    },
  ]

  for (const { slot, options, component } of placements) {
    slots.inject(slot, () => slots.register({ name: slot, locale: NAMESPACE, ...options }, component))
  }
}
