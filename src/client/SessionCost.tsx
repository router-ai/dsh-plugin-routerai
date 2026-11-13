// Стоимость текущей сессии под полем ввода. Нажатие раскрывает подробности.
import { useEffect, useRef, useState } from 'react'
import { rub } from '../money.ts'
import { Logo } from './parts.tsx'
import type { Remote, SessionCostView } from './remote.ts'
import type { Translate } from './texts.ts'

const REFRESH_MS = 4_000
const count = (value: number) => value.toLocaleString('ru-RU')

export function SessionCost({ t, remote, sessionId }: { t: Translate; remote: Remote; sessionId?: string }) {
  const [cost, setCost] = useState<SessionCostView | null>(null)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    setCost(null)
    if (sessionId === undefined) return
    let active = true
    const refresh = () => {
      // В фоновой вкладке сервер не дёргаем.
      if (document.hidden) return
      remote.sessionCost(sessionId).then((next) => { if (active) setCost(next) }, () => {})
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => { active = false; clearInterval(timer) }
  }, [remote, sessionId])

  // Подробности закрываются нажатием мимо них и клавишей Escape.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  if (cost === null || cost.calls === 0) return null
  const models = Object.entries(cost.perModel).sort(([, a], [, b]) => b.rub - a.rub)

  return (
    <span className="rai-cost" ref={anchor} data-routerai="session-cost">
      <button type="button" aria-expanded={open} title={t('costTitle')} onClick={() => { setOpen(value => !value) }}>
        <Logo size={13} />
        {rub(cost.total)}
      </button>
      {open ? (
        <div className="rai-sheet" role="dialog" aria-label={t('costTitle')}>
          <dl>
            <dt>{t('costTotal')}</dt><dd>{rub(cost.total)}</dd>
            <dt>{t('costLast')}</dt><dd>{rub(cost.last?.rub)}</dd>
            <dt>{t('costCalls')}</dt><dd>{cost.calls}</dd>
            <dt>{t('costCached')}</dt><dd>{cost.cachedShare === null ? '—' : `${Math.round(cost.cachedShare * 100)}%`}</dd>
            <dt>{t('costInput')}</dt><dd>{count(cost.tokens.input + cost.tokens.cached)}</dd>
            <dt>{t('costCacheWrites')}</dt><dd>{count(cost.tokens.cacheWrites)}</dd>
            <dt>{t('costOutput')}</dt><dd>{count(cost.tokens.output)}</dd>
          </dl>
          {models.length > 1 ? (
            <ul>
              {models.map(([slug, share]) => <li key={slug}><span className="rai-clip">{slug}</span>{share.calls}× <b>{rub(share.rub)}</b></li>)}
            </ul>
          ) : null}
          {cost.unpriced > 0 ? <span className="rai-caution">{t('costUnpriced', { count: cost.unpriced })}</span> : null}
          <span className="rai-faint">{t('costNote')}</span>
        </div>
      ) : null}
    </span>
  )
}
