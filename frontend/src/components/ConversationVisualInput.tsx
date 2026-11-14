// 会話画面の画像操作を「＋」へ収納し、必要なときだけ共有の確認と操作を表示します。
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import type { useVisualInput } from '../hooks/useVisualInput'
import { SharedScreenPreview } from './VisualInputPanel'

interface ConversationVisualInputProps {
  visual: ReturnType<typeof useVisualInput>
  disabled: boolean
}

/** アバターとの会話領域を確保し、共有中もプレビューの常設を避けます。 */
export default function ConversationVisualInput({ visual, disabled }: ConversationVisualInputProps) {
  const [open, setOpen] = useState(false)
  const [panelPosition, setPanelPosition] = useState({ left: 0, maxHeight: 400 })
  const containerRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLInputElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useLayoutEffect(() => {
    if (!open) return
    /** 操作列が折り返しても、メニューを画面内の余白へ収めます。 */
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
    // キーボードでも入口へ戻れるようにし、外側の操作はそのまま通します。
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      toggleRef.current?.focus()
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
    // 画面全体へのドロップでも、添付後は会話へ戻します。
    if (visual.file) setOpen(false)
  }, [visual.file])

  /** 共有選択を直接操作内で起動し、選択ダイアログの後ろにメニューを残しません。 */
  const startSharing = () => {
    setOpen(false)
    void visual.startSharing()
  }

  /** メニューだけを閉じてファイル選択へ進み、キャンセル時も会話へ戻します。 */
  const selectImage = () => {
    setOpen(false)
    pickerRef.current?.click()
  }

  return (
    <div className="conversation-visual-control" ref={containerRef}>
      <button ref={toggleRef} type="button" className="conversation-visual-toggle"
        aria-label={t('visual.openActions')} title={t('visual.openActions')}
        aria-expanded={open} aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}>
        <span aria-hidden="true">＋</span>
      </button>
      {(visual.stream || visual.starting) && (
        <button type="button" className="conversation-sharing-status"
          aria-label={t('visual.sharingDetails')} aria-expanded={open}
          aria-controls={open ? panelId : undefined} onClick={() => setOpen((current) => !current)}>
          <span className="conversation-sharing-dot" aria-hidden="true" />
          {t(visual.starting ? 'visual.selecting' : 'visual.sharing')}
        </button>
      )}
      <input ref={pickerRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
        onChange={(event) => {
          void visual.selectFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }} />
      {open && (
        <div ref={panelRef} id={panelId} className="conversation-visual-popover" style={panelPosition}
          role="dialog" aria-label={t('visual.openActions')}>
          <button type="button" className="visual-button" disabled={disabled || visual.preparing}
            onClick={selectImage}>{t('visual.attach')}</button>
          {visual.stream || visual.starting ? (
            <>
              {visual.stream && <SharedScreenPreview stream={visual.stream} fileAttached={!!visual.file} />}
              <button type="button" className="visual-button sharing" onClick={() => {
                visual.stopSharing()
                setOpen(false)
              }}>{t('visual.stopSharing')}</button>
            </>
          ) : (
            <button type="button" className="visual-button" disabled={disabled}
              onClick={startSharing}>{t('visual.share')}</button>
          )}
        </div>
      )}
    </div>
  )
}
