// 標準画面の画像操作と、会話画面で必要な一時プレビューを提供します。
import { useEffect, useRef } from 'react'
import { t, translateMessage } from '../i18n'
import type { useVisualInput } from '../hooks/useVisualInput'

interface VisualInputPanelProps {
  visual: ReturnType<typeof useVisualInput>
  disabled: boolean
  compact?: boolean
}

/** 表示を閉じても共有自体は続けられるよう、プレビューの再生だけを管理します。 */
export function SharedScreenPreview({ stream, fileAttached }: { stream: MediaStream; fileAttached: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    void video.play().catch(() => undefined)
    return () => { video.srcObject = null }
  }, [stream])

  return (
    <div className="visual-preview shared-screen-preview">
      <video ref={videoRef} autoPlay muted playsInline aria-label={t('visual.screenPreview')} />
      <span>{t(fileAttached ? 'visual.screenPausedForFile' : 'visual.screenOnQuestion')}</span>
    </div>
  )
}

/** 会話画面では送信前の画像と通知だけを出し、標準画面では従来の操作をまとめます。 */
export default function VisualInputPanel({ visual, disabled, compact = false }: VisualInputPanelProps) {
  const pickerRef = useRef<HTMLInputElement>(null)
  if (compact && !visual.file && !visual.preparing && !visual.error) return null

  return (
    <div className={`visual-input${compact ? ' visual-input-compact' : ''}`}>
      {!compact && (
        <div className="visual-input-actions">
          <button type="button" className="visual-button" disabled={disabled || visual.preparing}
            onClick={() => pickerRef.current?.click()}>{t('visual.attach')}</button>
          <input ref={pickerRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
            onChange={(event) => {
              void visual.selectFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }} />
          {visual.stream || visual.starting ? (
            <button type="button" className="visual-button sharing" onClick={visual.stopSharing}>
              {t('visual.stopSharing')}
            </button>
          ) : (
            <button type="button" className="visual-button" disabled={disabled}
              onClick={() => void visual.startSharing()}>{t('visual.share')}</button>
          )}
          <span className="visual-input-hint">{t(visual.dragging ? 'visual.dropHere' : 'visual.dropHint')}</span>
        </div>
      )}
      <div className="visual-previews">
        {!compact && visual.stream && <SharedScreenPreview stream={visual.stream} fileAttached={!!visual.file} />}
        {visual.file && (
          <div className="visual-preview attached-image">
            <img src={visual.file.dataUrl} alt={t('visual.imagePreview')} />
            <div><span title={visual.file.label}>{visual.file.label}</span>
              <button type="button" className="visual-button" disabled={disabled}
                aria-label={t('visual.remove')} onClick={visual.removeFile}>
                {compact ? '×' : t('visual.remove')}
              </button></div>
          </div>
        )}
      </div>
      {visual.preparing && <p role="status">{t('visual.preparing')}</p>}
      {visual.error && <p className="visual-error" role="alert">{translateMessage(visual.error)}</p>}
    </div>
  )
}
