// Карточка вызова инструментов рисования и видео в чате: пока идёт работа — что делается,
// после — картинки (у рисования), стоимость и кнопки, открывающие сохранённые файлы.
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { VIDEO_TOOL } from '../links.ts'
import { rub } from '../money.ts'
import type { Translate } from './texts.ts'

/** Что harness передаёт карточке: стадия вызова, его данные и помощники чата. */
interface Props {
  t: Translate
  phase: 'preparing' | 'start' | 'result'
  /** Имя инструмента: по нему карточка различает картинку и видео. */
  toolName: string
  block: {
    argsRaw?: string
    call?: { argsRaw: string } | null
    content?: readonly { type: string; text?: string; attachment?: ImageAttachmentRef }[]
    isError?: boolean
    error?: { reason?: string }
    meta?: unknown
  }
  /** Адрес картинки-вложения, доступный этой вкладке. */
  loadImage(attachment: ImageAttachmentRef): Promise<string>
  openFile(path: string): void
}

/** Описание картинки из аргументов вызова; пока модель их дописывает, JSON может быть неполным. */
function promptOf(block: Props['block']): string {
  for (const raw of [block.argsRaw, block.call?.argsRaw]) {
    if (raw === undefined) continue
    try {
      const prompt = (JSON.parse(raw) as { prompt?: unknown }).prompt
      if (typeof prompt === 'string') return prompt
    } catch {
      const partial = /"prompt"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)?.[1]
      if (partial !== undefined) return partial.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1')
    }
  }
  return ''
}

function Picture({ attachment, loadImage }: { attachment: ImageAttachmentRef; loadImage: Props['loadImage'] }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    loadImage(attachment).then((loaded) => { if (current) setUrl(loaded) }, () => {})
    return () => { current = false }
  }, [attachment, loadImage])
  return url === null ? <i /> : <img src={url} alt={attachment.name ?? ''} width={attachment.width} height={attachment.height} style={{ height: 'auto' }} />
}

export function DrawCard({ t, phase, toolName, block, loadImage, openFile }: Props) {
  const prompt = promptOf(block)
  const video = toolName === VIDEO_TOOL

  if (phase !== 'result') {
    return (
      <div className="rai-drawn" data-routerai="draw-card">
        <div className="rai-line"><span className="rai-busy" /><b>{t(video ? 'filming' : 'drawing')}</b></div>
        {prompt === '' ? null : <span className="rai-note">{prompt}</span>}
      </div>
    )
  }

  if (block.isError === true) {
    const reason = block.content?.find(item => item.type === 'text')?.text ?? block.error?.reason ?? ''
    return (
      <div className="rai-drawn" data-routerai="draw-card">
        <b>{t(video ? 'filmFailed' : 'drawFailed')}</b>
        <span className="rai-alert">{reason}</span>
      </div>
    )
  }

  const meta = (block.meta ?? {}) as { model?: string; cost?: number | null; files?: string[] }
  const shown = (block.content ?? []).flatMap(item => (item.type === 'image' && item.attachment !== undefined ? [item.attachment] : []))
  const facts = [meta.model, typeof meta.cost === 'number' ? t('drawnCost', { cost: rub(meta.cost) }) : undefined].filter(Boolean).join(' · ')
  return (
    <div className="rai-drawn" data-routerai="draw-card">
      {shown.length === 0 ? null : <div className="rai-gallery">{shown.map(attachment => <Picture key={attachment.attachmentId} attachment={attachment} loadImage={loadImage} />)}</div>}
      <div className="rai-line">
        <b>{t(video ? 'filmed' : 'drawn')}</b>
        {facts === '' ? null : <span className="rai-faint">{facts}</span>}
      </div>
      {prompt === '' ? null : <span className="rai-note">{prompt}</span>}
      {(meta.files ?? []).length === 0 ? null : (
        <div className="rai-line">
          {(meta.files ?? []).map(path => <Button key={path} variant="outline" size="sm" onClick={() => { openFile(path) }}>{t('openFile', { name: path.split(/[\\/]/).pop() ?? path })}</Button>)}
        </div>
      )}
    </div>
  )
}
