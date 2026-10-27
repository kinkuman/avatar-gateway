// カメラ映像のどこに顔があるかを、視線と顔の向きの角度へ変えます。

export interface FaceFrameBox {
  x: number
  y: number
  width: number
  height: number
}

export interface FaceFollowAngles {
  lookYaw: number
  lookPitch: number
  headYaw: number
  headPitch: number
}

export interface FaceFollowCandidate {
  box: FaceFrameBox
  distance: number | null
}

export const FACE_FOLLOW_LOOK_YAW_DEGREES = 24
export const FACE_FOLLOW_LOOK_PITCH_DEGREES = 16
export const FACE_FOLLOW_HEAD_YAW_DEGREES = 18
export const FACE_FOLLOW_HEAD_PITCH_DEGREES = 12
const FACE_FOLLOW_DEAD_ZONE = 0.08
/** 見失ってから正面へ戻し始めるまでの待ち時間です。短い途切れでは頭を動かしません。 */
export const FACE_FOLLOW_HOLD_SECONDS = 2
const FACE_FOLLOW_TRACK_RATE = 8
/** 待ちのあと、最後の向きを保ったまま影響だけを抜く速さです。 */
const FACE_FOLLOW_RETURN_RATE = 0.45

export interface FaceFollowPose {
  weight: number
  lookYaw: number
  lookPitch: number
  headYaw: number
  headPitch: number
  lostFor: number
}

export function createFaceFollowPose(): FaceFollowPose {
  return {
    weight: 0,
    lookYaw: 0,
    lookPitch: 0,
    headYaw: 0,
    headPitch: 0,
    lostFor: 0,
  }
}

/** 映像中央を正面とし、顔の位置を視線と頭の角度へ変えます。 */
export function faceFollowAngles(
  box: FaceFrameBox,
  frameWidth: number,
  frameHeight: number,
): FaceFollowAngles | null {
  if (!(frameWidth >= 1) || !(frameHeight >= 1)) return null
  if (!isFiniteBox(box)) return null
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  const horizontal = shapeOffset((centerX / frameWidth) * 2 - 1)
  const vertical = shapeOffset((centerY / frameHeight) * 2 - 1)
  // カメラ映像の左は、向き合っている相手の右です。正面を向いた顔の左を見るので、ヨーは正にします。
  const yaw = -horizontal
  // 画面の上に顔があるときは上を向く。そのままのYだと上下が逆に見えるので、ピッチの符号を反転する。
  const pitch = -vertical
  return {
    lookYaw: normalizeAngle(yaw * FACE_FOLLOW_LOOK_YAW_DEGREES),
    lookPitch: normalizeAngle(pitch * FACE_FOLLOW_LOOK_PITCH_DEGREES),
    headYaw: normalizeAngle(yaw * FACE_FOLLOW_HEAD_YAW_DEGREES),
    headPitch: normalizeAngle(pitch * FACE_FOLLOW_HEAD_PITCH_DEGREES),
  }
}

/** 正面の計算で残る負のゼロを、比較しやすいゼロへ揃えます。 */
function normalizeAngle(value: number): number {
  return value === 0 ? 0 : value
}

/** 登録があるときは一致した顔を、ないときはいちばん大きい顔を選びます。 */
export function chooseFollowBox(
  candidates: FaceFollowCandidate[],
  enrolled: boolean,
  maxDistance: number,
): FaceFrameBox | null {
  if (!enrolled) return largestFaceBox(candidates.map((candidate) => candidate.box))
  let best: FaceFollowCandidate | null = null
  for (const candidate of candidates) {
    if (!isFiniteBox(candidate.box)) continue
    if (candidate.distance === null || !Number.isFinite(candidate.distance)) continue
    if (candidate.distance > maxDistance) continue
    if (!best || candidate.distance < (best.distance ?? Infinity)) best = candidate
  }
  return best?.box ?? null
}

/** 面積が最大の枠を選び、動かない値は使いません。 */
export function largestFaceBox(boxes: FaceFrameBox[]): FaceFrameBox | null {
  let best: FaceFrameBox | null = null
  let bestArea = 0
  for (const box of boxes) {
    if (!isFiniteBox(box)) continue
    const area = box.width * box.height
    if (area > bestArea) {
      best = box
      bestArea = area
    }
  }
  return best
}

function isFiniteBox(box: FaceFrameBox): boolean {
  return [box.x, box.y, box.width, box.height].every((value) => Number.isFinite(value))
    && box.width > 0
    && box.height > 0
}

/** 中央付近の小さな揺れを消し、端までの動きを残します。 */
function shapeOffset(value: number): number {
  const clamped = Math.min(1, Math.max(-1, value))
  const magnitude = Math.abs(clamped)
  if (magnitude <= FACE_FOLLOW_DEAD_ZONE) return 0
  return Math.sign(clamped) * ((magnitude - FACE_FOLLOW_DEAD_ZONE) / (1 - FACE_FOLLOW_DEAD_ZONE))
}

function approach(current: number, target: number, rate: number, delta: number): number {
  const blend = 1 - Math.exp(-rate * delta)
  return current + (target - current) * blend
}

/**
 * 顔があるあいだは向きへ寄せます。
 * 見失った直後は最後の向きを保ち、待ちが過ぎてから影響だけをゆっくり抜きます。
 * 角度を先に正面へ戻すと、再検出のたびに頭が往復します。
 */
export function stepFaceFollow(
  pose: FaceFollowPose,
  target: FaceFollowAngles | null,
  delta: number,
): void {
  const dt = Math.min(Math.max(Number.isFinite(delta) ? delta : 0, 0), 0.05)
  if (target) {
    pose.lostFor = 0
    pose.weight = approach(pose.weight, 1, FACE_FOLLOW_TRACK_RATE, dt)
    pose.lookYaw = approach(pose.lookYaw, target.lookYaw, FACE_FOLLOW_TRACK_RATE, dt)
    pose.lookPitch = approach(pose.lookPitch, target.lookPitch, FACE_FOLLOW_TRACK_RATE, dt)
    pose.headYaw = approach(pose.headYaw, target.headYaw, FACE_FOLLOW_TRACK_RATE, dt)
    pose.headPitch = approach(pose.headPitch, target.headPitch, FACE_FOLLOW_TRACK_RATE, dt)
    return
  }
  pose.lostFor += dt
  if (pose.lostFor < FACE_FOLLOW_HOLD_SECONDS) return
  pose.weight = approach(pose.weight, 0, FACE_FOLLOW_RETURN_RATE, dt)
}
