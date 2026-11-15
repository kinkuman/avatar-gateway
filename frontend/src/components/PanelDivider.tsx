// 標準画面の境界操作と端末ごとの幅保存をまとめ、会話処理の再描画を抑えます。
import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { t, useTranslation } from '../i18n'

const STORAGE_KEY = 'avatar-gateway.panel-ratio'
const DEFAULT_RATIO = 0.55
// CSSの境界領域と揃え、カーソル位置と実際の境界を一致させます。
const HANDLE_WIDTH = 4
const AVATAR_MIN = 360
const CHAT_MIN = 340

/** 保存が制限されたブラウザや壊れた保存値でも、画面を開けるようにします。 */
function readRatio(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_RATIO
  } catch {
    return DEFAULT_RATIO
  }
}

/** マウス・タッチ・キーボードに共通の幅制限を適用します。 */
export default function PanelDivider() {
  useTranslation()
  const dividerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(readRatio)
  const ratioRef = useRef(ratio)
  const dragRef = useRef<{ pointerId: number; offset: number } | null>(null)
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState(false)
  const available = Math.max(width - HANDLE_WIDTH, AVATAR_MIN + CHAT_MIN)
  const minRatio = AVATAR_MIN / available
  const maxRatio = 1 - CHAT_MIN / available
  const visibleRatio = Math.min(maxRatio, Math.max(minRatio, ratio))

  useLayoutEffect(() => {
    const shell = dividerRef.current?.parentElement
    if (!shell) return
    // CSS側でも制限し、ウィンドウ縮小時に片側が押し出されるのを防ぎます。
    shell.style.setProperty('--avatar-ratio', String(ratio))
  }, [ratio])

  useLayoutEffect(() => {
    const shell = dividerRef.current?.parentElement
    if (!shell) return
    const observer = new ResizeObserver(() => setWidth(shell.clientWidth))
    observer.observe(shell)
    setWidth(shell.clientWidth)
    return () => observer.disconnect()
  }, [])

  /** 保存できない環境でも、その場の幅変更は有効にします。 */
  function persist(next: number) {
    try { localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* 保存制限時は画面内だけで保持します。 */ }
  }

  /** ドラッグ中は保存せず、表示だけ更新してストレージへの書き込みを抑えます。 */
  function update(next: number) {
    ratioRef.current = Math.min(maxRatio, Math.max(minRatio, next))
    setRatio(ratioRef.current)
  }

  /** 掴んだ位置を保ち、ハンドルの端から操作しても境界を跳ねさせません。 */
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    // ポインター操作ではフォーカスを外し、離したあとに枠線を残さないようにします。
    event.currentTarget.blur()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      offset: event.clientX - event.currentTarget.getBoundingClientRect().left,
    }
    setDragging(true)
  }

  /** 境界の外まで移動しても、ポインター捕捉で操作を継続します。 */
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    const shell = event.currentTarget.parentElement
    if (!drag || drag.pointerId !== event.pointerId || !shell) return
    update((event.clientX - shell.getBoundingClientRect().left - drag.offset) / available)
  }

  /** 中断や捕捉解除でも操作状態を残さず、最後の幅を保存します。 */
  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    persist(ratioRef.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  /** 初期比率そのものを保存し、次に広い画面へ戻したときも復元します。 */
  function reset() {
    ratioRef.current = DEFAULT_RATIO
    setRatio(DEFAULT_RATIO)
    persist(DEFAULT_RATIO)
  }

  /** キーボードだけでも境界を調整し、Homeキーで初期幅へ戻せます。 */
  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Home') {
      event.preventDefault()
      reset()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      update(visibleRatio + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 50 : 10) / available)
      persist(ratioRef.current)
    }
  }

  return (
    <div ref={dividerRef} className={`panel-divider${dragging ? ' resizing' : ''}`}
      role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label={t('app.layout.resize')} title={t('app.layout.resizeHint')}
      aria-valuemin={Math.round(minRatio * 100)} aria-valuemax={Math.round(maxRatio * 100)}
      aria-valuenow={Math.round(visibleRatio * 100)}
      onPointerDown={startDrag} onPointerMove={moveDrag}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
      onDoubleClick={reset} onKeyDown={handleKey} />
  )
}
