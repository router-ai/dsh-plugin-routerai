// Шаги входа в RouterAI: кнопка, ожидание возврата из браузера и вход по коду. Общие для настроек и окна баланса.
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { openTab } from './remote.ts'
import type { Overview, Remote } from './remote.ts'
import type { Translate } from './texts.ts'

/** Выполнить действие и показать его ошибку рядом с кнопкой, а не потерять в консоли. */
export function useAction(): { busy: boolean; error: string | null; run: (action: () => Promise<unknown>) => void } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    action().catch((problem: unknown) => { setError(problem instanceof Error ? problem.message : String(problem)) }).finally(() => { setBusy(false) })
  }
  return { busy, error, run }
}

export function SignIn({ t, remote, overview }: { t: Translate; remote: Remote; overview: Overview }) {
  const [code, setCode] = useState('')
  const action = useAction()
  const stage = overview.signIn
  const problem = action.error ?? (stage.stage === 'failed' ? stage.reason : null)

  if (stage.stage !== 'waiting') {
    return (
      <div className="rai-steps" data-routerai="sign-in">
        <p className="rai-note">{t('connectHint')}</p>
        <div className="rai-line">
          <Button variant="primary" disabled={action.busy} onClick={() => { action.run(() => remote.signIn()) }}>{t('connectButton')}</Button>
          <Button variant="ghost" disabled={action.busy} onClick={() => { action.run(() => remote.signIn(true)) }}>{t('connectByCode')}</Button>
        </div>
        {problem === null ? null : <p className="rai-alert">{problem}</p>}
      </div>
    )
  }

  const pageUrl = stage.url
  if (!stage.byCode && pageUrl !== null) {
    return (
      <div className="rai-steps" data-routerai="sign-in">
        <p className="rai-note">{t('connectWaiting')}</p>
        <div className="rai-line">
          <Button variant="outline" onClick={() => { openTab(pageUrl) }}>{t('connectReopen')}</Button>
          <Button variant="ghost" onClick={() => { action.run(remote.cancelSignIn) }}>{t('connectAbort')}</Button>
        </div>
        <div className="rai-line">
          <Button variant="ghost" onClick={() => { action.run(() => remote.useCode(stage.codeUrl)) }}>{t('connectStuck')}</Button>
        </div>
        {problem === null ? null : <p className="rai-alert">{problem}</p>}
      </div>
    )
  }

  const submit = () => { action.run(() => remote.submitCode(code).then(() => { setCode('') })) }
  return (
    <div className="rai-steps" data-routerai="sign-in-code">
      {stage.notice === null ? null : <p className="rai-caution">{stage.notice}</p>}
      <p className="rai-note">{t('codeHint')}</p>
      <div className="rai-line">
        <Input className="rai-fill" autoComplete="off" placeholder={t('codeHolder')} aria-label={t('codeHolder')} value={code}
          onChange={(event) => { setCode(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && code.trim() !== '' && !action.busy) submit() }} />
        <Button variant="primary" disabled={action.busy || code.trim() === ''} onClick={submit}>{t('codeButton')}</Button>
      </div>
      <div className="rai-line">
        <Button variant="outline" onClick={() => { openTab(stage.codeUrl) }}>{t('codeReopen')}</Button>
        <Button variant="ghost" onClick={() => { action.run(remote.cancelSignIn) }}>{t('connectAbort')}</Button>
      </div>
      {problem === null ? null : <p className="rai-alert">{problem}</p>}
    </div>
  )
}
