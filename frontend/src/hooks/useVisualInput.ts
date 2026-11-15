// 共有画面と添付画像をブラウザ内で一時的に扱い、質問時の画像だけを取り出します。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { t } from '../i18n'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_EDGE = 2048
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export interface VisualImage {
  dataUrl: string
  label: string
}

/** 文字を読める解像度を保ちつつ、送信サイズをブラウザのCanvasで制限します。 */
function encodeImage(source: CanvasImageSource, width: number, height: number, mime: string): string {
  if (!width || !height || width * height > 40_000_000) throw new Error(t('visual.invalidImage'))
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error(t('visual.invalidImage'))
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL(mime, 0.88)
  const encoded = dataUrl.split(',')[1] ?? ''
  if (!encoded || encoded.length * 3 / 4 > MAX_IMAGE_BYTES) throw new Error(t('visual.imageTooLarge'))
  return dataUrl
}

/** 共有の許可・終了と画像の読込競合を管理し、永続ストレージには書き込みません。 */
export function useVisualInput(blocked: boolean) {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [starting, setStarting] = useState(false)
  const [file, setFile] = useState<VisualImage | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fileRef = useRef<VisualImage | null>(null)
  const pendingShareRef = useRef<{ stream: MediaStream; video: HTMLVideoElement } | null>(null)
  const sharingVersion = useRef(0)
  const fileVersion = useRef(0)
  const dragDepth = useRef(0)

  /** 選択待ちの共有も無効化し、終了済みトラックを次の質問に使わせません。 */
  const stopSharing = useCallback(() => {
    sharingVersion.current += 1
    pendingShareRef.current?.stream.getTracks().forEach((track) => track.stop())
    if (pendingShareRef.current) pendingShareRef.current.video.srcObject = null
    pendingShareRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    videoRef.current = null
    setStream(null)
    setStarting(false)
  }, [])

  /** キャンセル後に遅れて画像の読込が終わっても、添付を復活させません。 */
  const removeFile = useCallback(() => {
    fileVersion.current += 1
    fileRef.current = null
    setFile(null)
    setPreparing(false)
  }, [])

  /** 会話切替時には共有元と下書き画像をまとめて解放します。 */
  const reset = useCallback(() => {
    stopSharing()
    removeFile()
    setError('')
    setDragging(false)
    dragDepth.current = 0
  }, [stopSharing, removeFile])

  useEffect(() => () => {
    sharingVersion.current += 1
    fileVersion.current += 1
    pendingShareRef.current?.stream.getTracks().forEach((track) => track.stop())
    if (pendingShareRef.current) pendingShareRef.current.video.srcObject = null
    pendingShareRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    if (videoRef.current) videoRef.current.srcObject = null
    streamRef.current = null
    videoRef.current = null
    fileRef.current = null
  }, [])

  /** ブラウザの共有選択は、ボタンの直接操作から待ち時間を挟まずに開始します。 */
  const startSharing = async () => {
    if (blocked || starting || streamRef.current) return
    setError('')
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError(t('visual.shareUnavailable'))
      return
    }
    const version = ++sharingVersion.current
    setStarting(true)
    let next: MediaStream | null = null
    let nextVideo: HTMLVideoElement | null = null
    try {
      next = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      if (version !== sharingVersion.current) {
        next.getTracks().forEach((track) => track.stop())
        return
      }
      nextVideo = document.createElement('video')
      nextVideo.muted = true
      nextVideo.playsInline = true
      nextVideo.srcObject = next
      // 準備中の映像も停止対象にし、読込中の切替や画面終了で共有を残しません。
      pendingShareRef.current = { stream: next, video: nextVideo }
      // 再生まで成功してから切り替え、許可取消や映像取得の失敗で元の画像を失わないようにします。
      await nextVideo.play()
      if (version !== sharingVersion.current) {
        next.getTracks().forEach((track) => track.stop())
        nextVideo.srcObject = null
        return
      }
      const track = next.getVideoTracks()[0]
      if (!track || track.readyState !== 'live') throw new Error(t('visual.shareFailed'))
      pendingShareRef.current = null
      videoRef.current = nextVideo
      streamRef.current = next
      track.addEventListener('ended', () => {
        if (streamRef.current === next) stopSharing()
      }, { once: true })
      removeFile()
      setStream(next)
    } catch (cause) {
      next?.getTracks().forEach((track) => track.stop())
      if (nextVideo) nextVideo.srcObject = null
      if (pendingShareRef.current?.stream === next) pendingShareRef.current = null
      if (version !== sharingVersion.current) return
      stopSharing()
      if (!(cause instanceof DOMException && cause.name === 'NotAllowedError')) {
        setError(t('visual.shareFailed'))
      }
    } finally {
      if (version === sharingVersion.current) setStarting(false)
    }
  }

  /** 添付候補を一枚だけ画像として読み、送信される縮小後の内容をプレビューします。 */
  const selectFiles = async (files: File[]) => {
    if (blocked) return
    setError('')
    if (files.length === 0) return
    if (files.length !== 1) { setError(t('visual.oneImage')); return }
    const selected = files[0]
    if (!ACCEPTED_TYPES.has(selected.type)) { setError(t('visual.invalidImage')); return }
    if (selected.size > MAX_FILE_BYTES) { setError(t('visual.fileTooLarge')); return }
    const version = ++fileVersion.current
    setPreparing(true)
    let bitmap: ImageBitmap | null = null
    try {
      bitmap = await createImageBitmap(selected)
      const dataUrl = encodeImage(bitmap, bitmap.width, bitmap.height, selected.type)
      if (version !== fileVersion.current) return
      const image = { dataUrl, label: selected.name }
      // 読み込み済みの画像だけを採用し、共有中の画面と同時に有効にしません。
      stopSharing()
      fileRef.current = image
      setFile(image)
    } catch (cause) {
      if (version === fileVersion.current) {
        setError(cause instanceof Error && cause.message === t('visual.imageTooLarge')
          ? cause.message : t('visual.invalidImage'))
      }
    } finally {
      bitmap?.close()
      if (version === fileVersion.current) setPreparing(false)
    }
  }

  /** 有効な共有元から一枚だけ取り出し、画面共有は質問時の最新映像を使います。 */
  const capture = (): VisualImage | null => {
    if (fileRef.current) return fileRef.current
    const shared = streamRef.current
    if (!shared) return null
    const video = videoRef.current
    const track = shared.getVideoTracks()[0]
    if (!video || !track || track.readyState !== 'live' || track.muted || video.readyState < 2) {
      throw new Error(t('visual.screenNotReady'))
    }
    return { dataUrl: encodeImage(video, video.videoWidth, video.videoHeight, 'image/jpeg'), label: track.label }
  }

  /** Hermesが受け付けた添付だけを消し、送信失敗時は再試行できるよう残します。 */
  const consume = (sent: VisualImage | null) => {
    if (sent && sent === fileRef.current) removeFile()
  }

  /** ファイルのドロップ時だけブラウザのページ移動を抑え、テキスト操作はそのまま残します。 */
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = blocked ? 'none' : 'copy'
  }
  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    if (!blocked) setDragging(true)
  }
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void selectFiles(Array.from(event.dataTransfer.files))
  }

  return { stream, starting, file, preparing, error, dragging, startSharing, stopSharing,
    removeFile, selectFiles, reset, capture, consume, onDragOver, onDragEnter, onDragLeave, onDrop }
}
