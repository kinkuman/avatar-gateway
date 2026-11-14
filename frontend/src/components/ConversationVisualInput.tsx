// 会話画面へ添付・共有アイコンを置き、共有の確認と停止だけを必要なときに表示します。
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import type { useVisualInput } from '../hooks/useVisualInput'
import SessionActionIcon from './SessionActionIcon'
import { SharedScreenPreview } from './VisualInputPanel'

interface ConversationVisualInputProps {
  visual: ReturnType<typeof useVisualInput>
  disabled: boolean
}

/** アイコンから直接操作できるようにし、共有プレビューは会話領域を常時覆わないようにします。 */
export default function ConversationVisualInput({ visual, disabled }: ConversationVisualInputProps) {
  const [open, setOpen] = useState(false)
  const [panelPosition, setPanelPosition] = useState({ left: 0, maxHeight: 400 })
  const containerRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLInputElement>(null)
  const shareButtonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const sharing = !!visual.stream || visual.starting
  const shareLabel = visual.starting ? 'visual.selecting' : visual.stream ? 'visual.sharingDetails' : 'visual.share'

  useLayoutEffect(() => {
    if (!open) return
    /** 操作列が折り返しても、プレビューを画面内の余白へ収めます。 */
    const placePanel = () => {
      const container = containerRef.current
      const panel = panelRef.current
      if (!container || !panel) return
      const bounds = container.getBoundingClientRect()
      const left = Math.max(14, Math.min(bounds.left, window.innerWidth - panel.offsetWidth - 14))
      setPanelPosition({ left: left - bounds.left, maxHeight: Math.max(80, bounds.top - 24) })
    }
    placePanel()
    window.addEventListener('resize', placePanel)
    return () => window.removeEventListener('resize', placePanel)
  }, [open, visual.stream, visual.starting])

  useEffect(() => {
    if (!open) return
    // キーボードでも共有アイコンへ戻れるようにし、外側の操作はそのまま通します。
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      shareButtonRef.current?.focus()
    }
    panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    // ブラウザ側の共有停止後も、空のプレビューだけが残らないようにします。
    if (!sharing || visual.file) setOpen(false)
  }, [sharing, visual.file])

  /** 共有開始は直接操作内で呼び出し、共有中は同じアイコンから確認と停止へ進みます。 */
  const handleShare = () => {
    if (sharing) setOpen((current) => !current)
    else void visual.startSharing()
  }

  /** ファイル選択の前にプレビューを閉じ、選択後は会話へ戻します。 */
  const selectImage = () => {
    setOpen(false)
    pickerRef.current?.click()
  }

  return (
    <div className="conversation-visual-control" ref={containerRef}>
      <button type="button" className="visual-button visual-icon-button conversation-visual-button"
        aria-label={t('visual.attach')} title={t('visual.attach')}
        disabled={disabled || visual.preparing} onClick={selectImage}>
        <SessionActionIcon name="attach-image" />
      </button>
      <button ref={shareButtonRef} type="button"
        className={`visual-button visual-icon-button conversation-visual-button${sharing ? ' sharing' : ''}`}
        aria-label={t(shareLabel)} title={t(shareLabel)}
        aria-pressed={!!visual.stream} aria-busy={visual.starting}
        aria-expanded={sharing ? open : undefined} aria-controls={open ? panelId : undefined}
        disabled={!sharing && disabled} onClick={handleShare}>
        <SessionActionIcon name="share-screen" />
      </button>
      <input ref={pickerRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
        onChange={(event) => {
          void visual.selectFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }} />
      {open && sharing && (
        <div ref={panelRef} id={panelId} className="conversation-visual-popover" style={panelPosition}
          role="dialog" aria-label={t('visual.sharingDetails')}>
          {visual.stream ? <SharedScreenPreview stream={visual.stream} fileAttached={!!visual.file} />
            : <p role="status">{t('visual.selecting')}</p>}
          <button type="button" className="visual-button stop-sharing" title={t('visual.stopSharing')}
            onClick={() => {
              visual.stopSharing()
              setOpen(false)
            }}>
            <SessionActionIcon name="stop-sharing" />
            {t('visual.stopSharing')}
          </button>
        </div>
      )}
    </div>
  )
}
