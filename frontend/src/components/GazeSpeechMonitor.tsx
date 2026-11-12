// ウェブカメラで登録した顔が向いたときだけ、積んである視線発話を再生します。
import { readMessage, t, useTranslation, translateMessage } from '../i18n'

import { useEffect, useRef, useState } from 'react'

import {
  applyGammaByte,
  averageLuma,
  centerSampleRegion,
  detectorTune,
  gammaExponentForLuma,
} from '../lib/detectEase'
import {
  chooseFollowBox,
  faceFollowAngles,
  type FaceFollowAngles,
} from '../lib/faceFollow'
import {
  GAZE_DWELL_MS,
  GAZE_MATCH_DISTANCE,
  GAZE_PITCH_TOLERANCE,
  GAZE_YAW_TOLERANCE,
  averageDescriptor,
  descriptorDistance,
  poseFromLandmarks,
  type GazeEnrollment,
} from '../lib/gazeFace'
import { nextSilentGazeReaction, SILENT_GAZE_HOLD_MS } from '../lib/silentGazeReaction'
import type { MotionCatalogItem } from '../types'

interface FaceSample {
  descriptor: number[]
  yaw: number
  pitch: number
}

interface Props {
  enabled: boolean
  faceFollow: boolean
  detectEase: boolean
  enrollment: GazeEnrollment | null
  enrolling: boolean
  blocked: boolean
  ttsEnabled: boolean
  motions: MotionCatalogItem[]
  volume: number
  stopRef: { current: (() => void) | null }
  onEnrolled: (enrollment: GazeEnrollment) => void
  onEnrollClose: () => void
  onStatus: (status: string) => void
  onFaceAngles: (angles: FaceFollowAngles | null) => void
  onFaceFollowStatus: (status: string) => void
  onAudio: (analyser: AnalyserNode | null) => void
  onBeat: (data: Record<string, unknown> | null) => void
  onSpoken: () => void
  getAudioContext: () => AudioContext
}

/** 顔モデルの読込を一回にまとめ、監視と登録で同じ検出器を使います。 */
let faceApiPromise: Promise<typeof import('@vladmandic/face-api')> | null = null

function loadFaceApi(): Promise<typeof import('@vladmandic/face-api')> {
  if (!faceApiPromise) {
    faceApiPromise = import('@vladmandic/face-api').then(async (faceapi) => {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('/face-models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/face-models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/face-models'),
      ])
      return faceapi
    }).catch((cause) => {
      faceApiPromise = null
      throw cause
    })
  }
  return faceApiPromise
}

type FaceApi = Awaited<ReturnType<typeof loadFaceApi>>

interface LocatedFace {
  box: { x: number, y: number, width: number, height: number }
  descriptor: number[] | null
  landmarks: { x: number, y: number }[] | null
}

function plainBox(box: { x: number, y: number, width: number, height: number }): LocatedFace['box'] {
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/** 暗い中央部だけを、画面に出さないキャンバスへ明るく描きます。明るいときは元の映像を返します。 */
function detectionSource(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ease: boolean,
): HTMLVideoElement | HTMLCanvasElement {
  if (!ease) return video
  const width = video.videoWidth
  const height = video.videoHeight
  if (width < 2 || height < 2) return video
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return video
  context.drawImage(video, 0, 0, width, height)
  const region = centerSampleRegion(width, height)
  const sample = context.getImageData(region.x, region.y, region.width, region.height)
  const exponent = gammaExponentForLuma(averageLuma(sample.data))
  if (exponent === null) return video
  const frame = context.getImageData(0, 0, width, height)
  const pixels = frame.data
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = applyGammaByte(pixels[index], exponent)
    pixels[index + 1] = applyGammaByte(pixels[index + 1], exponent)
    pixels[index + 2] = applyGammaByte(pixels[index + 2], exponent)
  }
  context.putImageData(frame, 0, 0)
  return canvas
}

