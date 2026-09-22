// Three.jsの描画環境を所有し、VRM固有の振る舞いは再利用可能なランタイムへ委譲します。
import { type DragEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls, type TransformControlsMode } from 'three/examples/jsm/controls/TransformControls.js'
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

import { defaultAvatarCamera, defaultAvatarMotion } from '../config/avatar'
import type {
  AvatarExpression,
  AvatarState,
  LocalMotionPreviewRequest,
  MotionCommand,
  MotionPlayback,
  DisplayMode,
  UiBackgroundFit,
  UiCameraSettings,
  UiTouchHitboxProfile,
  UiTouchInteractionSettings,
  VrmTouchColliderId,
  VrmTouchHit,
  VrmTouchInput,
} from '../types'
import { CastOffController } from '../vrm/CastOffController'
import { logCastOffVrmStructure } from '../vrm/CastOffDiagnostics'
import { VrmRuntime } from '../vrm/VrmRuntime'
import { VRM_TOUCH_COLLIDER_LABELS, VrmTouchController } from '../vrm/VrmTouchController'
import { VrmaPlayer } from '../vrm/VrmaPlayer'

interface Props {
  vrmUrl: string | null
  vrmModelKey: string | null
  avatarState: AvatarState
  avatarExpression: AvatarExpression
  analyser: AnalyserNode | null
  motionCommand: MotionCommand | null
  showCameraHelp: boolean
  cameraSettings: UiCameraSettings | null
  framingMode: DisplayMode
  backgroundUrl: string | null
  backgroundFit: UiBackgroundFit
  castOffEnabled: boolean
  touchInteraction: UiTouchInteractionSettings
  touchBlocked: boolean
  localMotionPreviewEnabled: boolean
  localMotionPreviewBlocked: boolean
  localMotionRequest: LocalMotionPreviewRequest | null
  onMotionStatus: (status: MotionPlayback) => void
  onLocalMotionFile: (file: File) => void
  onLocalMotionRequestConsumed: (id: number) => void
  onCameraChange: (camera: UiCameraSettings) => void
  onTouchHitboxProfileChange: (modelKey: string, profile: UiTouchHitboxProfile) => void
  onVrmTouchDetected: () => void
  onVrmTouch: (input: VrmTouchInput) => void
}

interface HitboxEditorPosition {
  x: number
  y: number
}

interface ActiveTouchGesture {
  pointerId: number
  hit: VrmTouchHit | null
  lastX: number
  lastY: number
  strokeDistance: number
}

const HITBOX_EDITOR_POSITION_STORAGE_KEY = 'avatar-gateway.hitbox-editor-position'
const DEFAULT_HITBOX_EDITOR_POSITION: HitboxEditorPosition = { x: 22, y: 120 }
const TOUCH_BURST_DELAY_MS = 450
const MAX_TOUCH_TAP_COUNT = 5
const TOUCH_STROKE_DISTANCE_PX = 24

/** 壊れたブラウザ保存値で編集画面を見失わないよう、有限の座標だけを復元します。 */
function readHitboxEditorPosition(): HitboxEditorPosition {
  try {
    const raw = localStorage.getItem(HITBOX_EDITOR_POSITION_STORAGE_KEY)
    if (!raw) return DEFAULT_HITBOX_EDITOR_POSITION
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value.x !== 'number' || !Number.isFinite(value.x)) return DEFAULT_HITBOX_EDITOR_POSITION
    if (typeof value.y !== 'number' || !Number.isFinite(value.y)) return DEFAULT_HITBOX_EDITOR_POSITION
    return { x: value.x, y: value.y }
  } catch {
    return DEFAULT_HITBOX_EDITOR_POSITION
  }
}

/** ドラッグ完了位置を、このブラウザだけの作業環境として保存します。 */
function saveHitboxEditorPosition(position: HitboxEditorPosition): void {
  try {
    localStorage.setItem(HITBOX_EDITOR_POSITION_STORAGE_KEY, JSON.stringify(position))
  } catch {
    // 保存不可でも現在の画面内では移動を続けられるため、操作を中断しません。
  }
}

/** 文章入力中のSpaceを、ふれあいモードの一時切替として奪いません。 */
function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return tagName === 'input' || tagName === 'textarea' || target.isContentEditable
}

