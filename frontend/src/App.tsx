// 会話履歴、SSE応答、音声再生、アバター状態を結び付ける画面本体です。
import { FormEvent, KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

import ApprovalPanel from './components/ApprovalPanel'
import AgentResourcesPanel from './components/AgentResourcesPanel'
import ConversationActivityOverlay from './components/ConversationActivityOverlay'
import ConversationModeOverlay from './components/ConversationModeOverlay'
import MarkdownMessage from './components/MarkdownMessage'
import SessionActionIcon from './components/SessionActionIcon'
import SessionHistoryPanel from './components/SessionHistoryPanel'
import SettingsPanel from './components/SettingsPanel'
import ToolTimeline from './components/ToolTimeline'
import VoiceInputControl from './components/VoiceInputControl'
import VrmStage from './components/VrmStage'
import { advanceActiveRun, clearActiveRun, readActiveRun, saveActiveRun } from './lib/activeRun'
import { readDisplayMode, saveDisplayMode } from './lib/displayMode'
import { readSessionMessages, readSessionSummary } from './lib/session'
import { consumeSse } from './lib/sse'
import {
  fallbackUiSettings,
  mergeUiSettings,
  readBackgroundAssets,
  readUiSettings,
  readUiSettingsOverrides,
  saveUiSettingsOverrides,
} from './lib/uiSettings'
import type {
  AgentRunState,
  ApprovalChoice,
  ApprovalRequestState,
  AvatarExpression,
  AvatarState,
  BackgroundAsset,
  ConversationActivityPhase,
  Health,
  LocalMotionPreviewRequest,
  Message,
  MotionCatalogItem,
  MotionCommand,
  MotionPlayback,
  ResponseMotion,
  ToolTimelineItem,
  UiCameraSettings,
  UiSettings,
  UiSettingsOverrides,
  UiTouchHitboxProfile,
  VrmTouchInput,
  VrmTouchRegion,
} from './types'

const stateLabels: Record<AvatarState, string> = {
  idle: '待機中',
  generating: '考え中',
  synthesizing: '音声を準備中',
  speaking: '発話中',
  error: 'エラー',
}

const MAX_LOCAL_MOTION_FILE_BYTES = 50 * 1024 * 1024

const touchDisplayLabels: Record<VrmTouchRegion, string> = {
  head: '（頭に触れた）',
  ear: '（耳に触れた）',
  tail: '（尻尾に触れた）',
  chest: '（胸に触れた）',
  hips: '（尻に触れた）',
  groin: '（股間に触れた）',
  thigh: '（太ももに触れた）',
  hand: '（手に触れた）',
  foot: '（足に触れた）',
}

const touchDisplayNames: Record<VrmTouchRegion, string> = {
  head: '頭',
  ear: '耳',
  tail: '尻尾',
  chest: '胸',
  hips: '尻',
  groin: '股間',
  thigh: '太もも',
  hand: '手',
  foot: '足',
}

/** 単発は従来タグを保ち、連続タップだけ回数付きの接触イベントへ拡張します。 */
function touchInputText(input: VrmTouchInput): string {
  if (input.gesture === 'stroke') return input.tag.replace(']', ' action=stroke]')
  if (input.tapCount <= 1) return input.tag
  return input.tag.replace(']', ` count=${input.tapCount}]`)
}

/** 履歴では内部タグを見せず、接触方法と回数を自然な日本語で示します。 */
function touchDisplayText(input: VrmTouchInput): string {
  if (input.gesture === 'stroke') return `（${touchDisplayNames[input.region]}を撫でた）`
  if (input.tapCount <= 1) return touchDisplayLabels[input.region]
  return `（${touchDisplayNames[input.region]}に${input.tapCount}回触れた）`
}

interface SpeechRequest {
  audioUrl: string
  utteranceId: string
  sequenceId: string | null
  segmentIndex: number | null
  motion: ResponseMotion | null
  expression: AvatarExpression
}

interface ConversationSession {
  id: number
  runId: string | null
  speechSequenceId: string | null
  controller: AbortController
  speechController: AbortController
  cancelled: boolean
  speechStopped: boolean
  assistantCompleted: boolean
  activeSource: AudioBufferSourceNode | null
  pendingSpeech: Map<string, SpeechRequest>
}

const HERMES_SESSION_STORAGE_KEY = 'avatar-gateway.hermes-session-id'

type PreparedSpeech =
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' }

type SpeechPlaybackResult =
  | { status: 'completed' | 'cancelled'; error: null }
  | { status: 'failed'; error: string }

/** ブラウザごとの例外型の違いを吸収し、利用者の中断を通信エラーと区別します。 */
function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

/** 次の文を再生中の音声と並行して取得・デコードし、文間の待ち時間を減らします。 */
async function prepareSpeech(
  request: SpeechRequest,
  context: AudioContext,
  signal: AbortSignal,
): Promise<PreparedSpeech> {
  try {
    const audioResponse = await fetch(request.audioUrl, { signal })
    if (!audioResponse.ok) throw new Error(`音声ファイルを取得できませんでした (${audioResponse.status})`)
    const buffer = await context.decodeAudioData(await audioResponse.arrayBuffer())
    // decodeAudioData自体は中断できないため、完了後に古い結果を採用しないよう再確認します。
    if (signal.aborted) return { status: 'cancelled' }
    return { status: 'ready', buffer }
  } catch (cause) {
    if (signal.aborted || isAbortError(cause)) return { status: 'cancelled' }
    return {
      status: 'failed',
      error: cause instanceof Error ? cause.message : '音声を準備できませんでした。',
    }
  }
}

/** 文単位の実再生結果を、同じ応答と文番号を添えてバックエンドへ通知します。 */
function notifySpeech(
  type: string,
  request: SpeechRequest,
  extra: Record<string, unknown> = {},
): Promise<Response | undefined> {
  return fetch('/api/speech-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      type,
      utterance_id: request.utteranceId,
      sequence_id: request.sequenceId ?? undefined,
      segment_index: request.segmentIndex ?? undefined,
      ...extra,
    }),
  }).catch(() => undefined)
}

/** 文単位WAVの破棄に加え、バックエンドで未処理のTTSキューも応答単位で停止します。 */
function cancelSpeechSequence(sequenceId: string): Promise<Response | undefined> {
  return fetch(`/api/speech-sequences/${encodeURIComponent(sequenceId)}/cancel`, {
    method: 'POST',
    keepalive: true,
  }).catch(() => undefined)
}

/** HermesのRunは継続したまま、現在の応答に属する音声だけを破棄します。 */
function cancelSessionSpeech(session: ConversationSession, reason: string): void {
  if (session.speechStopped) return
  session.speechStopped = true
  session.speechController.abort()
  const source = session.activeSource
  session.activeSource = null
  if (source) {
    try {
      source.stop()
    } catch {
      // 開始前または終了直後の音源は既に止まっているため、そのまま後始末を続けます。
    }
  }

  // 正常な失敗と区別しつつ、再生しないWAVもバックエンドから確実に削除します。
  for (const request of session.pendingSpeech.values()) {
    void notifySpeech('speech.cancelled', request, { reason })
  }
  session.pendingSpeech.clear()
  if (session.speechSequenceId) void cancelSpeechSequence(session.speechSequenceId)
}

/** 一つの会話に属するHermes通信と音声をまとめて破棄します。 */
function cancelConversationSession(session: ConversationSession): void {
  if (session.cancelled) return
  session.cancelled = true
  session.controller.abort()
  cancelSessionSpeech(session, '利用者が会話を中断しました')
}

/** 準備済みの一文を順番に再生し、区間ごとの開始・完了・失敗を通知します。 */
async function playPreparedSpeech(
  preparedPromise: Promise<PreparedSpeech>,
  request: SpeechRequest,
  context: AudioContext,
  session: ConversationSession,
  volume: number,
  setAnalyser: (value: AnalyserNode | null) => void,
  onStarted: () => void,
  onSettled: () => void,
): Promise<SpeechPlaybackResult> {
  const prepared = await preparedPromise
  if (prepared.status === 'cancelled' || session.cancelled || session.speechStopped) {
    onSettled()
    return { status: 'cancelled', error: null }
  }
  if (prepared.status === 'failed') {
    onSettled()
    void notifySpeech('speech.failed', request, { reason: prepared.error })
    return { status: 'failed', error: prepared.error }
  }

  const source = context.createBufferSource()
  const analyser = context.createAnalyser()
  const gain = context.createGain()
  let timeoutId: number | null = null
  let started = false

  /** 音声専用の中断操作で、Hermes通信を残したまま現在の音源だけを止めます。 */
  const stopSource = () => {
    if (!started) return
    try {
      source.stop()
    } catch {
      // onended後との競合は中断処理上の正常系なので無視します。
    }
  }
  session.speechController.signal.addEventListener('abort', stopSource, { once: true })

  try {
    source.buffer = prepared.buffer
    // 前実装と同じ2048サンプルの時間波形から音節ごとの振幅を拾います。
    analyser.fftSize = 2048
    gain.gain.value = volume
    source.connect(analyser)
    analyser.connect(gain)
    gain.connect(context.destination)
    session.activeSource = source
    setAnalyser(analyser)

    const ended = new Promise<void>((resolve, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error('音声再生がタイムアウトしました')),
        Math.ceil(prepared.buffer.duration * 1000) + 5000,
      )
      source.onended = () => {
        if (timeoutId !== null) window.clearTimeout(timeoutId)
        timeoutId = null
        resolve()
      }
    })

    await context.resume()
    if (session.cancelled || session.speechStopped || session.speechController.signal.aborted) {
      return { status: 'cancelled', error: null }
    }
    const startedAt = performance.now()
    source.start()
    started = true
    onStarted()
    void notifySpeech('speech.started', request)
    await ended
    if (session.cancelled || session.speechStopped || session.speechController.signal.aborted) {
      return { status: 'cancelled', error: null }
    }
    // 完了通知の通信を待たず、準備済みの次文を直ちに再生します。
    void notifySpeech('speech.completed', request, { played_ms: Math.round(performance.now() - startedAt) })
    return { status: 'completed', error: null }
  } catch (cause) {
    if (
      session.cancelled
      || session.speechStopped
      || session.speechController.signal.aborted
      || isAbortError(cause)
    ) {
      return { status: 'cancelled', error: null }
    }
    const reason = cause instanceof Error ? cause.message : '音声を再生できませんでした。'
    try {
      source.stop()
    } catch {
      // 開始前や終了後のstop例外は、元の再生エラーを隠すため無視します。
    }
    void notifySpeech('speech.failed', request, { reason })
    return { status: 'failed', error: reason }
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId)
    session.speechController.signal.removeEventListener('abort', stopSource)
    source.onended = null
    if (session.activeSource === source) session.activeSource = null
    onSettled()
    setAnalyser(null)
    source.disconnect()
    analyser.disconnect()
    gain.disconnect()
  }
}