/** 枠は明るさ補正後でも、特徴量とランドマークは元の映像から取ります。 */
async function describeOnOriginal(
  faceapi: FaceApi,
  video: HTMLVideoElement,
  detections: InstanceType<FaceApi['FaceDetection']>[],
): Promise<LocatedFace[]> {
  if (detections.length === 0) return []
  const crops = await faceapi.extractFaces(video, detections)
  const located: LocatedFace[] = []
  for (let index = 0; index < detections.length; index += 1) {
    const detection = detections[index]
    const crop = crops[index]
    if (!crop || crop.width < 1 || crop.height < 1) continue
    const unshifted = await faceapi.detectFaceLandmarks(crop)
    if (!unshifted || Array.isArray(unshifted)) continue
    const withLandmarks = faceapi.extendWithFaceLandmarks({ detection }, unshifted)
    const aligned = withLandmarks.landmarks.align(null, { useDlibAlignment: true })
    const rect = new faceapi.Rect(aligned.x, aligned.y, aligned.width, aligned.height)
    const [alignedCrop] = await faceapi.extractFaces(video, [rect])
    if (!alignedCrop || alignedCrop.width < 1 || alignedCrop.height < 1) continue
    const descriptor = await faceapi.nets.faceRecognitionNet.computeFaceDescriptor(alignedCrop)
    if (!(descriptor instanceof Float32Array)) continue
    located.push({
      box: plainBox(detection.box),
      descriptor: Array.from(descriptor),
      landmarks: withLandmarks.landmarks.positions.map((point) => ({ x: point.x, y: point.y })),
    })
  }
  return located
}

/** 設定がオフのときは従来の検出のまま、オンのときだけ暗いフレームを補正します。 */
async function locateFaces(
  faceapi: FaceApi,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ease: boolean,
  withIdentity: boolean,
): Promise<LocatedFace[]> {
  const options = new faceapi.TinyFaceDetectorOptions(detectorTune(ease))
  const source = detectionSource(video, canvas, ease)
  if (!withIdentity) {
    const detections = await faceapi.detectAllFaces(source, options)
    return detections.map((detection) => ({
      box: plainBox(detection.box),
      descriptor: null,
      landmarks: null,
    }))
  }
  if (source === video) {
    const detections = await faceapi
      .detectAllFaces(video, options)
      .withFaceLandmarks()
      .withFaceDescriptors()
    return detections.map((detection) => ({
      box: plainBox(detection.detection.box),
      descriptor: Array.from(detection.descriptor),
      landmarks: detection.landmarks.positions.map((point) => ({ x: point.x, y: point.y })),
    }))
  }
  return describeOnOriginal(faceapi, video, await faceapi.detectAllFaces(source, options))
}

/** 再生しないまま残ったWAVを、会話の読み上げと同じ通知で回収します。 */
function notifySpeech(type: string, utteranceId: string, extra: Record<string, unknown> = {}): void {
  void fetch('/api/speech-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({ type, utterance_id: utteranceId, ...extra }),
  }).catch(() => undefined)
}

interface GazeBeatPlayback {
  utteranceId: string
  audioUrl: string
  text: string
  motion: unknown
  expression: unknown
}

/** 新しい複数ブロックと、以前の単一音声応答のどちらも再生順に揃えます。 */
function readGazeBeats(payload: Record<string, unknown>): GazeBeatPlayback[] {
  const source = Array.isArray(payload.beats) && payload.beats.length > 0 ? payload.beats : [payload]
  const beats: GazeBeatPlayback[] = []
  for (const item of source) {
    if (!item || typeof item !== 'object') continue
    const beat = item as Record<string, unknown>
    if (typeof beat.audio_url !== 'string' || typeof beat.utterance_id !== 'string') continue
    beats.push({
      utteranceId: beat.utterance_id,
      audioUrl: beat.audio_url,
      text: typeof beat.text === 'string' ? beat.text : '',
      motion: beat.motion ?? null,
      expression: beat.expression ?? 'neutral',
    })
  }
  return beats
}

/** 再生しなかったWAVを、会話の読み上げと同じ通知で回収します。 */
function cancelGazeBeats(beats: GazeBeatPlayback[], reason: string): void {
  for (const beat of beats) notifySpeech('speech.cancelled', beat.utteranceId, { reason })
}

