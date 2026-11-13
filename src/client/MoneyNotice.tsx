// Сообщение поверх чата, когда RouterAI отказал из-за денег: что случилось и куда идти.
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { BILLING_PAGE, KEYS_PAGE } from '../links.ts'
import { Logo } from './parts.tsx'
import { openTab } from './remote.ts'
import type { Remote } from './remote.ts'
import type { TextKey, Translate } from './texts.ts'

const HEADLINES: Record<string, TextKey> = {
  'no-funds': 'problem_no_funds',
  'key-cap': 'problem_key_cap',
  'key-off': 'problem_key_off',
}

/** `message` и `dismiss` передаёт harness: текст ошибки и закрытие уведомления. */
export function MoneyNotice({ t, remote, message, dismiss }: { t: Translate; remote: Remote; message: string; dismiss: () => void }) {
  const problem = remote.read().overview?.problem ?? null
  const funds = problem === null || problem.kind === 'no-funds'
  return (
    <div className="rai-banner" role="alert" data-routerai="money-notice">
      <Logo size={28} />
      <div>
        <b>{t(HEADLINES[problem?.kind ?? 'no-funds'] ?? 'problem_no_funds')}</b>
        <span className="rai-note">{problem?.text ?? message}</span>
      </div>
      <Button variant="primary" size="sm" onClick={() => { openTab(funds ? BILLING_PAGE : KEYS_PAGE) }}>{funds ? t('addFunds') : t('openKeys')}</Button>
      <Button variant="ghost" size="sm" onClick={() => { void remote.pull(true); dismiss() }}>{t('close')}</Button>
    </div>
  )
}
