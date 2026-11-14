// Раздел «RouterAI» в настройках harness: подключение, аккаунт, выбор моделей, дополнительные настройки.
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { BILLING_PAGE } from '../links.ts'
import { pricePair, rub, windowLabel } from '../money.ts'
import { MODEL_SETS } from '../starter.ts'
import { Icon, Logo } from './parts.tsx'
import { openTab, useRemote } from './remote.ts'
import type { CatalogEntry, Overview, Remote } from './remote.ts'
import type { Translate } from './texts.ts'

interface Shared {
  t: Translate
  remote: Remote
}

/** Выполнить действие и показать его ошибку рядом с кнопкой, а не потерять в консоли. */
function useAction(): { busy: boolean; error: string | null; run: (action: () => Promise<unknown>) => void } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    action().catch((problem: unknown) => { setError(problem instanceof Error ? problem.message : String(problem)) }).finally(() => { setBusy(false) })
  }
  return { busy, error, run }
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rai-panel">
      <h3>{title}</h3>
      {hint === undefined ? null : <p className="rai-note">{hint}</p>}
      {children}
    </section>
  )
}

function Connect({ t, remote, overview }: Shared & { overview: Overview }) {
  const [draft, setDraft] = useState('')
  const action = useAction()
  const stage = overview.signIn
  return (
    <Panel title={t('connectTitle')} hint={stage.stage === 'waiting' ? t('connectWaiting') : t('connectHint')}>
      {stage.stage === 'waiting'
        ? (
          <div className="rai-line">
            <Button variant="outline" onClick={() => { openTab(stage.url) }}>{t('connectReopen')}</Button>
            <Button variant="ghost" onClick={() => { action.run(remote.cancelSignIn) }}>{t('connectAbort')}</Button>
          </div>
        )
        : (
          <div className="rai-line">
            <Button variant="primary" disabled={action.busy} onClick={() => { action.run(remote.signIn) }}>{t('connectButton')}</Button>
          </div>
        )}
      <div className="rai-line">
        <span className="rai-note">{t('pasteLabel')}</span>
        <Input className="rai-fill" type="password" autoComplete="off" placeholder={t('pasteHolder')} value={draft} onChange={(event) => { setDraft(event.target.value) }} />
        <Button variant="outline" disabled={action.busy || draft.trim() === ''} onClick={() => { action.run(() => remote.saveKey(draft.trim()).then(() => { setDraft('') })) }}>{t('pasteButton')}</Button>
      </div>
      {action.error !== null ? <p className="rai-alert">{action.error}</p> : stage.stage === 'failed' ? <p className="rai-alert">{stage.reason}</p> : null}
    </Panel>
  )
}

function Account({ t, remote, overview }: Shared & { overview: Overview }) {
  const action = useAction()
  const account = overview.account
  const key = account?.key
  const cap = key?.cap
  return (
    <section className="rai-panel" data-routerai="account">
      <div className="rai-line">
        <div className="rai-fill">
          <h3 className="rai-clip" style={{ margin: 0, font: 'var(--dsw-font-s-strong-14)' }}>{key?.label || t('accountNoLabel')}</h3>
          <span className="rai-faint">{overview.keyMask}</span>
        </div>
        <Button variant="outline" onClick={() => { openTab(BILLING_PAGE) }}>{t('addFunds')}</Button>
        <Button variant="ghost" disabled={action.busy} onClick={() => { action.run(() => remote.pull(true)) }}>{t('reload')}</Button>
        <Button variant="ghost" disabled={action.busy} onClick={() => { action.run(remote.signOut) }}>{t('disconnect')}</Button>
      </div>
      {account?.state === 'rejected' ? <p className="rai-alert">{t('keyRejected')}</p> : null}
      {account?.state === 'offline' ? <p className="rai-caution">{t('offline')}</p> : null}
      {key?.disabled ? <p className="rai-alert">{t('keyDisabled')}</p> : null}
      <div className="rai-figures">
        <div className="rai-figure rai-main">
          <span className="rai-note">{t('balance')}</span>
          <strong>{rub(account?.balance)}</strong>
        </div>
        <div className="rai-figure">
          <span className="rai-note">{t('keyCap')}</span>
          <strong>{cap === undefined ? t('keyCapNone') : rub(cap.left)}</strong>
          {cap === undefined ? null : (
            <>
              <span className="rai-faint">{t('keyCapLeft', { amount: rub(cap.amount), period: t(`period_${cap.period}`) })}</span>
              <div className="rai-gauge"><span style={{ width: `${Math.round(100 * Math.min(1, Math.max(0, 1 - cap.left / cap.amount)))}%` }} /></div>
            </>
          )}
        </div>
        <div className="rai-figure">
          <span className="rai-note">{t('keySpent')}</span>
          <strong>{rub(key?.spent ?? 0)}</strong>
          <span className="rai-faint">{t('keySpentMonth', { amount: rub(key?.spentThisMonth ?? 0) })}</span>
        </div>
      </div>
      {action.error !== null ? <p className="rai-alert">{action.error}</p> : null}
    </section>
  )
}

