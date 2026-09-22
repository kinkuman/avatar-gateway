// マイクの常時監視と発話単位の録音を分離し、完全な音声ファイルだけを文字起こしへ渡します。

import { useEffect, useRef, useState } from 'react'

type VoiceInputState = 'off' | 'starting' | 'listening' | 'recording' | 'transcribing' | 'error'

interface Props {
  available: boolean
  unavailableMessage?: string
  conversationActive: boolean
  silenceMs: number
  speechThreshold: number
  onBargeIn: () => void
  onTranscript: (text: string) => void
}

interface TranscriptionResponse {
  text: string
  language: string
  duration: number | null
}

const MAX_UTTERANCE_MS = 60_000
const NORMAL_CONFIRM_MS = 140
const BARGE_IN_CONFIRM_MS = 280

const stateLabels: Record<VoiceInputState, string> = {
  off: 'マイクOFF',
  starting: 'マイクを準備中…',
  listening: '聞き取り待機中',
  recording: '聞き取り中…',
  transcribing: '文字起こし中…',
  error: '音声入力エラー',
}

/** FirefoxとChromiumの両方で使えるOpus形式を優先し、利用可能な録音形式を選びます。 */
function selectRecorderMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
  ]
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
}

/** FastAPIのdetail応答を利用者向けメッセージとして安全に取り出します。 */
async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { detail?: unknown }
    if (typeof payload.detail === 'string') return payload.detail
  } catch {
    // JSONでない障害応答では、状態コードを使った共通メッセージへ戻します。
  }
  return `文字起こしAPIエラー (${response.status})`
}

