// 境界に共有画像を置き、チャットへ張り出す幅に合わせて会話全体の読みやすさを保ちます。
import { useLayoutEffect, useRef } from 'react'
import { t, useTranslation } from '../i18n'
import type { useVisualInput } from '../hooks/useVisualInput'
import { SharedScreenPreview } from './VisualInputPanel'

interface SharedVisualOverlayProps {
  visual: ReturnType<typeof useVisualInput>
  disabled: boolean
}

/** 映像全体に沿う小さな余白の枠を作り、終了操作を同じ場所に保ちます。 */
export default function SharedVisualOverlay({ visual, disabled }: SharedVisualOverlayProps) {
  useTranslation()
  const overlayRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const overlay = overlayRef.current
    const shell = overlay?.parentElement
    const chat = shell?.querySelector<HTMLElement>('.chat-panel')
    if (!overlay || !shell || !chat) return
    const parts = [...overlay.querySelectorAll<HTMLElement>('.shared-visual-orbit, .shared-visual-caption')]

    /** 実際の画像幅と操作部の両方を避け、縦長画像でも不要な余白を増やしません。 */
    const measure = () => {
      const right = Math.max(...parts.map((part) => part.getBoundingClientRect().right))
      const chatRect = chat.getBoundingClientRect()
      const inset = overlay.getClientRects().length ? Math.max(0, right + 16 - chatRect.left) : 0
      shell.style.setProperty('--shared-chat-inset', inset + 'px')
      // 会話領域自体を表示幅へ収め、両者の発言が同じ余白を使うようにします。
      shell.style.setProperty('--shared-chat-width', chatRect.width + 'px')
    }
    const observer = new ResizeObserver(measure)
    // 映像の読み込み・ラベルの変化・境界リサイズを同じ計測経路へ集めます。
    for (const element of [shell, chat, ...parts]) observer.observe(element)
    measure()
    return () => {
      observer.disconnect()
      shell.style.removeProperty('--shared-chat-inset')
      shell.style.removeProperty('--shared-chat-width')
    }
  }, [visual.file, visual.stream])

  if (!visual.file && !visual.stream) return null

  return (
    <aside ref={overlayRef} className="shared-visual-overlay" aria-label={t('visual.sharedWithAvatar')}>
      <div className="shared-visual-orbit">
        {visual.file
          ? <img src={visual.file.dataUrl} alt={t('visual.imagePreview')} />
          : visual.stream && <SharedScreenPreview stream={visual.stream} />}
      </div>
      <div className="shared-visual-caption">
        <span>{t('visual.together')}</span>
        {visual.file && <small title={visual.file.label}>{visual.file.label}</small>}
        <button type="button" disabled={!!visual.file && disabled}
          onClick={visual.file ? visual.removeFile : visual.stopSharing}>
          {t(visual.file ? 'visual.remove' : 'visual.stopSharing')}
        </button>
      </div>
    </aside>
  )
}