function modelFacts(entry: CatalogEntry): string {
  return [entry.slug, pricePair(entry.price), windowLabel(entry.window)].filter(part => part !== '').join(' · ')
}

function Picker({ t, remote, overview, catalog }: Shared & { overview: Overview; catalog: CatalogEntry[] | null }) {
  const saved = overview.picker.models
  const savedKey = saved.join('|')
  const [draft, setDraft] = useState<string[]>(saved)
  const [search, setSearch] = useState('')
  const [maker, setMaker] = useState('')
  const [toolsOnly, setToolsOnly] = useState(true)
  const [justApplied, setJustApplied] = useState(false)
  const action = useAction()

  // Список на сервере сменился (сохранили здесь или в другой вкладке) — черновик начинается с него.
  useEffect(() => { setDraft(saved) }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // В пикер идут только чат-модели; модели для картинок и речи выбираются в «Дополнительно».
  const chat = useMemo(() => (catalog ?? []).filter(entry => entry.makes.includes('text')), [catalog])
  const bySlug = useMemo(() => new Map(chat.map(entry => [entry.slug, entry])), [chat])
  const makers = useMemo(() => [...new Set(chat.map(entry => entry.maker))].sort((a, b) => a.localeCompare(b)), [chat])
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return chat.filter(entry =>
      (maker === '' || entry.maker === maker)
      && (!toolsOnly || entry.tools)
      && (needle === '' || `${entry.slug} ${entry.maker} ${entry.title}`.toLowerCase().includes(needle)))
  }, [chat, search, maker, toolsOnly])

  const changed = draft.join('|') !== savedKey
  const edit = (next: string[]) => { setJustApplied(false); setDraft(next) }
  const shift = (from: number, to: number) => {
    const next = [...draft]
    next.splice(to, 0, ...next.splice(from, 1))
    edit(next)
  }
  const toggle = (slug: string) => { edit(draft.includes(slug) ? draft.filter(item => item !== slug) : [...draft, slug]) }
  const visible = matches.slice(0, 250)

  return (
    <Panel title={t('pickerTitle')} hint={t('pickerHint')}>
      {draft.length === 0
        ? <p className="rai-note">{t('pickerEmpty')}</p>
        : (
          <div className="rai-rows" data-routerai="picked">
            {draft.map((slug, position) => {
              const entry = bySlug.get(slug)
              return (
                <div className="rai-row" key={slug}>
                  <span className="rai-order">{position + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="rai-clip">{entry === undefined ? slug : `${entry.maker} ${entry.title}`}</div>
                    <div className="rai-faint rai-clip">{entry === undefined ? (catalog === null ? slug : `${slug} · ${t('pickerUnknown')}`) : modelFacts(entry)}</div>
                  </div>
                  <div className="rai-tools">
                    <button type="button" title={t('moveUp')} aria-label={t('moveUp')} disabled={position === 0} onClick={() => { shift(position, position - 1) }}><Icon glyph="up" /></button>
                    <button type="button" title={t('moveDown')} aria-label={t('moveDown')} disabled={position === draft.length - 1} onClick={() => { shift(position, position + 1) }}><Icon glyph="down" /></button>
                    <button type="button" title={t('drop')} aria-label={t('drop')} onClick={() => { toggle(slug) }}><Icon glyph="cross" /></button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      <div className="rai-line">
        <Button variant="primary" disabled={!changed || action.busy} onClick={() => { action.run(() => remote.savePreferences({ models: draft }).then(() => { setJustApplied(true) })) }}>{t('apply')}</Button>
        {changed ? <Button variant="ghost" onClick={() => { edit(saved) }}>{t('revert')}</Button> : null}
        {justApplied && !changed ? <span className="rai-note" role="status">{t('applied')}</span> : null}
        {action.error !== null ? <span className="rai-alert">{action.error}</span> : null}
      </div>
      <div className="rai-line">
        <span className="rai-note">{t('sets')}:</span>
        {MODEL_SETS.map(set => (
          <Button key={set.key} variant="outline" size="sm" disabled={catalog === null}
            onClick={() => { edit(set.models.filter(slug => bySlug.has(slug))) }}>
            {t(`set_${set.key}`)}
          </Button>
        ))}
      </div>

      <h3 style={{ margin: '6px 0 0', font: 'var(--dsw-font-s-strong-14)' }}>{t('catalogTitle')}</h3>
      <div className="rai-line">
        <Input className="rai-fill" placeholder={t('catalogSearch')} value={search} onChange={(event) => { setSearch(event.target.value) }} />
        <select className="rai-choice" value={maker} aria-label={t('catalogAnyMaker')} onChange={(event) => { setMaker(event.target.value) }}>
          <option value="">{t('catalogAnyMaker')}</option>
          {makers.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>
      <div className="rai-line">
        <label className="rai-line rai-note" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={toolsOnly} onChange={(event) => { setToolsOnly(event.target.checked) }} />
          {t('catalogToolsOnly')}
        </label>
        <span className="rai-faint" style={{ marginLeft: 'auto' }}>
          {catalog === null ? t('catalogLoading') : t('catalogShown', { shown: visible.length, total: matches.length })}
        </span>
      </div>
      <div className="rai-rows rai-tall" data-routerai="catalog">
        {visible.map(entry => (
          <label className="rai-row" key={entry.slug}>
            <input type="checkbox" checked={draft.includes(entry.slug)} onChange={() => { toggle(entry.slug) }} />
            <div style={{ minWidth: 0 }}>
              <div className="rai-clip">{entry.maker} {entry.title}</div>
              <div className="rai-faint rai-clip">{modelFacts(entry)}</div>
            </div>
            <div className="rai-line">
              {entry.alias ? <Tag tone="quiet">{t('tagAlias')}</Tag> : null}
              {entry.reasoning ? <Tag tone="quiet">{t('tagReasoning')}</Tag> : null}
              {entry.vision ? <Tag tone="quiet">{t('tagVision')}</Tag> : null}
              {entry.tools ? null : <Tag tone="warning">{t('tagNoTools')}</Tag>}
            </div>
          </label>
        ))}
      </div>
    </Panel>
  )
}

function Extras({ t, remote, overview, catalog }: Shared & { overview: Overview; catalog: CatalogEntry[] | null }) {
  const [threshold, setThreshold] = useState(String(overview.lowBalance))
  const action = useAction()
  const cheapestFirst = useMemo(() => (catalog ?? [])
    .filter(entry => entry.makes.includes('text') && entry.tools && entry.price !== undefined && !entry.alias)
    .sort((a, b) => (a.price?.input ?? 0) - (b.price?.input ?? 0)), [catalog])
  const current = overview.utilityModel
  const painters = useMemo(() => (catalog ?? []).filter(entry => entry.makes.includes('image'))
    .sort((a, b) => (a.perImage ?? Infinity) - (b.perImage ?? Infinity) || a.title.localeCompare(b.title)), [catalog])
  const listeners = useMemo(() => (catalog ?? []).filter(entry => entry.makes.includes('transcription'))
    .sort((a, b) => (a.perSecond ?? Infinity) - (b.perSecond ?? Infinity) || a.title.localeCompare(b.title)), [catalog])
  const known = (list: CatalogEntry[], slug: string | null) => slug === null || list.some(entry => entry.slug === slug)
  const commitThreshold = () => {
    const value = Number(threshold.replace(',', '.'))
    if (Number.isFinite(value) && value >= 0) action.run(() => remote.savePreferences({ lowBalance: value }))
    else setThreshold(String(overview.lowBalance))
  }
  return (
    <Panel title={t('extrasTitle')}>
      <label style={{ display: 'grid', gap: 6 }}>
        <span>{t('utilityLabel')}</span>
        <select className="rai-choice" value={current ?? ''} onChange={(event) => { action.run(() => remote.savePreferences({ utilityModel: event.target.value === '' ? null : event.target.value })) }}>
          <option value="">{t('utilityOff')}</option>
          {current !== null && !cheapestFirst.some(entry => entry.slug === current) ? <option value={current}>{current}</option> : null}
          {cheapestFirst.map(entry => <option key={entry.slug} value={entry.slug}>{entry.maker} {entry.title} · {pricePair(entry.price)}</option>)}
        </select>
        <span className="rai-note">{t('utilityHint')}</span>
      </label>
      <label style={{ display: 'grid', gap: 6 }}>
        <span>{t('imageLabel')}</span>
        <select className="rai-choice" data-routerai="image-model" value={overview.imageModel ?? ''} onChange={(event) => { action.run(() => remote.savePreferences({ imageModel: event.target.value === '' ? null : event.target.value })) }}>
          <option value="">{t('imageOff')}</option>
          {known(painters, overview.imageModel) ? null : <option value={overview.imageModel ?? ''}>{overview.imageModel}</option>}
          {painters.map(entry => <option key={entry.slug} value={entry.slug}>{entry.maker} {entry.title}{entry.perImage === undefined ? '' : ` · ${t('perImage', { price: rub(entry.perImage) })}`}</option>)}
        </select>
        <span className="rai-note">{t('imageHint')}</span>
      </label>
      <label style={{ display: 'grid', gap: 6 }}>
        <span>{t('speechLabel')}</span>
        <select className="rai-choice" data-routerai="speech-model" value={overview.speechModel} onChange={(event) => { action.run(() => remote.savePreferences({ speechModel: event.target.value })) }}>
          {known(listeners, overview.speechModel) ? null : <option value={overview.speechModel}>{overview.speechModel}</option>}
          {listeners.map(entry => <option key={entry.slug} value={entry.slug}>{entry.maker} {entry.title}{entry.perSecond === undefined ? '' : ` · ${t('perMinute', { price: rub(entry.perSecond * 60) })}`}</option>)}
        </select>
        <span className="rai-note">{t('speechHint')}</span>
      </label>
      <label className="rai-line">
        <span className="rai-fill">{t('lowBalanceLabel')}</span>
        <Input style={{ width: 96 }} inputMode="decimal" value={threshold} onChange={(event) => { setThreshold(event.target.value) }} onBlur={commitThreshold} />
        <span>₽</span>
      </label>
      {action.error !== null ? <p className="rai-alert">{action.error}</p> : null}
    </Panel>
  )
}

export function SettingsPage({ t, remote }: Shared) {
  const { overview, failure } = useRemote(remote)
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [catalogFailure, setCatalogFailure] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    remote.catalog().then(
      (entries) => { if (current) setCatalog(entries) },
      (problem: unknown) => { if (current) setCatalogFailure(problem instanceof Error ? problem.message : String(problem)) },
    )
    return () => { current = false }
  }, [remote])

  return (
    <div className="rai-page">
      <header className="rai-head">
        <Logo size={40} />
        <h2>{t('heading')}</h2>
        <p>{t('lead')}</p>
      </header>
      {failure !== null ? <p className="rai-alert">{failure}</p> : null}
      {overview === null ? null : (
        <>
          {overview.connected ? <Account t={t} remote={remote} overview={overview} /> : <Connect t={t} remote={remote} overview={overview} />}
          <Picker t={t} remote={remote} overview={overview} catalog={catalog} />
          {catalogFailure !== null ? <p className="rai-alert">{catalogFailure}</p> : null}
          <Extras t={t} remote={remote} overview={overview} catalog={catalog} />
        </>
      )}
    </div>
  )
}