/** 音量監視は継続しつつ、発話ごとに独立した録音ファイルを作って既存会話へ渡します。 */
export default function VoiceInputControl({
  available,
  unavailableMessage,
  conversationActive,
  silenceMs,
  speechThreshold,
  onBargeIn,
  onTranscript,
}: Props) {
  const [state, setState] = useState<VoiceInputState>('off')
  const [message, setMessage] = useState('')
  const enabledRef = useRef(false)
  const conversationActiveRef = useRef(conversationActive)
  const silenceMsRef = useRef(silenceMs)
  const speechThresholdRef = useRef(speechThreshold)
  const onBargeInRef = useRef(onBargeIn)
  const onTranscriptRef = useRef(onTranscript)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const uploadControllerRef = useRef<AbortController | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const capturingRef = useRef(false)
  const finishingRef = useRef(false)
  const confirmedRef = useRef(false)
  const discardRef = useRef(false)
  const transcribingRef = useRef(false)
  const armedRef = useRef(true)
  const candidateStartedDuringConversationRef = useRef(false)
  const speechStartRef = useRef<number | null>(null)
  const silenceStartRef = useRef<number | null>(null)
  const recordingStartRef = useRef<number | null>(null)

  conversationActiveRef.current = conversationActive
  silenceMsRef.current = silenceMs
  speechThresholdRef.current = speechThreshold
  onBargeInRef.current = onBargeIn
  onTranscriptRef.current = onTranscript

  /** 完成した一発話をローカル認識APIへ送り、成功時だけ会話入力として採用します。 */
  const uploadUtterance = async (audio: Blob) => {
    if (audio.size < 256 || !enabledRef.current) {
      if (enabledRef.current) setState('listening')
      return
    }

    transcribingRef.current = true
    setState('transcribing')
    setMessage('')
    const controller = new AbortController()
    uploadControllerRef.current = controller
    try {
      const response = await fetch('/api/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': audio.type },
        body: audio,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(await readError(response))
      const payload = await response.json() as Partial<TranscriptionResponse>
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text) throw new Error('発話を認識できませんでした')
      if (enabledRef.current) {
        setState('listening')
        onTranscriptRef.current(text)
      }
    } catch (cause) {
      if (!controller.signal.aborted && enabledRef.current) {
        setState('error')
        setMessage(cause instanceof Error ? cause.message : '音声入力に失敗しました')
      }
    } finally {
      if (uploadControllerRef.current === controller) uploadControllerRef.current = null
      transcribingRef.current = false
      // 同じ環境音を直ちに再送しないよう、実際の無音を確認するまで次を開始しません。
      armedRef.current = false
    }
  }

  /** 発話ごとのMediaRecorderを停止し、onstopで完全なコンテナを確定させます。 */
  const stopCandidate = (discard: boolean) => {
    if (!capturingRef.current || finishingRef.current) return
    capturingRef.current = false
    finishingRef.current = true
    discardRef.current = discard
    speechStartRef.current = null
    silenceStartRef.current = null
    recordingStartRef.current = null
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      finishingRef.current = false
      recorderRef.current = null
      chunksRef.current = []
      armedRef.current = false
      if (enabledRef.current) setState('listening')
      return
    }
    recorder.stop()
  }

  /** 音量が最初にしきい値を越えた瞬間から録音し、確認待ちによる語頭欠落を避けます。 */
  const beginCandidate = (startedAt: number) => {
    const stream = streamRef.current
    if (
      !stream
      || capturingRef.current
      || finishingRef.current
      || transcribingRef.current
      || !armedRef.current
    ) return

    const mimeType = selectRecorderMimeType()
    let recorder: MediaRecorder
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    } catch (cause) {
      armedRef.current = false
      setState('error')
      setMessage(cause instanceof Error ? cause.message : 'ブラウザの録音処理を開始できません')
      return
    }
    const actualMimeType = recorder.mimeType || mimeType || 'audio/webm'
    chunksRef.current = []
    discardRef.current = false
    confirmedRef.current = false
    candidateStartedDuringConversationRef.current = conversationActiveRef.current
    speechStartRef.current = startedAt
    silenceStartRef.current = null
    recordingStartRef.current = startedAt
    capturingRef.current = true
    recorderRef.current = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunksRef.current.push(event.data)
    }
    recorder.onstop = () => {
      const chunks = chunksRef.current
      const discard = discardRef.current || !confirmedRef.current
      chunksRef.current = []
      recorderRef.current = null
      finishingRef.current = false
      confirmedRef.current = false
      candidateStartedDuringConversationRef.current = false
      armedRef.current = false
      if (!enabledRef.current || discard) {
        if (enabledRef.current) setState('listening')
        return
      }
      void uploadUtterance(new Blob(chunks, { type: actualMimeType }))
    }
    recorder.onerror = () => {
      discardRef.current = true
      setMessage('ブラウザの録音処理に失敗しました')
    }
    try {
      recorder.start()
    } catch (cause) {
      recorderRef.current = null
      chunksRef.current = []
      capturingRef.current = false
      armedRef.current = false
      setState('error')
      setMessage(cause instanceof Error ? cause.message : 'ブラウザの録音処理を開始できません')
      return
    }
    setMessage('')
    setState('recording')
  }

  /** 継続時間を満たした音だけを発話と確定し、割り込み時は既存Runを一度だけ止めます。 */
  const confirmCandidate = () => {
    if (confirmedRef.current || !capturingRef.current) return
    confirmedRef.current = true
    if (candidateStartedDuringConversationRef.current) onBargeInRef.current()
  }

  /** RMS音量を監視し、短音の破棄、発話確定、指定無音、最大録音時間を判定します。 */
  const startVadLoop = (analyser: AnalyserNode) => {
    const samples = new Float32Array(analyser.fftSize)
    const tick = (now: number) => {
      if (!enabledRef.current) return
      analyser.getFloatTimeDomainData(samples)
      let sumSquares = 0
      for (const sample of samples) sumSquares += sample * sample
      const rms = Math.sqrt(sumSquares / samples.length)
      const speechDetected = rms >= speechThresholdRef.current

      if (!speechDetected && !capturingRef.current && !finishingRef.current && !transcribingRef.current) {
        // 前回の発話や422後に一度無音を挟み、同じ音源による連続送信を防ぎます。
        armedRef.current = true
      }

      if (!transcribingRef.current && !finishingRef.current) {
        if (!capturingRef.current) {
          if (speechDetected && armedRef.current) beginCandidate(now)
        } else if (!confirmedRef.current) {
          if (!speechDetected) {
            stopCandidate(true)
          } else if (speechStartRef.current !== null) {
            const confirmMs = candidateStartedDuringConversationRef.current
              ? BARGE_IN_CONFIRM_MS
              : NORMAL_CONFIRM_MS
            if (now - speechStartRef.current >= confirmMs) confirmCandidate()
          }
        } else if (speechDetected) {
          silenceStartRef.current = null
        } else {
          silenceStartRef.current ??= now
          if (now - silenceStartRef.current >= silenceMsRef.current) stopCandidate(false)
        }

        if (
          capturingRef.current
          && confirmedRef.current
          && recordingStartRef.current !== null
          && now - recordingStartRef.current >= MAX_UTTERANCE_MS
        ) stopCandidate(false)
      }
      animationFrameRef.current = requestAnimationFrame(tick)
    }
    animationFrameRef.current = requestAnimationFrame(tick)
  }

  /** マイクと関連する非同期処理を止め、再度ONにできる初期状態へ戻します。 */
  const stopMicrophone = () => {
    enabledRef.current = false
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
    animationFrameRef.current = null
    uploadControllerRef.current?.abort()
    uploadControllerRef.current = null
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.stop()
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
    chunksRef.current = []
    capturingRef.current = false
    finishingRef.current = false
    confirmedRef.current = false
    discardRef.current = false
    transcribingRef.current = false
    armedRef.current = true
    candidateStartedDuringConversationRef.current = false
    speechStartRef.current = null
    silenceStartRef.current = null
    recordingStartRef.current = null
    setMessage('')
    setState('off')
  }

  /** 利用者操作を起点に権限を取得し、エコー抑制付きの音量監視だけを常時開始します。 */
  const startMicrophone = async () => {
    if (!available || enabledRef.current) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('error')
      setMessage('このブラウザではマイク録音を利用できません')
      return
    }
    enabledRef.current = true
    setState('starting')
    setMessage('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      })
      if (!enabledRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const context = new AudioContext()
      contextRef.current = context
      await context.resume()
      if (!enabledRef.current) {
        stopMicrophone()
        return
      }
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.15
      context.createMediaStreamSource(stream).connect(analyser)
      armedRef.current = true
      setState('listening')
      startVadLoop(analyser)
    } catch (cause) {
      stopMicrophone()
      setState('error')
      setMessage(cause instanceof Error ? cause.message : 'マイクを開始できませんでした')
    }
  }

  useEffect(() => () => stopMicrophone(), [])
  useEffect(() => {
    if (!available && enabledRef.current) stopMicrophone()
  }, [available])

  return (
    <div className={`voice-input-control voice-input-${state}`}>
      <button
        type="button"
        className="voice-input-button"
        disabled={!available || state === 'starting'}
        aria-pressed={enabledRef.current}
        onClick={() => {
          if (enabledRef.current) stopMicrophone()
          else void startMicrophone()
        }}
      >
        {enabledRef.current ? 'マイクOFF' : 'マイクON'}
      </button>
      <span className="voice-input-status" role="status">
        {!available ? unavailableMessage || '音声入力は無効です' : message || stateLabels[state]}
      </span>
    </div>
  )
}
