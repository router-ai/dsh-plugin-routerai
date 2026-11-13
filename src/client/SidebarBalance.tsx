// Строка в подвале боковой панели: остаток на счёте RouterAI. По нажатию — краткая сводка.
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { BILLING_PAGE } from '../links.ts'
import { rub } from '../money.ts'
import { Logo } from './parts.tsx'
import { openTab, useRemote } from './remote.ts'
import type { Remote } from './remote.ts'
import type { Translate } from './texts.ts'

/** `wide` сообщает harness: развёрнута ли боковая панель. */
export function SidebarBalance({ t, remote, wide }: { t: Translate; remote: Remote; wide: boolean }) {
  const { overview } = useRemote(remote)
  const [shown, setShown] = useState(false)
  if (overview === null) return null

  const balance = overview.account?.balance
  const running = overview.problem !== null || (balance !== undefined && balance < overview.lowBalance)
  const cap = overview.account?.key?.cap
  const classes = ['rai-side', wide ? '' : 'rai-compact', running ? 'rai-warn' : ''].join(' ').trim()

  return (
    <>
      <button type="button" className={classes} data-routerai="sidebar-balance" title={t('sidebarTitle')}
        onClick={() => { setShown(true); void remote.pull(true) }}>
        <Logo size={16} />
        {wide ? <span>{t('sidebarTitle')}</span> : null}
        {wide ? <b>{overview.connected ? rub(balance) : t('sidebarConnect')}</b> : null}
      </button>
      <Modal open={shown} onClose={() => { setShown(false) }} title={t('sidebarTitle')} closeLabel={t('close')}
        footer={overview.connected
          ? <Button variant="primary" onClick={() => { openTab(BILLING_PAGE) }}>{t('addFunds')}</Button>
          : <Button variant="primary" onClick={() => { void remote.signIn() }}>{t('connectButton')}</Button>}>
        <div style={{ display: 'grid', gap: 12 }}>
          {overview.problem !== null ? <p className="rai-alert">{overview.problem.text}</p> : running ? <p className="rai-caution">{t('sidebarLow')}</p> : null}
          {overview.connected
            ? (
              <div className="rai-figures">
                <div className="rai-figure rai-main">
                  <span className="rai-note">{t('balance')}</span>
                  <strong>{rub(balance)}</strong>
                </div>
                <div className="rai-figure">
                  <span className="rai-note">{t('keyCap')}</span>
                  <strong>{cap === undefined ? t('keyCapNone') : rub(cap.left)}</strong>
                  {cap === undefined ? null : <span className="rai-faint">{t('keyCapLeft', { amount: rub(cap.amount), period: t(`period_${cap.period}`) })}</span>}
                </div>
              </div>
            )
            : <p className="rai-note">{t('connectHint')}</p>}
          <span className="rai-faint">{t('sidebarHint')}</span>
        </div>
      </Modal>
    </>
  )
}