/** APIカタログで利用可能と確認済みの項目だけを、実際の再生情報へ変換します。 */
function findPlayableMotion(motions: MotionCatalogItem[], name: string | null): ResponseMotion | null {
  if (!name) return null
  const motion = motions.find((candidate) => candidate.name === name)
  if (!motion?.enabled || !motion.available || !motion.url) return null
  return {
    name: motion.name,
    label: motion.label,
    url: motion.url,
    playback: motion.playback,
    exitDurationSeconds: motion.exit_duration_seconds,
  }
}

/** 音声イベントのモーション名を、ヘルスAPIで検証済みの再生情報へ対応付けます。 */
function readSpeechMotion(data: Record<string, unknown>, motions: MotionCatalogItem[]): ResponseMotion | null {
  if (!data.motion || typeof data.motion !== 'object') return null
  const motion = data.motion as Record<string, unknown>
  return findPlayableMotion(motions, typeof motion.name === 'string' ? motion.name : null)
}

/** バックエンドで検証済みでも、ブラウザ境界では許可した表情だけを再確認します。 */
function readSpeechExpression(data: Record<string, unknown>): AvatarExpression {
  const value = data.expression
  if (
    value === 'happy'
    || value === 'relaxed'
    || value === 'sad'
    || value === 'angry'
    || value === 'surprised'
    || value === 'shy'
  ) return value
  return 'neutral'
}

/** Hermesやブラウザから届く任意文字列を、承認APIで許可する4値だけへ絞ります。 */
function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return value === 'once' || value === 'session' || value === 'always' || value === 'deny'
}

/** 承認イベントを検証し、回答APIへ安全に渡せる画面状態だけを組み立てます。 */
function readApprovalRequest(
  data: Record<string, unknown>,
  fallbackRunId: string | null,
): ApprovalRequestState | null {
  const runId = typeof data.run_id === 'string' ? data.run_id : fallbackRunId
  if (!runId) return null
  const choices = Array.isArray(data.choices) ? data.choices.filter(isApprovalChoice) : []
  const sequence = typeof data.sequence === 'number' ? data.sequence : Date.now()
  return {
    id: `${runId}-${sequence}`,
    runId,
    command: typeof data.command === 'string' ? data.command : '',
    description: typeof data.description === 'string' ? data.description : '',
    choices,
    status: 'pending',
    resolvedChoice: null,
    error: choices.length > 0 ? null : 'Hermesから選択肢が提供されていません。中断してください。',
  }
}

/** 安全化済みSSEだけから、同じツールの開始と完了を実行順に対応付けます。 */
function updateToolTimeline(
  items: ToolTimelineItem[],
  eventName: 'tool.started' | 'tool.completed',
  data: Record<string, unknown>,
): ToolTimelineItem[] {
  const tool = typeof data.tool === 'string' && data.tool ? data.tool : '不明なツール'
  const sequence = typeof data.sequence === 'number' ? data.sequence : items.length + 1
  const timestamp = typeof data.timestamp === 'number' ? data.timestamp : null

  if (eventName === 'tool.started') {
    return [...items, {
      id: `${String(data.run_id ?? 'run')}-${sequence}`,
      tool,
      status: 'running',
      startedAt: timestamp,
      durationSeconds: null,
    }]
  }

  // Hermesは初期版では呼び出しIDを返さないため、同名の未完了項目を後ろから対応付けます。
  let runningIndex = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].tool === tool && items[index].status === 'running') {
      runningIndex = index
      break
    }
  }
  const durationSeconds = typeof data.duration === 'number' && data.duration >= 0
    ? data.duration
    : null
  const status = data.error === true ? 'failed' : 'succeeded'
  if (runningIndex < 0) {
    // 再接続時に開始イベントが欠けても、完了イベントそのものは失わず表示します。
    return [...items, {
      id: `${String(data.run_id ?? 'run')}-completed-${sequence}`,
      tool,
      status,
      startedAt: null,
      durationSeconds,
    }]
  }
  return items.map((item, index) => index === runningIndex
    ? { ...item, status, durationSeconds }
    : item)
}

/** 停止要求後もHermesの確定状態を確認し、stoppingを停止済みと誤表示しません。 */
async function stopHermesRun(runId: string): Promise<AgentRunState> {
  const stopResponse = await fetch(`/api/hermes/runs/${runId}/stop`, {
    method: 'POST',
    keepalive: true,
  })
  if (!stopResponse.ok) throw new Error(`Hermes停止APIエラー: ${stopResponse.status}`)

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250))
    const response = await fetch(`/api/hermes/runs/${runId}`)
    if (!response.ok) continue
    const data = await response.json() as Record<string, unknown>
    if (data.status === 'cancelled') return 'stopped'
    if (data.status === 'completed') return 'completed'
    if (data.status === 'failed') return 'failed'
  }
  return 'stopping'
}

/** バックエンドの安全化済みdetailを優先し、JSON以外の障害でも状態コードを残します。 */
async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as Record<string, unknown>
    if (typeof data.detail === 'string') return data.detail
  } catch {
    // プロキシ等がHTMLを返す場合も、呼び出し側の説明と状態コードで案内します。
  }
  return `${fallback}: ${response.status}`
}

/** Hermesの保存状態を、画面で区別しているRun状態へ不足なく対応付けます。 */
function readAgentRunState(value: unknown): AgentRunState {
  if (value === 'started') return 'starting'
  if (value === 'running') return 'running'
  if (value === 'waiting_for_approval') return 'waiting_for_approval'
  if (value === 'stopping') return 'stopping'
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  if (value === 'cancelled') return 'stopped'
  return 'running'
}

/** 復元されたRun状態を、詳細を推測しない会話画面用の段階へ変換します。 */
function activityPhaseForRunState(state: AgentRunState): ConversationActivityPhase | null {
  if (state === 'idle') return null
  if (state === 'starting') return 'starting'
  if (state === 'running') return 'thinking'
  if (state === 'using_tool') return 'using_tool'
  if (state === 'waiting_for_approval') return 'waiting_for_approval'
  if (state === 'stopping') return 'stopping'
  if (state === 'completed') return 'completed'
  if (state === 'failed') return 'failed'
  return 'stopped'
}

/** バックエンド再起動で失われた情報を明示し、内容不明の承認を促さない案内を返します。 */
function recoveredRunNotice(state: AgentRunState): string {
  if (state === 'waiting_for_approval') {
    return 'バックエンド再起動前の承認内容を復元できません。内容不明のため承認は行わず、必要なら「作業を中断」してください。'
  }
  return 'バックエンド再起動前の文章差分とツール履歴は復元できません。Hermesの現在状態だけを確認しています。'
}

/** 再接続の待機中も中断操作へすぐ反応できるよう、AbortSignal対応の短い待機を作ります。 */
function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      window.clearTimeout(timeoutId)
      resolve()
    }
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** モデル別調整を同じVRMへ再適用できるよう、配信URLからファイル名だけを取り出します。 */
function vrmModelKeyFromUrl(url: string | null): string | null {
  if (!url) return null
  const encodedName = new URL(url, window.location.href).pathname.split('/').at(-1)
  if (!encodedName) return null
  try {
    const decodedName = decodeURIComponent(encodedName)
    return decodedName.includes('/') || decodedName.includes('\\') ? encodedName : decodedName
  } catch {
    return encodedName
  }
}