/** Three.jsのライフサイクルをReactから分離し、アンマウント時にGPU資源を解放します。 */
export default function VrmStage({
  vrmUrl,
  vrmModelKey,
  avatarState,
  avatarExpression,
  analyser,
  motionCommand,
  showCameraHelp,
  cameraSettings,
  framingMode,
  backgroundUrl,
  backgroundFit,
  castOffEnabled,
  touchInteraction,
  touchBlocked,
  localMotionPreviewEnabled,
  localMotionPreviewBlocked,
  localMotionRequest,
  onMotionStatus,
  onLocalMotionFile,
  onLocalMotionRequestConsumed,
  onCameraChange,
  onTouchHitboxProfileChange,
  onVrmTouchDetected,
  onVrmTouch,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const hitboxEditorRef = useRef<HTMLDivElement>(null)
  const hitboxEditorDragRef = useRef<{ pointerId: number, offsetX: number, offsetY: number } | null>(null)
  const stateRef = useRef(avatarState)
  const expressionRef = useRef(avatarExpression)
  const analyserRef = useRef(analyser)
  const playerRef = useRef<VrmaPlayer | null>(null)
  const statusCallbackRef = useRef(onMotionStatus)
  const cameraCallbackRef = useRef(onCameraChange)
  const cameraSettingsRef = useRef(cameraSettings)
  const touchCallbackRef = useRef(onVrmTouch)
  const touchDetectedCallbackRef = useRef(onVrmTouchDetected)
  const touchBlockedRef = useRef(touchBlocked)
  const touchInteractionRef = useRef(touchInteraction)
  const touchControllerRef = useRef<VrmTouchController | null>(null)
  const castOffControllerRef = useRef<CastOffController | null>(null)
  const transformControlsRef = useRef<TransformControls | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const selectedColliderRef = useRef<VrmTouchColliderId | null>(null)
  const mirrorHitboxesRef = useRef(true)
  const hitboxProfileCallbackRef = useRef(onTouchHitboxProfileChange)
  const effectiveTouchModeRef = useRef(false)
  const localMotionDragDepthRef = useRef(0)
  const [loadProgress, setLoadProgress] = useState<number | null>(null)
  const [loadError, setLoadError] = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const [touchMode, setTouchMode] = useState(false)
  const [clothesVisible, setClothesVisible] = useState(true)
  const [castOffAvailable, setCastOffAvailable] = useState(false)
  const [castOffAnimating, setCastOffAnimating] = useState(false)
  const [availableColliders, setAvailableColliders] = useState<VrmTouchColliderId[]>([])
  const [selectedCollider, setSelectedCollider] = useState<VrmTouchColliderId | null>(null)
  const [hitboxTransformMode, setHitboxTransformMode] = useState<TransformControlsMode>('translate')
  const [mirrorHitboxes, setMirrorHitboxes] = useState(true)
  const [hitboxEditorPosition, setHitboxEditorPosition] = useState(readHitboxEditorPosition)
  const hitboxEditorPositionRef = useRef(hitboxEditorPosition)
  const [spaceTouchActive, setSpaceTouchActive] = useState(false)
  const [localMotionDragActive, setLocalMotionDragActive] = useState(false)
  const resetCameraRef = useRef<() => void>(() => undefined)
  const applyCameraRef = useRef<(value: UiCameraSettings | null) => void>(() => undefined)
  const fitCameraRef = useRef<() => void>(() => undefined)
  const selectColliderRef = useRef<(id: VrmTouchColliderId | null) => void>(() => undefined)

  /** 保存座標やドラッグ先を表示領域へ収め、ウインドウ全体を操作不能な場所へ出しません。 */
  const clampHitboxEditorPosition = (position: HitboxEditorPosition): HitboxEditorPosition => {
    const host = hostRef.current
    const editor = hitboxEditorRef.current
    if (!host || !editor) return position
    return {
      x: THREE.MathUtils.clamp(position.x, 8, Math.max(8, host.clientWidth - editor.offsetWidth - 8)),
      y: THREE.MathUtils.clamp(position.y, 8, Math.max(8, host.clientHeight - editor.offsetHeight - 8)),
    }
  }

  /** ヘッダー押下位置を保ったまま、マウスとタッチのドラッグを開始します。 */
  const handleHitboxEditorPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const editor = hitboxEditorRef.current
    if (!editor) return
    const rect = editor.getBoundingClientRect()
    hitboxEditorDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  /** Pointer Capture中だけ座標を更新し、キャンバスのギズモ操作へイベントを渡しません。 */
  const handleHitboxEditorPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = hitboxEditorDragRef.current
    const host = hostRef.current
    if (!drag || drag.pointerId !== event.pointerId || !host) return
    const hostRect = host.getBoundingClientRect()
    const next = clampHitboxEditorPosition({
      x: event.clientX - hostRect.left - drag.offsetX,
      y: event.clientY - hostRect.top - drag.offsetY,
    })
    hitboxEditorPositionRef.current = next
    setHitboxEditorPosition(next)
    event.preventDefault()
  }

  /** ドラッグ終了時だけlocalStorageへ書き、移動中の頻繁な保存を避けます。 */
  const handleHitboxEditorPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = hitboxEditorDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    hitboxEditorDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    saveHitboxEditorPosition(hitboxEditorPositionRef.current)
  }

  /** 初期位置へ戻した直後も、小さい画面では必ず表示範囲内へ収めます。 */
  const resetHitboxEditorPosition = () => {
    const next = clampHitboxEditorPosition(DEFAULT_HITBOX_EDITOR_POSITION)
    hitboxEditorPositionRef.current = next
    setHitboxEditorPosition(next)
    saveHitboxEditorPosition(next)
  }

  // 会話状態の変化だけで19MBのVRMを再ロードしないよう、描画ループから参照します。
  useEffect(() => {
    stateRef.current = avatarState
    expressionRef.current = avatarExpression
    analyserRef.current = analyser
  }, [avatarState, avatarExpression, analyser])

  useEffect(() => {
    statusCallbackRef.current = onMotionStatus
  }, [onMotionStatus])

  useEffect(() => {
    cameraCallbackRef.current = onCameraChange
  }, [onCameraChange])

  useEffect(() => {
    touchCallbackRef.current = onVrmTouch
  }, [onVrmTouch])

  useEffect(() => {
    touchDetectedCallbackRef.current = onVrmTouchDetected
  }, [onVrmTouchDetected])

  useEffect(() => {
    hitboxProfileCallbackRef.current = onTouchHitboxProfileChange
  }, [onTouchHitboxProfileChange])

  useEffect(() => {
    touchBlockedRef.current = touchBlocked
  }, [touchBlocked])

  const effectiveTouchMode = touchInteraction.enabled
    && !touchInteraction.edit_hitboxes
    && (touchMode || spaceTouchActive)

  useEffect(() => {
    effectiveTouchModeRef.current = effectiveTouchMode
    if (controlsRef.current) controlsRef.current.enabled = !effectiveTouchMode
  }, [effectiveTouchMode])

  useEffect(() => {
    touchInteractionRef.current = touchInteraction
    const controller = touchControllerRef.current
    controller?.setInteraction(touchInteraction)
    controller?.setDebug(touchInteraction.debug_hitboxes)
    if (controller) {
      const available = controller.getEditableColliders()
      setAvailableColliders(available)
      if (selectedColliderRef.current && !available.includes(selectedColliderRef.current)) {
        selectColliderRef.current(null)
      }
    }
    if (!touchInteraction.edit_hitboxes) selectColliderRef.current(null)
    if (!touchInteraction.enabled) {
      setTouchMode(false)
      setSpaceTouchActive(false)
    }
  }, [touchInteraction])

  useEffect(() => {
    /** Space長押しを一時的なふれあいモードとして扱い、離した時点で必ず解除します。 */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!touchInteraction.enabled || touchInteraction.edit_hitboxes || event.code !== 'Space' || event.repeat) return
      if (isTextInputTarget(event.target)) return
      event.preventDefault()
      setSpaceTouchActive(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !touchInteraction.enabled) return
      if (!isTextInputTarget(event.target)) event.preventDefault()
      setSpaceTouchActive(false)
    }
    const clearModifier = () => setSpaceTouchActive(false)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', clearModifier)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', clearModifier)
    }
  }, [touchInteraction.enabled, touchInteraction.edit_hitboxes])

  useEffect(() => {
    transformControlsRef.current?.setMode(hitboxTransformMode)
  }, [hitboxTransformMode])

  useEffect(() => {
    mirrorHitboxesRef.current = mirrorHitboxes
  }, [mirrorHitboxes])

  useEffect(() => {
    if (!touchInteraction.edit_hitboxes) return
    /** 保存後に画面寸法が変わっても、ドラッグ用ヘッダーを見える範囲へ戻します。 */
    const keepEditorVisible = () => {
      const current = hitboxEditorPositionRef.current
      const next = clampHitboxEditorPosition(current)
      if (next.x === current.x && next.y === current.y) return
      hitboxEditorPositionRef.current = next
      setHitboxEditorPosition(next)
      saveHitboxEditorPosition(next)
    }
    const frame = requestAnimationFrame(keepEditorVisible)
    window.addEventListener('resize', keepEditorVisible)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', keepEditorVisible)
    }
  }, [touchInteraction.edit_hitboxes])

  useEffect(() => {
    cameraSettingsRef.current = cameraSettings
    if (framingMode !== 'standard') return
    if (cameraSettings) applyCameraRef.current(cameraSettings)
    else fitCameraRef.current()
  }, [cameraSettings])

  useEffect(() => {
    // 縦長への切替後に新しい表示寸法で再計算し、標準画面の保存カメラは変更しません。
    const frame = requestAnimationFrame(() => {
      const savedCamera = cameraSettingsRef.current
      if (framingMode === 'conversation' || !savedCamera) fitCameraRef.current()
      else applyCameraRef.current(savedCamera)
    })
    return () => cancelAnimationFrame(frame)
  }, [framingMode])

  /** UIの再生命令を、ロード済みVRMが所有するプレイヤーへ一度だけ渡します。 */
  useEffect(() => {
    if (!motionCommand) return
    const player = playerRef.current
    if (!player) {
      statusCallbackRef.current({ state: 'error', name: motionCommand.name ?? null, message: 'VRMの読み込み完了後に再生してください' })
      return
    }
    if (motionCommand.action === 'stop') {
      player.stop()
    } else if (motionCommand.name && motionCommand.url) {
      void player.play(
        motionCommand.name,
        motionCommand.url,
        motionCommand.playback,
        motionCommand.exitDurationSeconds,
      )
    }
  }, [motionCommand])

  useEffect(() => {
    if (!localMotionRequest) return
    onLocalMotionRequestConsumed(localMotionRequest.id)
    const player = playerRef.current
    if (!player) {
      statusCallbackRef.current({ state: 'error', name: localMotionRequest.file.name, message: 'VRMの読み込み完了後に試してください' })
      return
    }

    // ファイルはサーバーへ送らず、読込中だけ有効なブラウザ内URLとしてプレイヤーへ渡します。
    const objectUrl = URL.createObjectURL(localMotionRequest.file)
    void player.play(localMotionRequest.file.name, objectUrl, 'auto', 0.6, true)
      .finally(() => URL.revokeObjectURL(objectUrl))
  }, [localMotionRequest])

  useEffect(() => {
    if (localMotionPreviewEnabled) return
    localMotionDragDepthRef.current = 0
    setLocalMotionDragActive(false)
  }, [localMotionPreviewEnabled])

  /** VRM表示領域へのファイル移動だけを受け取り、カメラの通常操作へ干渉させません。 */
  const handleLocalMotionDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!localMotionPreviewEnabled || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    localMotionDragDepthRef.current += 1
    setLocalMotionDragActive(true)
  }

  const handleLocalMotionDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!localMotionPreviewEnabled || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = localMotionPreviewBlocked ? 'none' : 'copy'
  }

  const handleLocalMotionDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!localMotionPreviewEnabled) return
    event.preventDefault()
    localMotionDragDepthRef.current = Math.max(0, localMotionDragDepthRef.current - 1)
    if (localMotionDragDepthRef.current === 0) setLocalMotionDragActive(false)
  }

  const handleLocalMotionDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!localMotionPreviewEnabled) return
    event.preventDefault()
    localMotionDragDepthRef.current = 0
    setLocalMotionDragActive(false)
    const file = event.dataTransfer.files[0]
    if (file) onLocalMotionFile(file)
  }

  /** 現在モデルの調整値だけをReact設定へ戻し、ブラウザ自動保存と共有保存へ接続します。 */
  const publishHitboxProfile = () => {
    const controller = touchControllerRef.current
    if (!controller || !vrmModelKey) return
    hitboxProfileCallbackRef.current(vrmModelKey, controller.readProfile())
  }

  /** 選択部位だけを既定値へ戻し、左右連動が有効なら対になる判定も戻します。 */
  const resetSelectedHitbox = () => {
    if (!selectedCollider) return
    touchControllerRef.current?.resetCollider(selectedCollider, mirrorHitboxes)
    publishHitboxProfile()
  }

  /** 現在のVRMプロファイルだけを空にし、コード既定値を再適用します。 */
  const resetAllHitboxes = () => {
    touchControllerRef.current?.resetAll()
    publishHitboxProfile()
  }

  /** ボタン表示と衣装状態を同期し、飛翔中の重複操作を開始しません。 */
  const handleCastOffToggle = () => {
    const controller = castOffControllerRef.current
    if (!controller || castOffAnimating) return

    if (!clothesVisible) {
      controller.putOn()
      setClothesVisible(true)
      return
    }

    setCastOffAnimating(true)
    const started = controller.startCastOff(() => setCastOffAnimating(false))
    if (started) {
      setClothesVisible(false)
    } else {
      setCastOffAnimating(false)
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new THREE.Scene()
    // 顔へ寄ったときに目や肌が手前クリップで欠けないよう、接写用のnear値を使います。
    const camera = new THREE.PerspectiveCamera(defaultAvatarCamera.fovDegrees, 1, 0.01, 20)
    camera.position.set(0, 1.35, 2.6)
    // 壁紙をThree.jsの照明・カメラから分離し、CSSのcover/containで安定表示します。
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // タッチ操作をPointerEventに統一し、ブラウザのスクロールと二重に処理しません。
    renderer.domElement.style.touchAction = 'none'
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controlsRef.current = controls
    controls.target.set(0, 1.35, 0)
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    }
    controls.enableDamping = true
    controls.dampingFactor = defaultAvatarCamera.dampingFactor
    controls.screenSpacePanning = true
    controls.minDistance = defaultAvatarCamera.minDistance
    controls.maxDistance = defaultAvatarCamera.maxDistance
    controls.enabled = !effectiveTouchModeRef.current
    const preventContextMenu = (event: Event) => event.preventDefault()
    renderer.domElement.addEventListener('contextmenu', preventContextMenu)

    const transformControls = new TransformControls(camera, renderer.domElement)
    transformControls.setMode(hitboxTransformMode)
    transformControls.setSpace('local')
    transformControls.setSize(0.75)
    transformControls.visible = false
    transformControlsRef.current = transformControls
    scene.add(transformControls)

    /** OrbitControlsの内部型を外へ漏らさず、JSON保存可能な現在視点へ変換します。 */
    const publishCamera = () => {
      cameraCallbackRef.current({
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      })
    }
    controls.addEventListener('end', publishCamera)

    let vrm: VRM | null = null
    let runtime: VrmRuntime | null = null
    let activeTouchGesture: ActiveTouchGesture | null = null
    let pendingTouch: { hit: VrmTouchHit, tapCount: number, timerId: number | null } | null = null

    /** 次の押下を判定している間だけ確定を止め、長いドラッグの途中でタップ送信しません。 */
    const pausePendingTouch = () => {
      if (!pendingTouch || pendingTouch.timerId === null) return
      window.clearTimeout(pendingTouch.timerId)
      pendingTouch.timerId = null
    }

    /** 最後のタップ後に一度だけ通知し、反動の回数だけHermes Runが増えることを防ぎます。 */
    const flushPendingTouch = () => {
      const pending = pendingTouch
      if (!pending) return
      if (pending.timerId !== null) window.clearTimeout(pending.timerId)
      pendingTouch = null
      if (
        !touchInteractionRef.current.enabled
        || touchInteractionRef.current.recoil_test_enabled
        || touchBlockedRef.current
      ) return
      touchCallbackRef.current({ ...pending.hit, gesture: 'touch', tapCount: pending.tapCount })
    }

    /** 一時停止した単発候補を、ドラッグが接触しなかった場合だけ通常の待ち時間へ戻します。 */
    const resumePendingTouch = () => {
      if (!pendingTouch || pendingTouch.timerId !== null) return
      pendingTouch.timerId = window.setTimeout(flushPendingTouch, TOUCH_BURST_DELAY_MS)
    }

    /** 同じ部位への短い連打だけをまとめ、別部位へ移った場合は先の接触を優先します。 */
    const queueTouch = (hit: VrmTouchHit) => {
      if (pendingTouch && pendingTouch.hit.region !== hit.region) {
        flushPendingTouch()
        return
      }
      const tapCount = Math.min((pendingTouch?.tapCount ?? 0) + 1, MAX_TOUCH_TAP_COUNT)
      if (pendingTouch?.timerId !== null && pendingTouch?.timerId !== undefined) {
        window.clearTimeout(pendingTouch.timerId)
      }
      const timerId = window.setTimeout(flushPendingTouch, TOUCH_BURST_DELAY_MS)
      pendingTouch = { hit, tapCount, timerId }
    }

    const handleTransformDragging = (event: { value: unknown }) => {
      controls.enabled = !Boolean(event.value) && !effectiveTouchModeRef.current
    }
    const handleTransformChange = () => {
      const id = selectedColliderRef.current
      if (!id) return
      touchControllerRef.current?.constrainAndMirror(id, mirrorHitboxesRef.current)
    }
    const handleTransformComplete = () => publishHitboxProfile()
    transformControls.addEventListener('dragging-changed', handleTransformDragging)
    transformControls.addEventListener('objectChange', handleTransformChange)
    transformControls.addEventListener('mouseUp', handleTransformComplete)

    selectColliderRef.current = (id) => {
      selectedColliderRef.current = id
      setSelectedCollider(id)
      const object = touchControllerRef.current?.selectCollider(id)
      if (object) {
        transformControls.attach(object)
        transformControls.visible = touchInteractionRef.current.edit_hitboxes
      } else {
        transformControls.detach()
        transformControls.visible = false
      }
    }
    /** 押下時は反動だけを返し、離すまでタップか撫で操作かの確定を待ちます。 */
    const handlePointerDown = (event: PointerEvent) => {
      if (touchInteractionRef.current.edit_hitboxes) {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        // ギズモの軸を掴んだ押下は選択変更に使わず、TransformControlsへ任せます。
        if (transformControls.axis !== null) return
        const id = touchControllerRef.current?.pickCollider(event, camera, renderer.domElement) ?? null
        selectColliderRef.current(id)
        return
      }
      if (!effectiveTouchModeRef.current || touchBlockedRef.current) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (activeTouchGesture !== null) return
      event.preventDefault()
      renderer.domElement.setPointerCapture?.(event.pointerId)
      const hit = touchControllerRef.current?.hitTest(event, camera, renderer.domElement)
      activeTouchGesture = {
        pointerId: event.pointerId,
        hit: hit ?? null,
        lastX: event.clientX,
        lastY: event.clientY,
        strokeDistance: 0,
      }
      if (hit) {
        pausePendingTouch()
        // 遅延確定後の音声も再生できるよう、ブラウザの利用者操作中にAudioContextを有効化します。
        touchDetectedCallbackRef.current()
        runtime?.applyTouchRecoil(hit.colliderId, hit.region, hit.screenX)
        runtime?.beginTouchFollow(hit.colliderId, hit.region)
      }
    }

    /** 同じ部位上を移動した距離だけを数え、部位外のドラッグを撫で操作へ混ぜません。 */
    const handlePointerMove = (event: PointerEvent) => {
      const gesture = activeTouchGesture
      if (!gesture || gesture.pointerId !== event.pointerId || !gesture.hit) return
      const deltaX = event.clientX - gesture.lastX
      const deltaY = event.clientY - gesture.lastY
      const distance = Math.hypot(deltaX, deltaY)
      gesture.lastX = event.clientX
      gesture.lastY = event.clientY
      const currentHit = touchControllerRef.current?.hitTest(event, camera, renderer.domElement)
      if (currentHit?.region === gesture.hit.region) {
        gesture.strokeDistance += distance
        runtime?.updateTouchFollow(deltaX, deltaY)
      }
      event.preventDefault()
    }

    /** 短い押下は連続タップへ、一定距離のドラッグは一回の撫で操作へ確定します。 */
    const handlePointerUp = (event: PointerEvent) => {
      const gesture = activeTouchGesture
      if (!gesture || gesture.pointerId !== event.pointerId) return
      handlePointerMove(event)
      activeTouchGesture = null
      runtime?.endTouchFollow()
      if (renderer.domElement.hasPointerCapture?.(event.pointerId)) {
        renderer.domElement.releasePointerCapture?.(event.pointerId)
      }
      if (!gesture.hit) {
        resumePendingTouch()
        return
      }
      if (gesture.strokeDistance >= TOUCH_STROKE_DISTANCE_PX) {
        if (pendingTouch?.timerId !== null && pendingTouch?.timerId !== undefined) {
          window.clearTimeout(pendingTouch.timerId)
        }
        pendingTouch = null
        if (!touchInteractionRef.current.recoil_test_enabled && !touchBlockedRef.current) {
          touchCallbackRef.current({ ...gesture.hit, gesture: 'stroke', tapCount: 1 })
        }
        return
      }
      if (!touchInteractionRef.current.recoil_test_enabled) queueTouch(gesture.hit)
      else resumePendingTouch()
    }

    /** OSやブラウザが操作を中断した場合は送信せず、確定待ちだった以前のタップだけを戻します。 */
    const handlePointerCancel = (event: PointerEvent) => {
      if (activeTouchGesture?.pointerId !== event.pointerId) return
      activeTouchGesture = null
      runtime?.endTouchFollow()
      if (renderer.domElement.hasPointerCapture?.(event.pointerId)) {
        renderer.domElement.releasePointerCapture?.(event.pointerId)
      }
      resumePendingTouch()
    }
    renderer.domElement.addEventListener('pointerdown', handlePointerDown)
    renderer.domElement.addEventListener('pointermove', handlePointerMove)
    renderer.domElement.addEventListener('pointerup', handlePointerUp)
    renderer.domElement.addEventListener('pointercancel', handlePointerCancel)

    // 前実装と同じ白色照明に揃え、色付きの強い環境光でVRMの細部を白く潰しません。
    scene.add(new THREE.AmbientLight(0xffffff, 1.2))
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8)
    keyLight.position.set(1, 1, 1).normalize()
    scene.add(keyLight)

    let frame = 0
    let disposed = false
    const clock = new THREE.Clock()

    // URLが空になった場合も、以前のモデルで表示した進捗やエラーを残さないよう初期化します。
    setLoadProgress(vrmUrl ? 0 : null)
    setLoadError('')
    setClothesVisible(true)
    setCastOffAvailable(false)
    setCastOffAnimating(false)

    /** 表示領域に追随してカメラの縦横比を保ちます。 */
    const resize = () => {
      const width = Math.max(host.clientWidth, 1)
      const height = Math.max(host.clientHeight, 1)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    /** モデル寸法と現在の画面比率から、全身が収まる初期カメラ位置を決めます。 */
    const fitCameraToVrm = (loadedVrm: VRM) => {
      loadedVrm.scene.updateWorldMatrix(true, true)
      const box = new THREE.Box3().setFromObject(loadedVrm.scene)
      if (!Number.isFinite(box.min.y) || !Number.isFinite(box.max.y)) return

      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const paddedHeight = size.y * defaultAvatarCamera.fitPadding
      const paddedWidth = size.x * defaultAvatarCamera.fitPadding
      const verticalFov = THREE.MathUtils.degToRad(camera.fov)
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
      const distanceForHeight = (paddedHeight / 2) / Math.tan(verticalFov / 2)
      const distanceForWidth = (paddedWidth / 2) / Math.tan(horizontalFov / 2)
      const distance = THREE.MathUtils.clamp(
        Math.max(distanceForHeight, distanceForWidth),
        controls.minDistance,
        controls.maxDistance,
      )
      const targetY = box.min.y + size.y * defaultAvatarCamera.targetHeightRatio

      controls.target.set(center.x, targetY, center.z)
      camera.position.set(center.x, targetY, center.z + distance)
      controls.update()
      resetCameraRef.current = () => {
        controls.target.set(center.x, targetY, center.z)
        camera.position.set(center.x, targetY, center.z + distance)
        controls.update()
        publishCamera()
      }
      applyCameraRef.current = (value) => {
        if (!value) {
          controls.reset()
        } else {
          camera.position.set(value.position.x, value.position.y, value.position.z)
          controls.target.set(value.target.x, value.target.y, value.target.z)
          controls.update()
        }
        publishCamera()
      }
      fitCameraRef.current = () => fitCameraToVrm(loadedVrm)
      if (framingMode === 'standard' && cameraSettingsRef.current) {
        applyCameraRef.current(cameraSettingsRef.current)
      } else {
        publishCamera()
      }
      setCameraReady(true)
    }

    if (vrmUrl) {
      const loader = new GLTFLoader()
      loader.register((parser) => new VRMLoaderPlugin(parser))
      loader.load(vrmUrl, (gltf) => {
        if (disposed) return
        vrm = gltf.userData.vrm as VRM
        if (!vrm) {
          setLoadError('VRM情報を読み取れませんでした。対応するVRMファイルか確認してください。')
          setLoadProgress(null)
          return
        }
        VRMUtils.removeUnnecessaryVertices(gltf.scene)
        VRMUtils.combineSkeletons(gltf.scene)
        VRMUtils.rotateVRM0(vrm)
        scene.add(vrm.scene)
        vrm.scene.rotation.y = Math.PI
        if (castOffEnabled) {
          logCastOffVrmStructure(vrm, gltf.parser.json.asset)
          castOffControllerRef.current = new CastOffController(vrm)
          setCastOffAvailable(castOffControllerRef.current.hasTargets())
        }
        runtime = new VrmRuntime(vrm, defaultAvatarMotion)
        const currentTouchInteraction = touchInteractionRef.current
        touchControllerRef.current = new VrmTouchController(
          vrm,
          currentTouchInteraction,
          vrmModelKey ?? 'unknown.vrm',
        )
        setAvailableColliders(touchControllerRef.current.getEditableColliders())
        playerRef.current = new VrmaPlayer(vrm, (status) => statusCallbackRef.current(status))
        fitCameraToVrm(vrm)
        setLoadProgress(null)
      }, (progress) => {
        if (!disposed && progress.total > 0) {
          setLoadProgress(Math.min(Math.round((progress.loaded / progress.total) * 100), 100))
        }
      }, (cause) => {
        if (disposed) return
        const detail = cause instanceof Error ? cause.message : '不明な読み込みエラー'
        setLoadError(`VRMを読み込めませんでした: ${detail}`)
        setLoadProgress(null)
      })
    }

    /** 状態入力をランタイムへ渡し、描画環境はレンダリングだけを担当します。 */
    const animate = () => {
      frame = requestAnimationFrame(animate)
      const delta = Math.min(clock.getDelta(), 0.05)
      if (runtime) {
        // 前フレームの微動をMixerが主動作として再取得しないよう、毎回Base Poseから評価します。
        runtime.preparePrimaryMotionEvaluation()
        const primaryMotionWeight = playerRef.current?.update(delta) ?? 0
        runtime.setPrimaryMotionWeight(primaryMotionWeight)
        runtime.setPrimaryMotionKind(playerRef.current?.getMotionKind() ?? null)
        runtime.setStaticPrimaryPose(playerRef.current?.getStaticPose() ?? null)
        runtime.setInputs(stateRef.current, analyserRef.current, expressionRef.current)
        runtime.update(delta, clock.elapsedTime)
      }
      castOffControllerRef.current?.update(delta)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      disposed = true
      runtime?.endTouchFollow()
      cancelAnimationFrame(frame)
      observer.disconnect()
      playerRef.current?.dispose()
      playerRef.current = null
      touchControllerRef.current?.dispose()
      touchControllerRef.current = null
      castOffControllerRef.current?.dispose()
      castOffControllerRef.current = null
      transformControls.removeEventListener('dragging-changed', handleTransformDragging)
      transformControls.removeEventListener('objectChange', handleTransformChange)
      transformControls.removeEventListener('mouseUp', handleTransformComplete)
      transformControls.detach()
      transformControls.dispose()
      scene.remove(transformControls)
      transformControlsRef.current = null
      controlsRef.current = null
      selectColliderRef.current = () => undefined
      selectedColliderRef.current = null
      setAvailableColliders([])
      setSelectedCollider(null)
      resetCameraRef.current = () => undefined
      applyCameraRef.current = () => undefined
      fitCameraRef.current = () => undefined
      setCameraReady(false)
      renderer.domElement.removeEventListener('contextmenu', preventContextMenu)
      controls.removeEventListener('end', publishCamera)
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      renderer.domElement.removeEventListener('pointermove', handlePointerMove)
      renderer.domElement.removeEventListener('pointerup', handlePointerUp)
      renderer.domElement.removeEventListener('pointercancel', handlePointerCancel)
      if (pendingTouch?.timerId !== null && pendingTouch?.timerId !== undefined) {
        window.clearTimeout(pendingTouch.timerId)
      }
      pendingTouch = null
      controls.dispose()
      if (vrm) VRMUtils.deepDispose(vrm.scene)
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [vrmUrl, vrmModelKey, castOffEnabled])

  return (
    <div
      className={`vrm-stage${effectiveTouchMode ? ' touch-active' : ''}${touchInteraction.edit_hitboxes ? ' hitbox-editing' : ''}${localMotionDragActive ? ' motion-drop-active' : ''}`}
      aria-label="VRMアバター表示領域"
      onDragEnter={handleLocalMotionDragEnter}
      onDragOver={handleLocalMotionDragOver}
      onDragLeave={handleLocalMotionDragLeave}
      onDrop={handleLocalMotionDrop}
    >
      <div
        className="vrm-background"
        aria-hidden="true"
        style={{
          backgroundImage: backgroundUrl ? `url("${backgroundUrl}")` : undefined,
          backgroundSize: backgroundFit,
        }}
      />
      <div className="vrm-canvas" ref={hostRef} />
      {loadProgress !== null && <div className="vrm-loading">VRMを読み込み中… {loadProgress}%</div>}
      {loadError && <div className="vrm-load-error" role="alert">{loadError}</div>}
      {localMotionDragActive && (
        <div className={`motion-drop-overlay${localMotionPreviewBlocked ? ' blocked' : ''}`} role="status">
          <strong>{localMotionPreviewBlocked ? '会話中は再生できません' : 'VRMAをドロップして一時再生'}</strong>
          <span>カタログには登録されません</span>
        </div>
      )}
      {cameraReady && showCameraHelp && (
        <div className="camera-help">
          <span>左: 移動 · ホイール: ズーム · 右: 回転</span>
          <button type="button" onClick={() => resetCameraRef.current()}>カメラをリセット</button>
        </div>
      )}
      {cameraReady && touchInteraction.enabled && touchInteraction.edit_hitboxes && vrmModelKey && (
        <div
          ref={hitboxEditorRef}
          className="hitbox-editor"
          aria-label="当たり判定編集"
          style={{ left: hitboxEditorPosition.x, top: hitboxEditorPosition.y }}
        >
          <div
            className="hitbox-editor-header"
            onPointerDown={handleHitboxEditorPointerDown}
            onPointerMove={handleHitboxEditorPointerMove}
            onPointerUp={handleHitboxEditorPointerUp}
            onPointerCancel={handleHitboxEditorPointerUp}
          >
            <strong>当たり判定編集</strong>
            <span>ドラッグで移動</span>
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={resetHitboxEditorPosition}
            >位置を戻す</button>
          </div>
          <div className="hitbox-editor-row">
            <label>
              <span>判定</span>
              <select
                value={selectedCollider ?? ''}
                onChange={(event) => selectColliderRef.current(
                  (event.target.value || null) as VrmTouchColliderId | null,
                )}
              >
                <option value="">画面で選択</option>
                {availableColliders.map((id) => (
                  <option key={id} value={id}>{VRM_TOUCH_COLLIDER_LABELS[id]}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={hitboxTransformMode === 'translate' ? 'active' : ''}
              onClick={() => setHitboxTransformMode('translate')}
            >移動</button>
            <button
              type="button"
              className={hitboxTransformMode === 'scale' ? 'active' : ''}
              onClick={() => setHitboxTransformMode('scale')}
            >拡縮</button>
          </div>
          <div className="hitbox-editor-row secondary">
            <label className="hitbox-mirror-toggle">
              <input
                type="checkbox"
                checked={mirrorHitboxes}
                onChange={(event) => setMirrorHitboxes(event.target.checked)}
              />
              左右連動
            </label>
            <button type="button" disabled={!selectedCollider} onClick={resetSelectedHitbox}>選択を戻す</button>
            <button type="button" onClick={resetAllHitboxes}>全て戻す</button>
          </div>
          <small>{vrmModelKey} · 黄色が選択中です</small>
        </div>
      )}
      {cameraReady && touchInteraction.enabled && !touchInteraction.edit_hitboxes && (
        <button
          type="button"
          className={`touch-mode-button${effectiveTouchMode ? ' active' : ''}`}
          aria-pressed={effectiveTouchMode}
          title={touchInteraction.recoil_test_enabled
            ? '反動だけを確認し、Hermesへは送信しません'
            : 'Spaceキーを押している間も一時的に有効になります'}
          onClick={() => setTouchMode((current) => !current)}
        >
          <span aria-hidden="true">✋</span>
          {touchInteraction.recoil_test_enabled
            ? effectiveTouchMode ? '反動テスト中' : '反動テスト'
            : effectiveTouchMode ? 'ふれあい中' : 'ふれあい'}
        </button>
      )}
      {cameraReady && castOffEnabled && (
        <button
          type="button"
          className={`cast-off-button${clothesVisible ? '' : ' active'}`}
          aria-pressed={!clothesVisible}
          disabled={!castOffAvailable || castOffAnimating}
          title={castOffAvailable
            ? clothesVisible ? '上着・ボトムス・靴を飛ばします' : '上着・ボトムス・靴を元へ戻します'
            : 'このモデルには対応する衣装がありません'}
          onClick={handleCastOffToggle}
        >
          {clothesVisible ? '🪲PUTON' : '🪲CASTOFF'}
        </button>
      )}
    </div>
  )
}
