// APIと画面の間で共有する状態を型として固定し、イベント名の取り違えを防ぎます。
export type Role = 'user' | 'assistant'

export interface Message {
  role: Role
  content: string
}

export interface HermesSessionSummary {
  id: string
  title: string | null
  preview: string | null
  startedAt: number | null
  lastActive: number | null
  endedAt: number | null
  endReason: string | null
  parentSessionId: string | null
  messageCount: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  apiCallCount: number
  estimatedCostUsd: number | null
  actualCostUsd: number | null
}

export interface HermesSkillSummary {
  name: string
  description: string
  category: string
}

export interface HermesToolsetSummary {
  name: string
  label: string
  description: string
  enabled: boolean
  configured: boolean
  tools: string[]
}

export interface Health {
  status: string
  model: string
  hermes: HermesHealth
  tts_enabled: boolean
  stt: {
    enabled: boolean
    available: boolean
    model: string
    device: string
    compute_type: string
    message: string | null
  }
  vrm_available: boolean
  vrm_url: string | null
  motions: MotionCatalogItem[]
  generating_motion: string | null
  motion_catalog_error: string | null
}

export interface HermesHealth {
  status: 'ready' | 'incompatible' | 'unavailable' | 'misconfigured'
  message: string | null
  capabilities: {
    platform: string
    model: string
    auth_required: boolean
    features: Record<string, boolean>
    missing_required_features: string[]
  } | null
}

export interface MotionCatalogItem {
  name: string
  label: string
  file: string
  enabled: boolean
  available: boolean
  url: string | null
  playback: MotionPlaybackMode
  exit_duration_seconds: number
}

export type MotionPlaybackMode = 'auto' | 'pose' | 'animation'

export type AvatarState = 'idle' | 'generating' | 'synthesizing' | 'speaking' | 'error'

export type AvatarExpression = 'neutral' | 'happy' | 'relaxed' | 'sad' | 'angry' | 'surprised' | 'shy'

/** VRMのモーフへ直接対応し、赤面のような追加演出を含まない表情名です。 */
export type AvatarMorphExpression = Exclude<AvatarExpression, 'neutral' | 'shy'>

export type DisplayMode = 'standard' | 'conversation'

export type ConversationActivityPhase =
  | 'starting'
  | 'thinking'
  | 'using_tool'
  | 'reviewing'
  | 'composing'
  | 'synthesizing'
  | 'speaking'
  | 'waiting_for_approval'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped'

export interface UiVector3 {
  x: number
  y: number
  z: number
}

export interface UiCameraSettings {
  position: UiVector3
  target: UiVector3
}

export type UiBackgroundFit = 'cover' | 'contain'

export interface UiBackgroundSettings {
  file: string | null
  fit: UiBackgroundFit
}

export interface BackgroundAsset {
  file: string
  url: string
}

export type VrmTouchRegion = 'head' | 'ear' | 'tail' | 'chest' | 'hips' | 'groin' | 'thigh' | 'hand' | 'foot'

export type UiTouchRegions = Record<VrmTouchRegion, boolean>

export type VrmTouchColliderId =
  | 'head'
  | 'leftEar'
  | 'rightEar'
  | 'tail'
  | 'chest'
  | 'hips'
  | 'groin'
  | 'leftThigh'
  | 'rightThigh'
  | 'leftHand'
  | 'rightHand'
  | 'leftFoot'
  | 'rightFoot'

export interface UiTouchHitboxTransform {
  offset: UiVector3
  scale: UiVector3
}

export type UiTouchHitboxProfile = Partial<Record<VrmTouchColliderId, UiTouchHitboxTransform>>
export type UiTouchHitboxProfiles = Record<string, UiTouchHitboxProfile>

export interface UiTouchInteractionSettings {
  extended_regions_enabled: boolean
  enabled: boolean
  debug_hitboxes: boolean
  edit_hitboxes: boolean
  recoil_test_enabled: boolean
  hitbox_profiles: UiTouchHitboxProfiles
  regions: UiTouchRegions
}

export interface UiVoiceInputSettings {
  silence_ms: number
  speech_threshold: number
}

/** 左右別の判定ID、会話用部位、画面位置を一回の接触入力として保持します。 */
export interface VrmTouchHit {
  colliderId: VrmTouchColliderId
  region: VrmTouchRegion
  tag: `[touch:${VrmTouchRegion}]`
  screenX: number
}

export type VrmTouchGesture = 'touch' | 'stroke'

/** 接触の回数とドラッグ種別を、一回の会話入力として保持します。 */
export interface VrmTouchInput extends VrmTouchHit {
  gesture: VrmTouchGesture
  tapCount: number
}

export interface UiSettings {
  schema_version: 1
  cast_off_enabled: boolean
  show_motion_controls: boolean
  show_camera_help: boolean
  speech_volume: number
  camera: UiCameraSettings | null
  background: UiBackgroundSettings
  touch_interaction: UiTouchInteractionSettings
  voice_input: UiVoiceInputSettings
}

// 設定ファイル限定機能は、ブラウザ保存値や設定画面から上書きさせません。
export type UiSettingsOverrides = Partial<Omit<UiSettings, 'schema_version' | 'cast_off_enabled'>>

export type AgentRunState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'using_tool'
  | 'waiting_for_approval'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped'

export interface ToolTimelineItem {
  id: string
  tool: string
  status: 'running' | 'succeeded' | 'failed'
  startedAt: number | null
  durationSeconds: number | null
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export interface ApprovalRequestState {
  id: string
  runId: string
  command: string
  description: string
  choices: ApprovalChoice[]
  status: 'pending' | 'submitting' | 'resolved'
  resolvedChoice: ApprovalChoice | null
  error: string | null
}

export interface MotionCommand {
  id: number
  action: 'play' | 'stop'
  name?: string
  url?: string
  playback?: MotionPlaybackMode
  exitDurationSeconds?: number
}

/** 利用者が選んだローカルVRMAを、永続化せず一度だけ再生する要求です。 */
export interface LocalMotionPreviewRequest {
  id: number
  file: File
}

export interface ResponseMotion {
  name: string
  label: string
  url: string
  playback: MotionPlaybackMode
  exitDurationSeconds: number
}

export type MotionPlayback =
  | { state: 'idle'; name: null }
  | { state: 'loading' | 'playing' | 'stopping'; name: string | null }
  | { state: 'error'; name: string | null; message: string }