/** 初期状態を読み込み、利用者の入力から一連の会話処理を進めます。 */
export default function App() {
  const [displayMode, setDisplayMode] = useState(() => readDisplayMode(
    localStorage,
    window.matchMedia('(max-width: 1024px) and (orientation: portrait)').matches,
  ))
  const [conversationTextOpen, setConversationTextOpen] = useState(false)
  const [uiOverrides, setUiOverrides] = useState<UiSettingsOverrides>(() => (
    readUiSettingsOverrides(localStorage)
  ))
  const [serverUiSettings, setServerUiSettings] = useState<UiSettings>(fallbackUiSettings)
  const [uiSettings, setUiSettings] = useState<UiSettings>(() => (
    mergeUiSettings(fallbackUiSettings, uiOverrides)
  ))
  const [health, setHealth] = useState<Health | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [hermesSessionId, setHermesSessionId] = useState<string | null>(() => (
    sessionStorage.getItem(HERMES_SESSION_STORAGE_KEY)
  ))
  const [input, setInput] = useState('')
  const [avatarState, setAvatarState] = useState<AvatarState>('idle')
  const [avatarExpression, setAvatarExpression] = useState<AvatarExpression>('neutral')
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [error, setError] = useState('')
  const [healthError, setHealthError] = useState('')
  const [motionCommand, setMotionCommand] = useState<MotionCommand | null>(null)
  const [motionPlayback, setMotionPlayback] = useState<MotionPlayback>({ state: 'idle', name: null })
  const [localMotionRequest, setLocalMotionRequest] = useState<LocalMotionPreviewRequest | null>(null)
  const [localMotionError, setLocalMotionError] = useState('')
  const [agentRunState, setAgentRunState] = useState<AgentRunState>('idle')
  const [conversationActivityPhase, setConversationActivityPhase] = useState<ConversationActivityPhase | null>(null)
  const [toolTimeline, setToolTimeline] = useState<ToolTimelineItem[]>([])
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequestState | null>(null)
  const [speechStoppedForRun, setSpeechStoppedForRun] = useState(false)
  const [conversationActive, setConversationActive] = useState(false)
  const [recoveryNotice, setRecoveryNotice] = useState('')
  const [sessionResetting, setSessionResetting] = useState(false)
  const [sessionSwitching, setSessionSwitching] = useState(false)
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false)
  const [agentResourcesOpen, setAgentResourcesOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [currentCamera, setCurrentCamera] = useState<UiCameraSettings | null>(null)
  const [backgroundAssets, setBackgroundAssets] = useState<BackgroundAsset[]>([])
  const [backgroundsLoading, setBackgroundsLoading] = useState(false)
  const [backgroundsError, setBackgroundsError] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const activeSessionRef = useRef<ConversationSession | null>(null)
  const sessionIdRef = useRef(0)
  const displayedRunIdRef = useRef<string | null>(null)
  const automaticMotionRef = useRef<string | null>(null)
  const expressionOwnerRef = useRef<string | null>(null)
  const localMotionInputRef = useRef<HTMLInputElement>(null)
  const backgroundsLoadingRef = useRef(false)
  const uiOverridesRef = useRef(uiOverrides)
  const isBusy = conversationActive
  const displayModeActionLabel = displayMode === 'conversation' ? '標準画面へ切り替える' : '会話画面へ切り替える'
  const historyActionLabel = sessionHistoryOpen ? '会話に戻る' : 'セッション履歴'
  const resourcesActionLabel = agentResourcesOpen ? '会話に戻る' : '機能一覧'
  const settingsActionLabel = settingsOpen ? '会話に戻る' : '設定'
  const newSessionActionLabel = sessionResetting ? '新しいセッションを準備中' : '新しいセッション'
  // 応答中は表示だけを閉じ、完了後に利用者が選んだ開閉状態へ戻します。
  const conversationTextVisible = conversationTextOpen && !isBusy
  const activeVrmUrl = health?.vrm_url ?? null
  const activeVrmModelKey = vrmModelKeyFromUrl(activeVrmUrl)
  const configuredMotions = health?.motions ?? []
  const availableMotions = configuredMotions
    .map((motion) => findPlayableMotion(configuredMotions, motion.name))
    .filter((motion): motion is ResponseMotion => motion !== null)
  const generatingMotion = findPlayableMotion(configuredMotions, health?.generating_motion ?? null)
  const missingMotions = configuredMotions.filter((motion) => motion.enabled && !motion.available)
  const localMotionPreviewEnabled = (
    displayMode === 'standard'
    && uiSettings.show_motion_controls
    && activeVrmUrl !== null
  )
  const selectedBackgroundUrl = backgroundAssets.find(
    (background) => background.file === uiSettings.background.file,
  )?.url ?? null

  useEffect(() => {
    if (!localMotionPreviewEnabled) setLocalMotionError('')
  }, [localMotionPreviewEnabled])

  /** 会話処理やマイクを維持したまま表示だけを切り替え、端末固有の選択として保存します。 */
  const changeDisplayMode = () => {
    const next = displayMode === 'standard' ? 'conversation' : 'standard'
    setSessionHistoryOpen(false)
    setAgentResourcesOpen(false)
    setSettingsOpen(false)
    setConversationTextOpen(false)
    setDisplayMode(next)
    saveDisplayMode(localStorage, next)
  }

  /** 一項目の変更を即時反映し、そのブラウザ固有の差分として永続化します。 */
  const changeUiSettings = (changes: UiSettingsOverrides) => {
    setUiSettings((current) => ({ ...current, ...changes }))
    setUiOverrides((current) => {
      const next = { ...current, ...changes }
      uiOverridesRef.current = next
      saveUiSettingsOverrides(localStorage, next)
      return next
    })
    setSettingsMessage('')
    setSettingsError('')
  }

  /** ブラウザ差分だけを消し、共有設定ファイルの現在値へ戻します。 */
  const resetBrowserUiSettings = () => {
    uiOverridesRef.current = {}
    setUiOverrides({})
    saveUiSettingsOverrides(localStorage, {})
    setUiSettings(serverUiSettings)
    setSettingsError('')
    setSettingsMessage('ブラウザ固有の設定を削除し、サーバー既定値へ戻しました。')
  }

  /** 利用者が確認した現在値だけを、明示操作で新しいサーバー既定値へ保存します。 */
  const saveServerUiDefaults = async () => {
    if (settingsSaving) return
    if (!window.confirm('現在のUI設定をサーバー既定値として保存しますか？\n\n新しいブラウザの初期値になります。')) return
    setSettingsSaving(true)
    setSettingsMessage('')
    setSettingsError('')
    try {
      const response = await fetch('/api/ui-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(uiSettings),
      })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, 'UI設定保存APIエラー'))
      const saved = readUiSettings(await response.json())
      if (!saved) throw new Error('保存後のUI設定形式が正しくありません。')
      setServerUiSettings(saved)
      setUiSettings(saved)
      uiOverridesRef.current = {}
      setUiOverrides({})
      saveUiSettingsOverrides(localStorage, {})
      setSettingsMessage('現在値をconfig/ui.jsonへ保存しました。')
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'サーバー既定値を保存できませんでした。')
    } finally {
      setSettingsSaving(false)
    }
  }

  /** 配置後の再起動を不要にするため、ローカル壁紙一覧だけを必要な時点で再取得します。 */
  const loadBackgrounds = async () => {
    if (backgroundsLoadingRef.current) return
    backgroundsLoadingRef.current = true
    setBackgroundsLoading(true)
    setBackgroundsError('')
    try {
      const response = await fetch('/api/backgrounds')
      if (!response.ok) throw new Error(await readApiErrorMessage(response, '壁紙一覧APIエラー'))
      const loaded = readBackgroundAssets(await response.json())
      if (!loaded) throw new Error('壁紙一覧APIの応答形式が正しくありません。')
      setBackgroundAssets(loaded)
    } catch (cause) {
      setBackgroundsError(cause instanceof Error ? cause.message : '壁紙一覧を取得できませんでした。')
    } finally {
      backgroundsLoadingRef.current = false
      setBackgroundsLoading(false)
    }
  }

  /** 通常会話と再接続で同じRun状態・ツール・承認イベント解釈を共有します。 */
  const applyAgentRunEvent = (
    eventName: string,
    data: Record<string, unknown>,
    fallbackRunId: string | null,
  ): AgentRunState | null => {
    const eventRunId = typeof data.run_id === 'string' ? data.run_id : fallbackRunId
    if (eventRunId) advanceActiveRun(eventRunId, data.sequence)

    if (eventName === 'agent.started') {
      setAgentRunState('running')
      setConversationActivityPhase('starting')
    } else if (eventName === 'agent.thinking') {
      setAgentRunState('running')
      setConversationActivityPhase('thinking')
    } else if (eventName === 'assistant.delta') {
      setAgentRunState('running')
      setConversationActivityPhase('composing')
    } else if (eventName === 'tool.started' || eventName === 'tool.completed') {
      setToolTimeline((current) => updateToolTimeline(current, eventName, data))
      setAgentRunState(eventName === 'tool.started' ? 'using_tool' : 'running')
      setConversationActivityPhase(eventName === 'tool.started' ? 'using_tool' : 'reviewing')
    } else if (eventName === 'approval.requested') {
      const request = readApprovalRequest(data, fallbackRunId)
      setAgentRunState('waiting_for_approval')
      setConversationActivityPhase('waiting_for_approval')
      if (request) setApprovalRequest(request)
      else setError('承認要求にRun IDがありません。安全のため回答できません。')
    } else if (eventName === 'approval.responded') {
      setAgentRunState('running')
      setConversationActivityPhase('reviewing')
      const choice = isApprovalChoice(data.choice) ? data.choice : null
      setApprovalRequest((current) => current && current.runId === data.run_id
        ? { ...current, status: 'resolved', resolvedChoice: choice, error: null }
        : current)
    } else if (eventName === 'agent.stopping') {
      setAgentRunState('stopping')
      setConversationActivityPhase('stopping')
    } else if (eventName === 'assistant.completed') {
      setAgentRunState('completed')
      setConversationActivityPhase('completed')
      return 'completed'
    } else if (eventName === 'agent.failed') {
      setAgentRunState('failed')
      setConversationActivityPhase('failed')
      setApprovalRequest(null)
      setError(typeof data.message === 'string' ? data.message : 'Hermes Runに失敗しました。')
      return 'failed'
    } else if (eventName === 'agent.stopped') {
      setAgentRunState('stopped')
      setConversationActivityPhase('stopped')
      setApprovalRequest(null)
      return 'stopped'
    } else if (eventName === 'run.replay_truncated') {
      setRecoveryNotice('古い作業イベントの一部は保存上限を超えたため、現在残っている進捗から表示しています。')
    } else if (eventName === 'run.recovered' || eventName === 'run.status') {
      const recoveredState = readAgentRunState(data.status)
      setAgentRunState(recoveredState)
      setConversationActivityPhase(activityPhaseForRunState(recoveredState))
      if (data.event_history_available === false || data.recovered === true) {
        setApprovalRequest(null)
        setRecoveryNotice(recoveredRunNotice(recoveredState))
      }
    }
    return null
  }

  /** 同じモーションを繰り返し押しても命令として識別できる連番を付けます。 */
  const playMotion = (motion: ResponseMotion) => {
    setMotionCommand((current) => ({
      id: (current?.id ?? 0) + 1,
      action: 'play',
      name: motion.label,
      url: motion.url,
      playback: motion.playback,
      exitDurationSeconds: motion.exitDurationSeconds,
    }))
  }

  /** 再生途中のVRMAも終了遷移を通して待機姿勢へ戻します。 */
  const stopMotion = () => {
    setMotionCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'stop' }))
  }

  /** 登録前のVRMAをサーバーへ送らず、安全な大きさの一時再生要求へ変換します。 */
  const previewLocalMotion = (file: File) => {
    if (!localMotionPreviewEnabled) return
    if (isBusy) {
      setLocalMotionError('会話処理中はローカルVRMAを再生できません。')
      return
    }
    if (!file.name.toLowerCase().endsWith('.vrma')) {
      setLocalMotionError('.vrmaファイルを選んでください。')
      return
    }
    if (file.size === 0 || file.size > MAX_LOCAL_MOTION_FILE_BYTES) {
      setLocalMotionError('VRMAは1バイト以上50MB以下のファイルを選んでください。')
      return
    }

    setLocalMotionError('')
    setLocalMotionRequest((current) => ({ id: (current?.id ?? 0) + 1, file }))
  }

  /** 利用者の一回の操作で生成・合成・再生を止め、即座に次の入力へ戻します。 */
  const stopConversation = () => {
    const session = activeSessionRef.current
    if (!session) return
    setConversationActivityPhase('stopping')

    // 通信切断だけでHermesの作業を残さず、確定結果も発話状態とは別に追跡します。
    if (session.runId) {
      const stoppedRunId = session.runId
      setAgentRunState('stopping')
      setConversationActivityPhase('stopping')
      void stopHermesRun(stoppedRunId)
        .then((state) => {
          if (state === 'stopped' || state === 'completed' || state === 'failed') {
            clearActiveRun(stoppedRunId)
          }
          if (displayedRunIdRef.current === stoppedRunId) {
            setAgentRunState(state)
            setConversationActivityPhase(activityPhaseForRunState(state))
          }
        })
        .catch(() => {
          if (displayedRunIdRef.current === stoppedRunId) {
            setAgentRunState('failed')
            setConversationActivityPhase('failed')
            setError('Hermesの停止状態を確認できませんでした。')
          }
        })
    } else {
      setConversationActivityPhase('stopped')
    }

    // 先に現在セッションを外し、直前の非同期処理が次の会話状態を上書きしないようにします。
    activeSessionRef.current = null
    cancelConversationSession(session)
    setConversationActive(false)
    setAnalyser(null)
    setError('')
    setRecoveryNotice('')
    setApprovalRequest(null)
    setAvatarState('idle')
    setAvatarExpression('neutral')
    expressionOwnerRef.current = null
    automaticMotionRef.current = null
    setMotionCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'stop' }))
  }

  /** Hermesの作業と画面表示を残し、現在の応答の読み上げだけを即座に止めます。 */
  const stopSpeech = () => {
    const session = activeSessionRef.current
    if (!session || session.speechStopped) return

    cancelSessionSpeech(session, '利用者が読み上げを停止しました')
    setSpeechStoppedForRun(true)
    setAnalyser(null)
    setAvatarExpression('neutral')
    expressionOwnerRef.current = null
    automaticMotionRef.current = null
    stopMotion()

    // Hermes完了フラグだけを送信可否の根拠にし、TTSやSSEの後始末とは分離します。
    setAvatarState(session.assistantCompleted ? 'idle' : 'generating')
    setConversationActivityPhase(session.assistantCompleted ? 'completed' : 'composing')

    // Hermes完了イベントが先に届いていた場合は、音声停止と同時に次の入力を許可します。
    if (session.assistantCompleted && activeSessionRef.current?.id === session.id) {
      activeSessionRef.current = null
      setConversationActive(false)
    }
  }

  /** 検証済みの正式履歴とIDを一括反映し、セッション切り替え後の画面状態を初期化します。 */
  const activateSession = (sessionId: string, formalMessages: Message[]) => {
    clearActiveRun()
    sessionStorage.setItem(HERMES_SESSION_STORAGE_KEY, sessionId)
    setHermesSessionId(sessionId)
    setMessages(formalMessages)
    setInput('')
    setToolTimeline([])
    setApprovalRequest(null)
    setAgentRunState('idle')
    setConversationActivityPhase(null)
    setSpeechStoppedForRun(false)
    setConversationActive(false)
    setAvatarState('idle')
    setAvatarExpression('neutral')
    expressionOwnerRef.current = null
    setAnalyser(null)
    setError('')
    setRecoveryNotice('')
    activeSessionRef.current = null
    displayedRunIdRef.current = null
    automaticMotionRef.current = null
    setMotionCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'stop' }))
    setSessionHistoryOpen(false)
  }

  /** 現在のHermes履歴を終了済みにしてから、ブラウザを空の新規会話へ切り替えます。 */
  const startNewSession = async () => {
    const sessionId = hermesSessionId
    if (!sessionId || isBusy || sessionResetting || sessionSwitching) return
    if (!window.confirm('現在の会話を終了して、新しいセッションを始めますか？\n\n会話履歴はHermes側に保存されます。')) return

    setSessionResetting(true)
    setError('')
    try {
      const response = await fetch(`/api/hermes/sessions/${sessionId}/end`, { method: 'POST' })
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, 'セッション終了APIエラー'))
      }

      // 上流の終了を確認してから保存IDと表示を同時に外し、履歴が混ざる状態を作りません。
      sessionStorage.removeItem(HERMES_SESSION_STORAGE_KEY)
      clearActiveRun()
      setHermesSessionId(null)
      setMessages([])
      setInput('')
      setToolTimeline([])
      setApprovalRequest(null)
      setAgentRunState('idle')
      setConversationActivityPhase(null)
      setSpeechStoppedForRun(false)
      setAvatarState('idle')
      setAvatarExpression('neutral')
      expressionOwnerRef.current = null
      setAnalyser(null)
      setRecoveryNotice('')
      displayedRunIdRef.current = null
      automaticMotionRef.current = null
      setMotionCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'stop' }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新しいセッションへ切り替えられませんでした。')
    } finally {
      setSessionResetting(false)
    }
  }

  /** 未終了状態と正式履歴を再確認してから、現在のブラウザを選択セッションへ接続します。 */
  const openExistingSession = async (sessionId: string): Promise<boolean> => {
    if (isBusy || sessionResetting || sessionSwitching || sessionId === hermesSessionId) return false
    if (input.trim() && !window.confirm('入力途中の文章を破棄して、選択したセッションを開きますか？')) {
      return false
    }

    setSessionSwitching(true)
    try {
      // 一覧表示後に別操作で終了していないか、切り替え直前の正本で再確認します。
      const sessionResponse = await fetch(`/api/hermes/sessions/${sessionId}`)
      if (!sessionResponse.ok) {
        throw new Error(await readApiErrorMessage(sessionResponse, 'セッション取得APIエラー'))
      }
      const sessionData = await sessionResponse.json() as Record<string, unknown>
      const rawSession = sessionData.session
      if (!rawSession || typeof rawSession !== 'object' || !('ended_at' in rawSession)) {
        throw new Error('セッション状態の応答形式が正しくありません。')
      }
      const session = readSessionSummary(rawSession)
      if (!session || session.id !== sessionId) {
        throw new Error('セッション情報の応答形式が正しくありません。')
      }
      if (session.endedAt !== null) {
        throw new Error('このセッションは既に終了しています。履歴の閲覧だけが可能です。')
      }

      const messagesResponse = await fetch(`/api/hermes/sessions/${sessionId}/messages`)
      if (!messagesResponse.ok) {
        throw new Error(await readApiErrorMessage(messagesResponse, 'セッション履歴APIエラー'))
      }
      const messagesData = await messagesResponse.json() as Record<string, unknown>
      if (!Array.isArray(messagesData.data)) {
        throw new Error('セッション履歴の応答形式が正しくありません。')
      }

      // 履歴取得まで成功した時点でまとめて切り替え、旧会話と新会話の表示混在を防ぎます。
      activateSession(sessionId, readSessionMessages(messagesData.data))
      return true
    } finally {
      setSessionSwitching(false)
    }
  }

  /** 終了済み履歴をHermesで分岐し、元を保存したまま新しい子セッションへ切り替えます。 */
  const continueEndedSession = async (sourceSessionId: string): Promise<boolean> => {
    if (isBusy || sessionResetting || sessionSwitching) return false
    const draftNotice = input.trim() ? '\n\n入力途中の文章は破棄されます。' : ''
    if (!window.confirm(`終了済みの会話を残したまま、その続きとなる新しいセッションを作成しますか？${draftNotice}`)) {
      return false
    }

    setSessionSwitching(true)
    try {
      const forkResponse = await fetch(`/api/hermes/sessions/${sourceSessionId}/fork`, { method: 'POST' })
      if (!forkResponse.ok) {
        throw new Error(await readApiErrorMessage(forkResponse, 'セッション分岐APIエラー'))
      }
      const forkData = await forkResponse.json() as Record<string, unknown>
      const rawFork = forkData.session
      if (!rawFork || typeof rawFork !== 'object' || !('ended_at' in rawFork)) {
        throw new Error('分岐セッションの応答形式が正しくありません。')
      }
      const fork = readSessionSummary(rawFork)
      if (
        !fork
        || fork.id === sourceSessionId
        || fork.parentSessionId !== sourceSessionId
        || fork.endedAt !== null
      ) {
        throw new Error('分岐セッションの親子関係または状態が正しくありません。')
      }

      const messagesResponse = await fetch(`/api/hermes/sessions/${fork.id}/messages`)
      if (!messagesResponse.ok) {
        throw new Error(await readApiErrorMessage(messagesResponse, '分岐セッション履歴APIエラー'))
      }
      const messagesData = await messagesResponse.json() as Record<string, unknown>
      if (!Array.isArray(messagesData.data)) {
        throw new Error('分岐セッション履歴の応答形式が正しくありません。')
      }

      activateSession(fork.id, readSessionMessages(messagesData.data))
      return true
    } finally {
      setSessionSwitching(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()

    /** 設定ファイルを正本として取得し、保存済みのブラウザ差分だけを後から重ねます。 */
    const loadUiDefaults = async () => {
      try {
        const response = await fetch('/api/ui-settings', { signal: controller.signal })
        if (!response.ok) throw new Error(await readApiErrorMessage(response, 'UI設定取得APIエラー'))
        const loaded = readUiSettings(await response.json())
        if (!loaded) throw new Error('UI設定APIの応答形式が正しくありません。')
        setServerUiSettings(loaded)
        setUiSettings(mergeUiSettings(loaded, uiOverridesRef.current))
      } catch (cause) {
        if (isAbortError(cause)) return
        setSettingsError(cause instanceof Error ? cause.message : 'UI設定を取得できませんでした。')
      }
    }

    void loadUiDefaults()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    void loadBackgrounds()
    // 初回だけ取得し、追加配置後は設定画面の再読込ボタンから明示更新します。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    fetch('/api/health')
      .then((response) => {
        if (!response.ok) throw new Error(`接続確認APIエラー: ${response.status}`)
        return response.json()
      })
      .then((data: Health) => setHealth(data))
      .catch(() => setHealthError('バックエンドへ接続できません。FastAPIを起動してから再読み込みしてください。'))
  }, [])

  useEffect(() => {
    if (!hermesSessionId) return
    const controller = new AbortController()

    // 再読み込み後はブラウザの古い表示ではなく、Hermes SessionDBの正式履歴を復元します。
    fetch(`/api/hermes/sessions/${hermesSessionId}/messages`, { signal: controller.signal })
      .then((response) => {
        if (response.status === 404) {
          sessionStorage.removeItem(HERMES_SESSION_STORAGE_KEY)
          clearActiveRun()
          setHermesSessionId(null)
          return null
        }
        if (!response.ok) throw new Error(`セッション履歴APIエラー: ${response.status}`)
        return response.json()
      })
      .then((data) => {
        if (data) setMessages(readSessionMessages(data.data))
      })
      .catch((cause) => {
        if (!isAbortError(cause)) setError('Hermesのセッション履歴を取得できませんでした。')
      })

    return () => controller.abort()
  }, [])

  useEffect(() => {
    const storedRun = readActiveRun()
    if (!storedRun) return
    if (storedRun.sessionId !== sessionStorage.getItem(HERMES_SESSION_STORAGE_KEY)) {
      clearActiveRun(storedRun.runId)
      return
    }

    const controller = new AbortController()
    const recoverySession: ConversationSession = {
      id: ++sessionIdRef.current,
      runId: storedRun.runId,
      speechSequenceId: null,
      controller,
      speechController: new AbortController(),
      cancelled: false,
      // 再接続前のWAVは再取得せず、テキストと作業状態だけを復元します。
      speechStopped: true,
      assistantCompleted: false,
      activeSource: null,
      pendingSpeech: new Map(),
    }
    activeSessionRef.current = recoverySession
    displayedRunIdRef.current = storedRun.runId
    setConversationActive(true)
    setSpeechStoppedForRun(true)
    setAvatarState('generating')
    setConversationActivityPhase('starting')
    setAvatarExpression('neutral')
    expressionOwnerRef.current = null
    setToolTimeline([])
    setApprovalRequest(null)
    setError('')
    setRecoveryNotice('実行中だったHermesの作業へ再接続しています…')

    /** StrictModeの再実行や利用者の中断後に、古い復元処理が画面を上書きしないよう確認します。 */
    const isCurrentRecovery = () => (
      !controller.signal.aborted
      && !recoverySession.cancelled
      && activeSessionRef.current?.id === recoverySession.id
    )

    /** Run終端後は、途中イベントではなくHermes SessionDBの正式履歴へ表示を合わせます。 */
    const syncFormalHistory = async () => {
      const response = await fetch(
        `/api/hermes/sessions/${encodeURIComponent(storedRun.sessionId)}/messages`,
        { signal: controller.signal },
      )
      if (!response.ok) throw new Error(`セッション履歴APIエラー: ${response.status}`)
      const data = await response.json() as Record<string, unknown>
      if (!Array.isArray(data.data)) throw new Error('セッション履歴の応答形式が正しくありません。')
      if (isCurrentRecovery()) setMessages(readSessionMessages(data.data))
    }

    /** 保存済みRunが失われた場合も送信欄を塞がず、取得可能な正式履歴へ戻します。 */
    const releaseLostRun = async (
      notice = 'HermesからRun状態を取得できないため、取得可能な正式会話履歴へ戻りました。',
    ) => {
      clearActiveRun(storedRun.runId)
      try {
        await syncFormalHistory()
      } catch (cause) {
        if (!isAbortError(cause) && isCurrentRecovery()) {
          setError('Hermesのセッション履歴を取得できませんでした。')
        }
      }
      if (!isCurrentRecovery()) return
      activeSessionRef.current = null
      setConversationActive(false)
      setSpeechStoppedForRun(false)
      setAgentRunState('idle')
      setConversationActivityPhase(null)
      setAvatarState('idle')
      setRecoveryNotice(notice)
    }

    /** 保存済みイベントを再構成してから、同じ接続で新しいイベントへ追従します。 */
    const reconnect = async () => {
      // 再読み込みで画面上のタイムラインは失われるため、初回だけは先頭から安全化済みイベントを再生します。
      let after = 0
      let terminalState: AgentRunState | null = null
      let connectedOnce = false
      let limitedRecovery = false

      while (isCurrentRecovery() && terminalState === null) {
        try {
          const statusResponse = await fetch(`/api/hermes/runs/${storedRun.runId}`, {
            signal: controller.signal,
          })
          if (statusResponse.status === 404) {
            await releaseLostRun()
            return
          }
          if (!statusResponse.ok) {
            throw new Error(`Hermes Run状態APIエラー: ${statusResponse.status}`)
          }
          const statusData = await statusResponse.json() as Record<string, unknown>
          if (statusData.run_id !== storedRun.runId || statusData.session_id !== storedRun.sessionId) {
            await releaseLostRun('保存済みRunとHermesの実行状態が一致しないため、正式な会話履歴へ戻りました。')
            return
          }

          const reportedState = readAgentRunState(statusData.status)
          setAgentRunState(reportedState)
          limitedRecovery = statusData.recovered === true && statusData.event_history_available === false
          if (limitedRecovery) {
            setApprovalRequest(null)
            setRecoveryNotice(recoveredRunNotice(reportedState))
          }
          const reportedTerminalState = (
            reportedState === 'completed' || reportedState === 'failed' || reportedState === 'stopped'
          ) ? reportedState : null

          const eventsResponse = await fetch(
            `/api/hermes/runs/${storedRun.runId}/events?after=${after}`,
            { signal: controller.signal },
          )
          if (eventsResponse.status === 404) {
            await releaseLostRun()
            return
          }
          if (!eventsResponse.ok) {
            throw new Error(`Hermes RunイベントAPIエラー: ${eventsResponse.status}`)
          }
          if (!connectedOnce && !limitedRecovery) {
            connectedOnce = true
            setRecoveryNotice('実行中の作業へ再接続しました。再読み込み前の音声は再生しません。')
          }

          await consumeSse(eventsResponse, ({ event: eventName, data }) => {
            if (!isCurrentRecovery()) return
            if (typeof data.sequence === 'number' && Number.isInteger(data.sequence)) {
              after = Math.max(after, data.sequence)
            }
            const eventState = applyAgentRunEvent(eventName, data, storedRun.runId)
            if (eventState === 'completed' || eventState === 'failed' || eventState === 'stopped') {
              terminalState = eventState
            }
          })
          // 終端イベントが保存上限で欠けても、状態APIの確定値を正本として復帰させます。
          if (terminalState === null && reportedTerminalState !== null) {
            terminalState = reportedTerminalState
          }
        } catch (cause) {
          if (!isCurrentRecovery() || isAbortError(cause)) return
          setRecoveryNotice('Hermesの作業へ再接続できません。数秒後に再試行します…')
          await waitForReconnect(2000, controller.signal)
        }
      }

      if (!isCurrentRecovery() || terminalState === null) return
      recoverySession.assistantCompleted = terminalState === 'completed'
      clearActiveRun(storedRun.runId)
      try {
        await syncFormalHistory()
      } catch (cause) {
        if (!isAbortError(cause) && isCurrentRecovery()) {
          setError('作業は終了しましたが、Hermesの正式履歴を取得できませんでした。')
        }
      }
      if (!isCurrentRecovery()) return
      activeSessionRef.current = null
      setConversationActive(false)
      setSpeechStoppedForRun(false)
      setAvatarState(terminalState === 'failed' ? 'error' : 'idle')
      automaticMotionRef.current = null
      setMotionCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'stop' }))
      setRecoveryNotice(
        terminalState === 'completed'
          ? '再接続したHermesの作業が完了しました。'
          : terminalState === 'stopped'
            ? '再接続したHermesの作業は停止しました。'
            : '',
      )
    }

    void reconnect()
    return () => {
      controller.abort()
      recoverySession.cancelled = true
      if (activeSessionRef.current?.id === recoverySession.id) activeSessionRef.current = null
    }
  }, [])

  useEffect(() => () => {
    // ページを閉じた後も会話通信と音声再生を残さないために解放します。
    if (activeSessionRef.current) cancelConversationSession(activeSessionRef.current)
    activeSessionRef.current = null
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, toolTimeline, approvalRequest?.id, approvalRequest?.status, recoveryNotice, error])

  useLayoutEffect(() => {
    // 会話モードや別パネルから標準画面へ戻った際、再生成された会話欄を末尾から表示します。
    if (displayMode !== 'standard' || sessionHistoryOpen || agentResourcesOpen || settingsOpen) return
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [displayMode, sessionHistoryOpen, agentResourcesOpen, settingsOpen])

  useEffect(() => {
    // 発話中は各音声タスクがモーションを所有するため、この状態連動処理では上書きしません。
    if (avatarState === 'speaking') return
    const desiredMotion = avatarState === 'generating' ? generatingMotion : null
    const desiredKey = desiredMotion?.url ?? null

    // 会話フェーズが要求するモーションが変わったときだけ命令し、手動確認とは独立させます。
    if (desiredMotion && automaticMotionRef.current !== desiredKey) {
      automaticMotionRef.current = desiredKey
      setMotionCommand((current) => ({
        id: (current?.id ?? 0) + 1,
        action: 'play',
        name: desiredMotion.label,
        url: desiredMotion.url,
        playback: desiredMotion.playback,
        exitDurationSeconds: desiredMotion.exitDurationSeconds,
      }))
    } else if (!desiredMotion && automaticMotionRef.current) {
      automaticMotionRef.current = null
      setMotionCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'stop' }))
    }
  }, [avatarState, generatingMotion?.label, generatingMotion?.url])

  /** 現在表示中の承認だけへ回答し、期限切れや上流エラーをパネル内へ戻します。 */
  const respondToApproval = async (choice: ApprovalChoice): Promise<void> => {
    const request = approvalRequest
    if (!request || request.status !== 'pending' || !request.choices.includes(choice)) return

    setApprovalRequest((current) => current?.id === request.id
      ? { ...current, status: 'submitting', error: null }
      : current)
    try {
      const response = await fetch(`/api/hermes/runs/${request.runId}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      })
      let responseData: Record<string, unknown> = {}
      try {
        responseData = await response.json() as Record<string, unknown>
      } catch {
        // 成功応答の形式検査または失敗時の状態コード表示を、同じ後続処理で行います。
      }
      if (!response.ok) {
        let message = `承認APIエラー: ${response.status}`
        if (typeof responseData.detail === 'string') message = responseData.detail
        throw new Error(message)
      }

      setApprovalRequest((current) => current?.id === request.id
        ? { ...current, status: 'resolved', resolvedChoice: choice, error: null }
        : current)
      // 直後に次の承認が発生した場合は、HTTP応答に含まれる最新Run状態を優先します。
      const nextState = readAgentRunState(responseData.status)
      setAgentRunState(nextState)
      setConversationActivityPhase(activityPhaseForRunState(nextState))
    } catch (cause) {
      setApprovalRequest((current) => current?.id === request.id
        ? {
            ...current,
            status: 'pending',
            error: cause instanceof Error ? cause.message : '承認回答を送信できませんでした。',
          }
        : current)
    }
  }

  /** 遅延処理を挟んでも音声を開始できるよう、直接操作中にAudioContextを有効化します。 */
  const activateAudioContext = (): AudioContext => {
    const audioContext = audioContextRef.current ?? new AudioContext()
    audioContextRef.current = audioContext
    void audioContext.resume()
    return audioContext
  }

  /** 通常入力とふれあい入力を同じHermes Run、TTS、VRMA処理へ接続します。 */
  const startConversation = async (
    rawText: string,
    displayedUserText: string,
    clearComposer: boolean,
  ) => {
    const text = rawText.trim()
    if (!text || isBusy || activeSessionRef.current) return

    // 通常送信ではこの場で、ふれあいでは先行タップ時に同じContextを有効化済みです。
    const audioContext = activateAudioContext()

    const session: ConversationSession = {
      id: ++sessionIdRef.current,
      runId: null,
      speechSequenceId: null,
      controller: new AbortController(),
      speechController: new AbortController(),
      cancelled: false,
      speechStopped: false,
      assistantCompleted: false,
      activeSource: null,
      pendingSpeech: new Map(),
    }
    activeSessionRef.current = session
    setConversationActive(true)

    /** 中断済みや後続の会話に入れ替わった処理から、画面状態を変更させません。 */
    const isCurrentSession = () => (
      !session.cancelled && activeSessionRef.current?.id === session.id
    )

    /** 古いSSEの後始末を残しつつ、この会話だけを送信受付の占有状態から外します。 */
    const releaseCurrentSession = () => {
      if (activeSessionRef.current?.id !== session.id) return
      activeSessionRef.current = null
      setConversationActive(false)
    }

    const history: Message[] = [...messages, { role: 'user', content: displayedUserText }]
    setMessages([...history, { role: 'assistant', content: '' }])
    if (clearComposer) setInput('')
    setError('')
    setAvatarState('generating')
    setAvatarExpression('neutral')
    expressionOwnerRef.current = null
    setAgentRunState('starting')
    setConversationActivityPhase('starting')
    setToolTimeline([])
    setApprovalRequest(null)
    setSpeechStoppedForRun(false)
    setRecoveryNotice('')
    displayedRunIdRef.current = null

    let speechFailed = false
    let playbackTail = Promise.resolve()
    let activeHermesSessionId = hermesSessionId
    let keepRunForReload = false

    /** WAVの準備は即開始し、実再生だけを直前の文へ連結して順序を保ちます。 */
    const enqueueSpeech = (data: Record<string, unknown>) => {
      const audioUrl = typeof data.audio_url === 'string' ? data.audio_url : ''
      const utteranceId = typeof data.utterance_id === 'string' ? data.utterance_id : ''
      if (!audioUrl || !utteranceId) {
        speechFailed = true
        setError('音声チャンクの情報が不足しています。テキスト応答は利用できます。')
        return
      }

      const request: SpeechRequest = {
        audioUrl,
        utteranceId,
        sequenceId: typeof data.sequence_id === 'string' ? data.sequence_id : null,
        segmentIndex: typeof data.segment_index === 'number' ? data.segment_index : null,
        motion: readSpeechMotion(data, configuredMotions),
        expression: readSpeechExpression(data),
      }
      if (session.speechStopped) {
        void notifySpeech('speech.cancelled', request, { reason: '利用者が読み上げを停止しました' })
        return
      }
      if (!isCurrentSession()) {
        void notifySpeech('speech.cancelled', request, { reason: '利用者が会話を中断しました' })
        return
      }

      session.pendingSpeech.set(request.utteranceId, request)
      const prepared = prepareSpeech(request, audioContext, session.speechController.signal)
      playbackTail = playbackTail.then(async () => {
        if (!isCurrentSession() || session.speechStopped) return
        try {
          const result = await playPreparedSpeech(
            prepared,
            request,
            audioContext,
            session,
            uiSettings.speech_volume,
            (value) => {
              if (isCurrentSession()) setAnalyser(value)
            },
            () => {
              if (!isCurrentSession()) return
              // 合成完了時ではなく実際の再生開始時に、その発話タスク固有のVRMAへ切り替えます。
              setAvatarState('speaking')
              setConversationActivityPhase('speaking')
              expressionOwnerRef.current = request.utteranceId
              setAvatarExpression(request.expression)
              automaticMotionRef.current = request.motion?.url ?? null
              setMotionCommand((current) => request.motion
                ? {
                    id: (current?.id ?? 0) + 1,
                    action: 'play',
                    name: request.motion.label,
                    url: request.motion.url,
                    playback: request.motion.playback,
                    exitDurationSeconds: request.motion.exitDurationSeconds,
                  }
                : { id: (current?.id ?? 0) + 1, action: 'stop' })
            },
            () => {
              session.pendingSpeech.delete(request.utteranceId)
              if (isCurrentSession() && expressionOwnerRef.current === request.utteranceId) {
                expressionOwnerRef.current = null
                setAvatarExpression('neutral')
              }
            },
          )
          if (result.status !== 'failed' || !isCurrentSession()) return
          speechFailed = true
          setError(`${result.error} テキスト応答は利用できます。`)
        } catch (cause) {
          // Web Audioの初期化例外でもキュー全体をrejectさせず、次文と画面復帰を継続します。
          session.pendingSpeech.delete(request.utteranceId)
          if (!isCurrentSession()) return
          const reason = cause instanceof Error ? cause.message : '音声を再生できませんでした。'
          speechFailed = true
          void notifySpeech('speech.failed', request, { reason })
          setError(`${reason} テキスト応答は利用できます。`)
        }
      })
    }

    try {
      const response = await fetch('/api/hermes/conversation/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 正式履歴はHermes SessionDBからバックエンドが取得するため、今回の入力だけを送ります。
        body: JSON.stringify({
          input: text,
          session_id: hermesSessionId ?? undefined,
        }),
        signal: session.controller.signal,
      })
      await consumeSse(response, async ({ event: eventName, data }) => {
        if (!isCurrentSession()) return
        if (eventName === 'session.ready' && typeof data.session_id === 'string') {
          activeHermesSessionId = data.session_id
          setHermesSessionId(data.session_id)
          sessionStorage.setItem(HERMES_SESSION_STORAGE_KEY, data.session_id)
        } else if (eventName === 'run.started' && typeof data.run_id === 'string') {
          session.runId = data.run_id
          displayedRunIdRef.current = data.run_id
          const runSessionId = typeof data.session_id === 'string'
            ? data.session_id
            : activeHermesSessionId
          if (runSessionId) {
            saveActiveRun({ sessionId: runSessionId, runId: data.run_id, lastSequence: 0 })
          }
        }

        const eventState = applyAgentRunEvent(eventName, data, session.runId)
        if (eventName === 'assistant.completed') {
          session.assistantCompleted = true
          // Runは既に終端なので、正式履歴通知を待つ短い間に再読み込みしても再接続対象にはしません。
          if (session.runId) clearActiveRun(session.runId)
          // 読み上げを止めた応答は、Hermes完了時点で後処理を待たず送信欄を解放します。
          if (session.speechStopped) {
            setAvatarState('idle')
            releaseCurrentSession()
          }
        } else if (eventName === 'session.messages') {
          setMessages(readSessionMessages(data.data))
          if (session.runId) clearActiveRun(session.runId)
        } else if (eventName === 'text.delta') {
          setConversationActivityPhase('composing')
          setMessages((current) => current.map((message, index) =>
            index === current.length - 1 ? { ...message, content: message.content + String(data.delta ?? '') } : message,
          ))
        } else if (eventName === 'status' && data.state === 'synthesizing') {
          // 先行再生が始まっていれば、遅れて届いた合成状態でモーションを戻しません。
          if (!session.speechStopped) {
            setAvatarState((current) => current === 'speaking' ? current : 'synthesizing')
            setConversationActivityPhase((current) => current === 'speaking' ? current : 'synthesizing')
          }
        } else if (eventName === 'speech.sequence.started' && typeof data.sequence_id === 'string') {
          session.speechSequenceId = data.sequence_id
          // 合成開始前に停止された場合も、IDが判明した時点でバックエンドのキューを中断します。
          if (session.speechStopped) void cancelSpeechSequence(data.sequence_id)
        } else if (eventName === 'speech.requested') {
          enqueueSpeech(data)
        } else if (eventName === 'speech.failed') {
          // 手動停止後に完了した合成は意図した破棄なので、音声エラーとして表示しません。
          if (!session.speechStopped) {
            speechFailed = true
            setError(String(data.reason ?? '音声を生成できませんでした。テキスト応答は利用できます。'))
          }
        } else if (eventName === 'error') {
          setAgentRunState('failed')
          setConversationActivityPhase('failed')
          setApprovalRequest(null)
          if (session.runId) clearActiveRun(session.runId)
          throw new Error(String(data.message ?? '会話に失敗しました'))
        }

        if (eventState === 'failed' || eventState === 'stopped') {
          if (session.runId) clearActiveRun(session.runId)
        }
      })
      // doneは全WAVの通知完了を表すため、実際の再生キューが空になるまで発話状態を維持します。
      await playbackTail
      if (isCurrentSession()) {
        setAvatarState(speechFailed ? 'error' : 'idle')
        setConversationActivityPhase(speechFailed ? 'failed' : 'completed')
        setAvatarExpression('neutral')
        expressionOwnerRef.current = null
      }
    } catch (cause) {
      // 利用者の中断は意図した終了なので、再生待ちやエラー表示を待たずに戻します。
      if (session.cancelled || isAbortError(cause)) return
      await playbackTail
      if (!isCurrentSession()) return
      // HTTP検証失敗など本文受信前の障害では、先行表示した空の応答欄だけを取り除きます。
      setMessages((current) => {
        const last = current[current.length - 1]
        return last?.role === 'assistant' && !last.content.trim() ? current.slice(0, -1) : current
      })
      setError(cause instanceof Error ? cause.message : '会話に失敗しました')
      if (session.runId && readActiveRun()?.runId === session.runId) {
        // Runの終端を確認できない通信障害では二重送信を防ぎ、再読み込みまたは明示停止を待ちます。
        keepRunForReload = true
        setRecoveryNotice('Hermesの作業が続いている可能性があります。ページを再読み込みすると再接続します。')
      }
      setAvatarState('error')
      setConversationActivityPhase('failed')
    } finally {
      if (!keepRunForReload) releaseCurrentSession()
    }
  }

  /** フォーム入力だけを消し、ふれあい時に残した下書きへ影響させません。 */
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void startConversation(input, input.trim(), true)
  }

  /** 改行を残しつつキーボードだけで送信できるよう、修飾キー付きEnterをフォーム送信へ渡します。 */
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter'
      || (!event.ctrlKey && !event.metaKey)
      || event.nativeEvent.isComposing
      || !input.trim()
      || isBusy
    ) return

    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  /** 接触は会話処理中にキューへ積まず、独立した一回の利用者イベントとして送ります。 */
  const handleVrmTouch = (input: VrmTouchInput) => {
    if (isBusy || activeSessionRef.current) return
    void startConversation(touchInputText(input), touchDisplayText(input), false)
  }

  /** ギズモで確定した差分を現在モデルだけへ保存し、空なら不要なプロファイルを除きます。 */
  const handleTouchHitboxProfileChange = (modelKey: string, profile: UiTouchHitboxProfile) => {
    const profiles = { ...uiSettings.touch_interaction.hitbox_profiles }
    if (Object.keys(profile).length > 0) profiles[modelKey] = profile
    else delete profiles[modelKey]
    changeUiSettings({
      touch_interaction: {
        ...uiSettings.touch_interaction,
        hitbox_profiles: profiles,
      },
    })
  }

  return (
    <main className={`app-shell ${displayMode === 'conversation' ? 'conversation-mode' : 'standard-mode'}`}>
      <section className="avatar-panel">
        <header className="brand">
          <div className="brand-info">
            <span className="eyebrow">AVATAR GATEWAY</span>
            <span className="brand-runtime">
              {health ? `${health.model} · ${health.tts_enabled ? 'Style-Bert-VITS2' : '音声OFF'}` : '接続確認中…'}
            </span>
          </div>
          <span className={`status status-${avatarState}`}>
            {avatarState === 'generating' && (
              <span className="thinking-animation" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            )}
            {stateLabels[avatarState]}
          </span>
        </header>
        <VrmStage
          vrmUrl={activeVrmUrl}
          vrmModelKey={activeVrmModelKey}
          avatarState={avatarState}
          avatarExpression={avatarExpression}
          analyser={analyser}
          motionCommand={motionCommand}
          showCameraHelp={displayMode === 'standard' && uiSettings.show_camera_help}
          cameraSettings={uiSettings.camera}
          framingMode={displayMode}
          backgroundUrl={selectedBackgroundUrl}
          backgroundFit={uiSettings.background.fit}
          castOffEnabled={uiSettings.cast_off_enabled}
          touchInteraction={uiSettings.touch_interaction}
          touchBlocked={isBusy}
          localMotionPreviewEnabled={localMotionPreviewEnabled}
          localMotionPreviewBlocked={isBusy}
          localMotionRequest={localMotionRequest}
          onMotionStatus={setMotionPlayback}
          onLocalMotionFile={previewLocalMotion}
          onLocalMotionRequestConsumed={(id) => setLocalMotionRequest((current) => (
            current?.id === id ? null : current
          ))}
          onCameraChange={setCurrentCamera}
          onTouchHitboxProfileChange={handleTouchHitboxProfileChange}
          onVrmTouchDetected={activateAudioContext}
          onVrmTouch={handleVrmTouch}
        />
        {localMotionPreviewEnabled && (
          <div className="motion-controls" aria-label="VRMA動作確認">
            {/* 状態の文字数が変わっても一覧を動かさないため、状態と停止操作を固定幅の左列にまとめます。 */}
            <div className="motion-controls-side">
              <span
                className="motion-controls-status"
                title={motionPlayback.state === 'idle' ? 'モーション待機' : `${motionPlayback.name ?? 'モーション'}: ${motionPlayback.state}`}
              >
                {motionPlayback.state === 'idle' ? 'モーション待機' : `${motionPlayback.name ?? 'モーション'}: ${motionPlayback.state}`}
              </span>
              <button
                className="motion-controls-stop"
                type="button"
                onClick={stopMotion}
                disabled={motionPlayback.state === 'idle'}
              >
                停止
              </button>
              <input
                ref={localMotionInputRef}
                type="file"
                accept=".vrma"
                hidden
                disabled={isBusy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  if (file) previewLocalMotion(file)
                  event.currentTarget.value = ''
                }}
              />
              <button
                className="motion-local-preview-button"
                type="button"
                disabled={isBusy}
                onClick={() => localMotionInputRef.current?.click()}
              >
                <span>VRMAを試す</span>
                <small>登録されません</small>
              </button>
            </div>
            {/* 一覧を3行ずつ縦に詰め、選択中のボタンは再クリックで停止できるようにします。 */}
            <div className="motion-controls-scroll" aria-label="モーション一覧" tabIndex={0}>
              {availableMotions.map((motion) => {
                const isCurrentMotion = motionPlayback.name === motion.label && (
                  motionPlayback.state === 'loading'
                  || motionPlayback.state === 'playing'
                  || motionPlayback.state === 'stopping'
                )
                return (
                  <button
                    type="button"
                    key={motion.name}
                    className={isCurrentMotion ? 'active' : undefined}
                    aria-pressed={isCurrentMotion}
                    disabled={isCurrentMotion && motionPlayback.state === 'stopping'}
                    onClick={() => isCurrentMotion ? stopMotion() : playMotion(motion)}
                  >
                    {motion.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {(localMotionError || motionPlayback.state === 'error') && (
          <p className="motion-error">{localMotionError || (motionPlayback.state === 'error' ? motionPlayback.message : '')}</p>
        )}
        {healthError && <p className="notice">{healthError}</p>}
        {health && !health.vrm_available && <p className="notice">VRMが見つかりません。同梱・ローカルのVRMとAVATAR_VRM_FILEを確認してください。</p>}
        {health?.motion_catalog_error && <p className="notice">モーション設定エラー: {health.motion_catalog_error}</p>}
        {missingMotions.length > 0 && <p className="notice">VRMAが見つかりません: {missingMotions.map((motion) => motion.file).join('、')}</p>}
      </section>

      <section className="chat-panel">
        <div className="connection">
          <div className="session-actions">
            <button
              type="button"
              className="display-mode-button"
              onClick={changeDisplayMode}
              aria-label={displayModeActionLabel}
              title={displayModeActionLabel}
            >
              <SessionActionIcon name={displayMode === 'conversation' ? 'standard' : 'conversation'} />
            </button>
            <button
              type="button"
              className="session-history-button"
              onClick={() => {
                setAgentResourcesOpen(false)
                setSettingsOpen(false)
                setSessionHistoryOpen((current) => !current)
              }}
              disabled={isBusy || sessionResetting || sessionSwitching}
              aria-expanded={sessionHistoryOpen}
              aria-label={historyActionLabel}
              title={historyActionLabel}
            >
              <SessionActionIcon name="history" />
            </button>
            <button
              type="button"
              className="agent-resources-button"
              onClick={() => {
                setSessionHistoryOpen(false)
                setSettingsOpen(false)
                setAgentResourcesOpen((current) => !current)
              }}
              disabled={isBusy || sessionResetting || sessionSwitching}
              aria-expanded={agentResourcesOpen}
              aria-label={resourcesActionLabel}
              title={resourcesActionLabel}
            >
              <SessionActionIcon name="features" />
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => {
                setSessionHistoryOpen(false)
                setAgentResourcesOpen(false)
                setSettingsOpen((current) => !current)
              }}
              disabled={isBusy || sessionResetting || sessionSwitching}
              aria-expanded={settingsOpen}
              aria-label={settingsActionLabel}
              title={settingsActionLabel}
            >
              <SessionActionIcon name="settings" />
            </button>
            <button
              type="button"
              className="new-session-button"
              onClick={() => void startNewSession()}
              disabled={!hermesSessionId || isBusy || sessionResetting || sessionSwitching || sessionHistoryOpen || agentResourcesOpen || settingsOpen}
              aria-label={newSessionActionLabel}
              title={newSessionActionLabel}
            >
              <SessionActionIcon name="new-session" />
            </button>
          </div>
        </div>
        {displayMode === 'conversation' ? (
          <div className="conversation-mode-content">
            <ConversationActivityOverlay phase={conversationActivityPhase} tools={toolTimeline} />
            <ConversationModeOverlay messages={messages} avatarState={avatarState} />
            {recoveryNotice && <p className="recovery-message" role="status">{recoveryNotice}</p>}
            <ApprovalPanel request={approvalRequest} onRespond={respondToApproval} />
            {error && <p className="error-message">{error}</p>}
          </div>
        ) : sessionHistoryOpen ? (
          <SessionHistoryPanel
            currentSessionId={hermesSessionId}
            sessionSwitching={sessionSwitching}
            onOpenSession={openExistingSession}
            onContinueSession={continueEndedSession}
          />
        ) : agentResourcesOpen ? (
          <AgentResourcesPanel />
        ) : settingsOpen ? (
          <SettingsPanel
            settings={uiSettings}
            currentCamera={currentCamera}
            savingDefaults={settingsSaving}
            message={settingsMessage}
            error={settingsError}
            backgrounds={backgroundAssets}
            backgroundsLoading={backgroundsLoading}
            backgroundsError={backgroundsError}
            onChange={changeUiSettings}
            onReloadBackgrounds={() => void loadBackgrounds()}
            onResetBrowser={resetBrowserUiSettings}
            onSaveDefaults={() => void saveServerUiDefaults()}
          />
        ) : (
          <div className="conversation-scroll" ref={logRef}>
            <div className="messages" aria-live="polite">
              {messages.length === 0 && <div className="welcome"><h2>こんにちは</h2><p>下の欄からHermesへ話しかけてください。</p></div>}
              {messages.map((message, index) => (
                <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                  <span>{message.role === 'user' ? 'あなた' : 'Hermes'}</span>
                  {message.role === 'assistant' ? (
                    <MarkdownMessage content={message.content} />
                  ) : (
                    <p>{message.content || '…'}</p>
                  )}
                </article>
              ))}
            </div>
            {recoveryNotice && <p className="recovery-message" role="status">{recoveryNotice}</p>}
            <ToolTimeline runState={agentRunState} items={toolTimeline} />
            <ApprovalPanel request={approvalRequest} onRespond={respondToApproval} />
            {error && <p className="error-message">{error}</p>}
          </div>
        )}
        {!sessionHistoryOpen && !agentResourcesOpen && !settingsOpen && (
          <form
            className={`composer${displayMode === 'conversation' ? ` conversation-composer${conversationTextVisible ? ' text-open' : ''}` : ''}`}
            onSubmit={submit}
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              placeholder="メッセージを入力"
              rows={3}
              disabled={isBusy}
            />
            <div className="composer-actions">
              {displayMode === 'conversation' && (
                <button
                  type="button"
                  className="conversation-keyboard-button"
                  aria-expanded={conversationTextVisible}
                  disabled={isBusy}
                  onClick={() => setConversationTextOpen((current) => !current)}
                >
                  {conversationTextVisible ? '文字入力を閉じる' : '文字入力'}
                </button>
              )}
              <VoiceInputControl
                available={health?.stt.available === true}
                unavailableMessage={health?.stt.message ?? undefined}
                conversationActive={conversationActive}
                silenceMs={uiSettings.voice_input.silence_ms}
                speechThreshold={uiSettings.voice_input.speech_threshold}
                onBargeIn={stopConversation}
                onTranscript={(text) => void startConversation(text, text, false)}
              />
              {isBusy ? (
                <>
                {health?.tts_enabled && !speechStoppedForRun && (
                  <button type="button" className="stop-speech" onClick={stopSpeech}>
                    読み上げ停止
                  </button>
                )}
                <button type="button" className="stop-conversation" onClick={stopConversation} aria-label="Hermesの作業と音声を中断">
                  作業を中断
                </button>
                </>
              ) : (
                <button type="submit" className="send-button" disabled={!input.trim()}>
                  <span>送信</span>
                  <small className="send-shortcut" aria-hidden="true">Ctrl/⌘ + Enter</small>
                </button>
              )}
            </div>
          </form>
        )}
      </section>
    </main>
  )
}