/** 登録と監視で同じ映像を使い、会話中は視線発話を始めないようにします。 */
export default function GazeSpeechMonitor({
  enabled,
  faceFollow,
  detectEase,
  enrollment,
  enrolling,
  blocked,
  ttsEnabled,
  motions,
  volume,
  stopRef,
  onEnrolled,
  onEnrollClose,
  onStatus,
  onFaceAngles,
  onFaceFollowStatus,
  onAudio,
  onBeat,
  onSpoken,
  getAudioContext,
}: Props) {
  useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const playingRef = useRef(false)
  const interruptedRef = useRef(false)
  const blockedRef = useRef(blocked)
  const volumeRef = useRef(volume)
  const enrollmentRef = useRef(enrollment)
  const enabledRef = useRef(enabled)
  const faceFollowRef = useRef(faceFollow)
  const detectEaseRef = useRef(detectEase)
  const detectBusyRef = useRef(false)
  const onStatusRef = useRef(onStatus)
  const onFaceAnglesRef = useRef(onFaceAngles)
  const onFaceFollowStatusRef = useRef(onFaceFollowStatus)
  const onAudioRef = useRef(onAudio)
  const onBeatRef = useRef(onBeat)
  const onSpokenRef = useRef(onSpoken)
  const getAudioContextRef = useRef(getAudioContext)
  const lookSinceRef = useRef<number | null>(null)
  const armedRef = useRef(true)
  const motionsRef = useRef(motions)
  const silentCursorRef = useRef(0)
  const [captureError, setCaptureError] = useState('')
  const [capturing, setCapturing] = useState(false)
  const cameraNeeded = enrolling || (enabled && enrollment !== null) || faceFollow

  blockedRef.current = blocked
  volumeRef.current = volume
  enrollmentRef.current = enrollment
  enabledRef.current = enabled
  faceFollowRef.current = faceFollow
  detectEaseRef.current = detectEase
  onStatusRef.current = onStatus
  onFaceAnglesRef.current = onFaceAngles
  onFaceFollowStatusRef.current = onFaceFollowStatus
  onAudioRef.current = onAudio
  onBeatRef.current = onBeat
  onSpokenRef.current = onSpoken
  getAudioContextRef.current = getAudioContext
  motionsRef.current = motions

  useEffect(() => {
    stopRef.current = stopPlayback
    return () => {
      stopRef.current = null
    }
  })

  useEffect(() => {
    if (blocked) stopPlayback()
  }, [blocked])

  useEffect(() => {
    if (!cameraNeeded) {
      stopCamera()
      if (!enabledRef.current) onStatusRef.current(t('gaze.status.stopped'))
      else if (!enrollmentRef.current) onStatusRef.current(t('gaze.status.notEnrolled'))
      if (!faceFollowRef.current) onFaceFollowStatusRef.current(t('gaze.status.stopped'))
      onFaceAnglesRef.current(null)
      return
    }

    const video = videoRef.current
    if (!video) return
    let cancelled = false

    const start = async () => {
      if (enabledRef.current || enrolling) onStatusRef.current(t('gaze.status.cameraPreparing'))
      if (faceFollowRef.current) onFaceFollowStatusRef.current(t('gaze.status.cameraPreparing'))
      try {
        await loadFaceApi()
        if (cancelled) return
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        video.srcObject = stream
        await video.play()
        if (enrolling) onStatusRef.current(t('gaze.status.readyToEnroll'))
        else if (enabledRef.current) onStatusRef.current(t('gaze.status.monitoring'))
        if (faceFollowRef.current) onFaceFollowStatusRef.current(t('gaze.status.searching'))
      } catch {
        if (cancelled) return
        if (enabledRef.current || enrolling) onStatusRef.current(t('gaze.status.cameraUnavailable'))
        if (faceFollowRef.current) onFaceFollowStatusRef.current(t('gaze.status.cameraUnavailable'))
      }
    }
    void start()

    return () => {
      cancelled = true
      stopCamera()
    }
  }, [cameraNeeded, enrolling])

  useEffect(() => {
    if (!enabled || !enrollment || enrolling || blocked || !ttsEnabled) {
      lookSinceRef.current = null
      if (blocked) armedRef.current = false
      return
    }
    let stopped = false
    let busy = false

    const tick = async () => {
      if (stopped || busy || playingRef.current || blockedRef.current || detectBusyRef.current) return
      const video = videoRef.current
      if (!video || video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return
      busy = true
      detectBusyRef.current = true
      try {
        const faceapi = await loadFaceApi()
        if (!detectCanvasRef.current) detectCanvasRef.current = document.createElement('canvas')
        const faces = await locateFaces(faceapi, video, detectCanvasRef.current, detectEaseRef.current, true)
        if (stopped) return
        if (faceFollowRef.current) {
          const followed = enrollmentRef.current
          const box = chooseFollowBox(faces.map((face) => ({
            box: face.box,
            distance: followed && face.descriptor
              ? descriptorDistance(followed.descriptor, face.descriptor)
              : null,
          })), followed !== null, GAZE_MATCH_DISTANCE)
          if (!box) {
            onFaceAnglesRef.current(null)
            onFaceFollowStatusRef.current(followed ? t('gaze.status.enrolledFaceMissing') : t('gaze.status.faceMissing'))
          } else {
            const angles = faceFollowAngles(box, video.videoWidth, video.videoHeight)
            onFaceAnglesRef.current(angles)
            onFaceFollowStatusRef.current(angles ? t('gaze.status.following') : t('gaze.status.positionUnavailable'))
          }
        }
        if (faces.length !== 1) {
          lookSinceRef.current = null
          armedRef.current = true
          onStatusRef.current(faces.length === 0 ? t('gaze.status.faceMissing') : t('gaze.status.multipleFaces'))
          return
        }
        const currentEnrollment = enrollmentRef.current
        if (!currentEnrollment) return
        const face = faces[0]
        if (!face.descriptor || !face.landmarks) {
          lookSinceRef.current = null
          armedRef.current = true
          onStatusRef.current(t('gaze.status.positionReadFailed'))
          return
        }
        const distance = descriptorDistance(currentEnrollment.descriptor, face.descriptor)
        if (distance > GAZE_MATCH_DISTANCE) {
          lookSinceRef.current = null
          armedRef.current = true
          onStatusRef.current(t('gaze.status.faceMismatch'))
          return
        }
        const pose = poseFromLandmarks(face.landmarks)
        const looking = pose !== null
          && Math.abs(pose.yaw - currentEnrollment.yaw) <= GAZE_YAW_TOLERANCE
          && Math.abs(pose.pitch - currentEnrollment.pitch) <= GAZE_PITCH_TOLERANCE
        if (!looking) {
          lookSinceRef.current = null
          armedRef.current = true
          onStatusRef.current(t('gaze.status.verifying'))
          return
        }
        if (!armedRef.current) {
          onStatusRef.current(t('gaze.status.lookingAtCamera'))
          return
        }
        if (lookSinceRef.current === null) lookSinceRef.current = performance.now()
        if (performance.now() - lookSinceRef.current < GAZE_DWELL_MS) {
          onStatusRef.current(t('gaze.status.lookingAtCamera'))
          return
        }
        lookSinceRef.current = null
        armedRef.current = false
        await claimAndPlay()
      } catch {
        if (!stopped) onStatusRef.current(t('gaze.status.verificationFailed'))
      } finally {
        busy = false
        detectBusyRef.current = false
      }
    }

    const timer = window.setInterval(() => void tick(), 200)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [blocked, enabled, enrolling, enrollment, ttsEnabled])

  useEffect(() => {
    if (enabled && enrollment && !ttsEnabled) onStatusRef.current(t('gaze.status.ttsDisabled'))
  }, [enabled, enrollment, ttsEnabled])

  useEffect(() => {
    const gazeOwnsCamera = enabled && enrollment !== null && !enrolling && !blocked && ttsEnabled
    if (!faceFollow || enrolling || gazeOwnsCamera) {
      if (!faceFollow || enrolling) onFaceAnglesRef.current(null)
      if (!faceFollow) onFaceFollowStatusRef.current(t('gaze.status.stopped'))
      return
    }
    let stopped = false

    const publish = (box: { x: number, y: number, width: number, height: number } | null, video: HTMLVideoElement) => {
      if (!box) {
        onFaceAnglesRef.current(null)
        onFaceFollowStatusRef.current(enrollmentRef.current ? t('gaze.status.enrolledFaceMissing') : t('gaze.status.faceMissing'))
        return
      }
      const angles = faceFollowAngles(box, video.videoWidth, video.videoHeight)
      onFaceAnglesRef.current(angles)
      onFaceFollowStatusRef.current(angles ? t('gaze.status.following') : t('gaze.status.positionUnavailable'))
    }

    const tick = async () => {
      if (stopped || detectBusyRef.current) return
      const video = videoRef.current
      if (!video || video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return
      detectBusyRef.current = true
      try {
        const faceapi = await loadFaceApi()
        const currentEnrollment = enrollmentRef.current
        if (!detectCanvasRef.current) detectCanvasRef.current = document.createElement('canvas')
        const faces = await locateFaces(
          faceapi,
          video,
          detectCanvasRef.current,
          detectEaseRef.current,
          currentEnrollment !== null,
        )
        if (stopped) return
        publish(chooseFollowBox(faces.map((face) => ({
          box: face.box,
          distance: currentEnrollment && face.descriptor
            ? descriptorDistance(currentEnrollment.descriptor, face.descriptor)
            : null,
        })), currentEnrollment !== null, GAZE_MATCH_DISTANCE), video)
      } catch {
        if (!stopped) {
          onFaceAnglesRef.current(null)
          onFaceFollowStatusRef.current(t('gaze.status.positionUnavailable'))
        }
      } finally {
        detectBusyRef.current = false
      }
    }

    const timer = window.setInterval(() => void tick(), 200)
    return () => {
      stopped = true
      window.clearInterval(timer)
      if (!faceFollowRef.current) onFaceAnglesRef.current(null)
    }
  }, [blocked, enabled, enrolling, enrollment, faceFollow, ttsEnabled])

  /** 今映っている顔を数枚重ね、登録時の向きを基準として保存します。 */
  const captureFace = async () => {
    const video = videoRef.current
    if (!video || capturing) return
    setCapturing(true)
    setCaptureError('')
    try {
      const faceapi = await loadFaceApi()
      const samples: FaceSample[] = []
      if (!detectCanvasRef.current) detectCanvasRef.current = document.createElement('canvas')
      for (let index = 0; index < 5; index += 1) {
        const faces = await locateFaces(faceapi, video, detectCanvasRef.current, detectEaseRef.current, true)
        const face = faces[0]
        if (faces.length !== 1 || !face?.descriptor || !face.landmarks) {
          // 誤登録を防ぐため、一人だけが映る状態での登録を求めます。
          setCaptureError(t('gaze.errors.singleFaceRequired'))
          return
        }
        const pose = poseFromLandmarks(face.landmarks)
        if (!pose) {
          // 顔の位置が取得できない状態では、登録を進めません。
          setCaptureError(t('gaze.errors.enrollPosition'))
          return
        }
        samples.push({ descriptor: face.descriptor, ...pose })
        await new Promise((resolve) => window.setTimeout(resolve, 120))
      }
      const first = samples[0].descriptor
      if (samples.some((sample) => descriptorDistance(first, sample.descriptor) > 0.45)) {
        // 登録値がぶれないよう、正面を向いて静止することを求めます。
        setCaptureError(t('gaze.errors.faceMoving'))
        return
      }
      onEnrolled({
        descriptor: averageDescriptor(samples.map((sample) => sample.descriptor)),
        yaw: samples.reduce((sum, sample) => sum + sample.yaw, 0) / samples.length,
        pitch: samples.reduce((sum, sample) => sum + sample.pitch, 0) / samples.length,
      })
      onEnrollClose()
    } catch {
      // 顔登録が完了しなかったことを利用者へ知らせます。
      setCaptureError(t('gaze.errors.enroll'))
    } finally {
      setCapturing(false)
    }
  }

  /** 読み上げる用件が無いときは、表情と身振りだけを短く出します。 */
  async function holdSilentReaction(): Promise<boolean> {
    const choice = nextSilentGazeReaction(motionsRef.current, silentCursorRef.current)
    silentCursorRef.current = choice.nextCursor
    interruptedRef.current = false
    onBeatRef.current({
      motion: choice.motion ? { name: choice.motion } : null,
      expression: choice.expression,
      text: '',
      beatIndex: 0,
    })
    onStatusRef.current(t('gaze.status.silentReaction'))
    const until = performance.now() + SILENT_GAZE_HOLD_MS
    while (performance.now() < until) {
      if (blockedRef.current || interruptedRef.current) break
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
    return true
  }

  /** 待ち行列の先頭を受け取り、動きを変えながら続けて再生します。 */
  async function claimAndPlay(): Promise<void> {
    if (playingRef.current || blockedRef.current) return
    playingRef.current = true
    let acted = false
    let unplayed: GazeBeatPlayback[] = []
    try {
      const response = await fetch('/api/gaze-speech/claim', { method: 'POST' })
      const payload = await response.json() as Record<string, unknown>
      if (!response.ok) {
        // 視線発話を開始できない理由を利用者へ知らせます。
        onStatusRef.current(readMessage(payload, t('gaze.errors.prepareSpeech')))
        return
      }
      const beats = readGazeBeats(payload)
      if (payload.spoken !== true || beats.length === 0) {
        acted = await holdSilentReaction()
        return
      }
      if (blockedRef.current) {
        // 通常の会話を優先し、競合する視線発話を取り消します。
        cancelGazeBeats(beats, t('gaze.errors.conversationStarted'))
        return
      }
      const context = getAudioContextRef.current()
      let completedAll = true
      for (let index = 0; index < beats.length; index += 1) {
        const beat = beats[index]
        unplayed = beats.slice(index)
        if (blockedRef.current) {
          // 通常の会話を優先し、競合する視線発話を取り消します。
          cancelGazeBeats(unplayed, t('gaze.errors.conversationStarted'))
          unplayed = []
          completedAll = false
          break
        }
        const audioResponse = await fetch(beat.audioUrl)
        // ここで中断する条件: 音声ファイルを取得できませんでした。
        if (!audioResponse.ok) throw new Error(t('gaze.errors.audioFetch'))
        const buffer = await context.decodeAudioData(await audioResponse.arrayBuffer())
        if (blockedRef.current) {
          // 通常の会話を優先し、競合する視線発話を取り消します。
          cancelGazeBeats(unplayed, t('gaze.errors.conversationStarted'))
          unplayed = []
          completedAll = false
          break
        }
        onBeatRef.current({
          motion: beat.motion,
          expression: beat.expression,
          text: beat.text,
          beatIndex: index,
        })
        acted = true
        unplayed = beats.slice(index + 1)
        const completed = await playBuffer(context, buffer, beat.utteranceId, index < beats.length - 1)
        if (!completed) {
          // 中断した視線発話を、完了した発話として扱いません。
          cancelGazeBeats(unplayed, t('gaze.errors.speechCancelled'))
          unplayed = []
          completedAll = false
          break
        }
      }
      if (completedAll) onSpokenRef.current()
    } catch {
      // 視線発話の再生失敗を利用者へ知らせます。
      cancelGazeBeats(unplayed, t('gaze.errors.speechPlay'))
      // 音声の再生失敗を利用者へ知らせます。
      onStatusRef.current(t('gaze.errors.audioPlay'))
    } finally {
      playingRef.current = false
      if (acted) onBeatRef.current(null)
    }
  }

  /** 口パク用の波形を親へ渡し、再生が終わるか中断されるまで待ちます。 */
  function playBuffer(
    context: AudioContext,
    buffer: AudioBuffer,
    utteranceId: string,
    handoff: boolean,
  ): Promise<boolean> {
    const source = context.createBufferSource()
    const analyser = context.createAnalyser()
    const gain = context.createGain()
    source.buffer = buffer
    analyser.fftSize = 2048
    gain.gain.value = volumeRef.current
    source.connect(analyser)
    analyser.connect(gain)
    gain.connect(context.destination)
    sourceRef.current = source
    interruptedRef.current = false
    onAudioRef.current(analyser)
    onStatusRef.current(t('gaze.status.speaking'))
    notifySpeech('speech.started', utteranceId)
    const startedAt = performance.now()
    return new Promise((resolve) => {
      source.onended = () => {
        const interrupted = interruptedRef.current
        if (sourceRef.current === source) sourceRef.current = null
        if (!handoff || interrupted) onAudioRef.current(null)
        // 中断した視線発話を、完了した発話として扱いません。
        notifySpeech(
          interrupted ? 'speech.cancelled' : 'speech.completed',
          utteranceId,
          interrupted
            ? { reason: t('gaze.errors.speechCancelled') }
            : { played_ms: Math.round(performance.now() - startedAt) },
        )
        resolve(!interrupted)
      }
      void context.resume()
      source.start()
    })
  }

  function stopPlayback(): void {
    interruptedRef.current = true
    const source = sourceRef.current
    sourceRef.current = null
    if (source) {
      try {
        source.stop()
      } catch {
        // 再生前や終了直後の停止は、そのまま後始末を続けます。
      }
    }
    onAudioRef.current(null)
    playingRef.current = false
    lookSinceRef.current = null
    armedRef.current = false
  }

  function stopCamera(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }

  return (
    <div className={enrolling ? 'gaze-enroll-overlay' : undefined}>
      <video
        ref={videoRef}
        className={enrolling ? 'gaze-camera-preview' : 'gaze-camera-source'}
        muted
        playsInline
        aria-hidden={enrolling ? undefined : true}
      />
      {enrolling && (
        <div className="gaze-enroll-card" role="dialog" aria-modal="true" aria-label={t('gaze.enrollment.panelLabel')}>
          <h2>{t('gaze.enrollment.title')}</h2>
          <p>{t('gaze.enrollment.description')}</p>
            {captureError && <p className="settings-error" role="alert">{translateMessage(captureError)}</p>}
            <div className="settings-row-actions">
              <button type="button" className="primary" disabled={capturing} onClick={() => void captureFace()}>
                {capturing ? t('gaze.enrollment.saving') : t('gaze.enrollment.save')}
              </button>
              <button type="button" disabled={capturing} onClick={onEnrollClose}>{t('gaze.enrollment.cancel')}</button>
            </div>
          </div>
      )}
    </div>
  )
}
