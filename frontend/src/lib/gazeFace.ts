// 登録した顔と、カメラを向いているかの判定をブラウザ内だけで扱います。

const STORAGE_KEY = 'avatar-gateway.gaze-face'
const DESCRIPTOR_LENGTH = 128

export interface GazeEnrollment {
  descriptor: number[]
  yaw: number
  pitch: number
}

export interface GazeSettings {
  enabled: boolean
  faceFollow: boolean
  detectEase: boolean
  gazeMessageSync: boolean
  enrollment: GazeEnrollment | null
}

function defaultGazeSettings(): GazeSettings {
  return { enabled: false, faceFollow: false, detectEase: false, gazeMessageSync: true, enrollment: null }
}

interface Point {
  x: number
  y: number
}

export const GAZE_MATCH_DISTANCE = 0.5
export const GAZE_YAW_TOLERANCE = 0.2
export const GAZE_PITCH_TOLERANCE = 0.18
export const GAZE_DWELL_MS = 700

/** 保存値がない、または壊れている場合は視線発話を使わない状態に戻します。 */
export function readGazeSettings(storage: Storage): GazeSettings {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return defaultGazeSettings()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      enabled: parsed.enabled === true,
      faceFollow: parsed.faceFollow === true,
      detectEase: parsed.detectEase === true,
      gazeMessageSync: parsed.gazeMessageSync !== false,
      enrollment: readEnrollment(parsed.enrollment),
    }
  } catch {
    return defaultGazeSettings()
  }
}

/** 顔の特徴量と視線の基準だけを、このブラウザへ保存します。 */
export function writeGazeSettings(storage: Storage, settings: GazeSettings): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

function readEnrollment(value: unknown): GazeEnrollment | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (!Array.isArray(item.descriptor) || item.descriptor.length !== DESCRIPTOR_LENGTH) return null
  if (item.descriptor.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) return null
  if (typeof item.yaw !== 'number' || !Number.isFinite(item.yaw) || Math.abs(item.yaw) > 2) return null
  if (typeof item.pitch !== 'number' || !Number.isFinite(item.pitch) || Math.abs(item.pitch) > 2) return null
  return { descriptor: item.descriptor, yaw: item.yaw, pitch: item.pitch }
}

/** 両目の間隔を基準に、鼻の位置から左右と上下の向きを読みます。 */
export function poseFromLandmarks(positions: Point[]): { yaw: number, pitch: number } | null {
  if (positions.length < 68) return null
  const left = centroid(positions.slice(36, 42))
  const right = centroid(positions.slice(42, 48))
  const nose = positions[30]
  const eyeDistance = Math.hypot(right.x - left.x, right.y - left.y)
  if (eyeDistance < 8) return null
  return {
    yaw: (nose.x - ((left.x + right.x) / 2)) / eyeDistance,
    pitch: (nose.y - ((left.y + right.y) / 2)) / eyeDistance,
  }
}

/** 顔認識モデルが比較に使う距離を、同じ長さの特徴量から計算します。 */
export function descriptorDistance(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index += 1) {
    const delta = left[index] - right[index]
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

/** 連続して撮った特徴量を平均し、長さを揃えて一人分の登録データにします。 */
export function averageDescriptor(descriptors: number[][]): number[] {
  const length = descriptors[0]?.length ?? 0
  const sum = Array.from({ length }, () => 0)
  for (const descriptor of descriptors) {
    for (let index = 0; index < length; index += 1) sum[index] += descriptor[index] ?? 0
  }
  const norm = Math.sqrt(sum.reduce((total, value) => total + value * value, 0)) || 1
  return sum.map((value) => value / norm)
}

function centroid(points: Point[]): Point {
  const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 })
  return { x: total.x / points.length, y: total.y / points.length }
}
