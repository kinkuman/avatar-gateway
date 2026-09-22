// キャラクターごとの生命感や表情の差をコード本体から分離する設定です。
import type { AvatarMorphExpression, AvatarState, VrmTouchRegion } from '../types'

export interface MotionRange {
  bodyTimeScale: number
  bodyAmplitudeDegrees: number
  headYawDegrees: number
  headYawTimeScale: number
  headTiltDegrees: number
  headTiltTimeScale: number
  dynamicMotionIdleScale: number
  staticMotionIdleScale: number
  idleMotionSuppressDurationSeconds: number
  idleMotionReturnDurationSeconds: number
  armSwayDegrees: number
  armSwayTimeScale: number
}

export interface BlinkConfig {
  noiseTimeScale: number
  minRateHz: number
  maxRateHz: number
  minDuration: number
  maxDuration: number
}

export interface SaccadeConfig {
  minInterval: number
  probability: number
  radiusDegrees: number
}

export interface BoneRotationDegrees {
  x?: number
  y?: number
  z?: number
}

export interface BasePoseConfig {
  upperArmAngleDegrees: number
  fingerRotations: Record<string, BoneRotationDegrees>
}

export interface LipSyncConfig {
  maxOpen: number
  cutoff: number
  expressionScale: number
  sigmoidSlope: number
  sigmoidOffset: number
}

/** 接触部位ごとの強さと、短い反動を戻すスプリング特性をまとめます。 */
export interface TouchRecoilConfig {
  pitchVelocityDegreesPerSecond: number
  rollVelocityDegreesPerSecond: number
  maxPitchVelocityDegreesPerSecond: number
  maxRollVelocityDegreesPerSecond: number
  localVelocityDegreesPerSecond: number
  maxLocalVelocityDegreesPerSecond: number
  springStiffness: number
  springDamping: number
  primaryMotionScale: number
  regionStrengths: Record<VrmTouchRegion, number>
}

/** 撫でる方向への追従量と、遅れて追い戻る時間感覚をまとめます。 */
export interface TouchFollowConfig {
  inputDistancePx: number
  headMaxDegrees: number
  bodyMaxDegrees: number
  localMaxDegrees: number
  followSpeed: number
  returnSpeed: number
  primaryMotionScale: number
}

export interface AvatarCameraConfig {
  fovDegrees: number
  fitPadding: number
  targetHeightRatio: number
  minDistance: number
  maxDistance: number
  dampingFactor: number
}

export interface AvatarMotionConfig {
  seed: number
  transitionSpeed: number
  blink: BlinkConfig
  saccade: SaccadeConfig
  basePose: BasePoseConfig
  lipSync: LipSyncConfig
  touchRecoil: TouchRecoilConfig
  touchFollow: TouchFollowConfig
  motion: MotionRange
  agentExpressionWeights: Record<AvatarMorphExpression, number>
  expressions: Record<AvatarState, Partial<Record<AvatarMorphExpression, number>>>
}

// 前実装で調整済みの値を使い、手を握り込まず自然に下ろします。
const fingerRelaxPose: Record<string, BoneRotationDegrees> = {
  leftIndexProximal: { x: 8, y: 10, z: 20 },
  leftIndexIntermediate: { x: 10, y: -8, z: 20 },
  leftIndexDistal: { x: 8, y: 6, z: 20 },
  leftMiddleProximal: { x: 7, y: 8, z: 20 },
  leftMiddleIntermediate: { x: 9, y: -6, z: 20 },
  leftMiddleDistal: { x: 7, y: 5, z: 20 },
  leftRingProximal: { x: 6, y: 7, z: 20 },
  leftRingIntermediate: { x: 8, y: -5, z: 20 },
  leftRingDistal: { x: 6, y: 4, z: 20 },
  leftLittleProximal: { x: 5, y: 6, z: 20 },
  leftLittleIntermediate: { x: 7, y: -4, z: 20 },
  leftLittleDistal: { x: 5, y: 3, z: 20 },
  leftThumbMetacarpal: { x: 26, y: 28, z: 10 },
  leftThumbProximal: { x: 28, y: 22, z: 10 },
  leftThumbDistal: { x: 26, y: 20, z: 10 },
  rightIndexProximal: { x: 8, y: -10, z: -20 },
  rightIndexIntermediate: { x: 10, y: 8, z: -20 },
  rightIndexDistal: { x: 8, y: -6, z: -20 },
  rightMiddleProximal: { x: 7, y: -8, z: -20 },
  rightMiddleIntermediate: { x: 9, y: 6, z: -20 },
  rightMiddleDistal: { x: 7, y: -5, z: -20 },
  rightRingProximal: { x: 6, y: -7, z: -20 },
  rightRingIntermediate: { x: 8, y: 5, z: -20 },
  rightRingDistal: { x: 6, y: -4, z: -20 },
  rightLittleProximal: { x: 5, y: -6, z: -20 },
  rightLittleIntermediate: { x: 7, y: 4, z: -20 },
  rightLittleDistal: { x: 5, y: -3, z: -20 },
  rightThumbMetacarpal: { x: 26, y: -28, z: -10 },
  rightThumbProximal: { x: 28, y: -22, z: -10 },
  rightThumbDistal: { x: 26, y: -20, z: -10 },
}

/** 初期キャラクターの動きを控えめに保ち、会話内容を邪魔しない既定値を提供します。 */
export const defaultAvatarMotion: AvatarMotionConfig = {
  seed: 604,
  transitionSpeed: 3.2,
  blink: {
    noiseTimeScale: 0.07,
    minRateHz: 0.2,
    maxRateHz: 0.33,
    minDuration: 0.2,
    maxDuration: 0.6,
  },
  saccade: {
    minInterval: 0.5,
    probability: 0.05,
    radiusDegrees: 5,
  },
  basePose: {
    upperArmAngleDegrees: 76,
    fingerRotations: fingerRelaxPose,
  },
  lipSync: {
    maxOpen: 0.6,
    cutoff: 0.1,
    expressionScale: 0.5,
    sigmoidSlope: 45,
    sigmoidOffset: 5,
  },
  // 触れた実感だけを短く返し、会話中の主動作やポーズを崩さない小さな反動にします。
  touchRecoil: {
    pitchVelocityDegreesPerSecond: -42,
    rollVelocityDegreesPerSecond: 30,
    maxPitchVelocityDegreesPerSecond: 170,
    maxRollVelocityDegreesPerSecond: 150,
    localVelocityDegreesPerSecond: 180,
    maxLocalVelocityDegreesPerSecond: 220,
    springStiffness: 90,
    springDamping: 15,
    primaryMotionScale: 1,
    regionStrengths: {
      head: 1,
      ear: 0.8,
      tail: 0.6,
      chest: 3.0,
      hips: 0.75,
      groin: 0.7,
      thigh: 0.6,
      hand: 0.5,
      foot: 0.45,
    },
  },
  // カーソルへ貼り付かず少し遅れて追い、指を離した後は約0.3秒かけて自然に戻します。
  touchFollow: {
    inputDistancePx: 90,
    headMaxDegrees: 5,
    bodyMaxDegrees: 2,
    localMaxDegrees: 3,
    followSpeed: 9,
    returnSpeed: 4,
    primaryMotionScale: 0.45,
  },
  // モーフ形状はVRMごとに異なるため、感情の強さではなくモデル固有の完成形として調整します。
  agentExpressionWeights: {
    happy: 1,
    relaxed: 0.8,
    sad: 0.8,
    angry: 0.8,
    surprised: 0.8,
  },
  motion: {
    bodyTimeScale: 0.6,
    bodyAmplitudeDegrees: 20,
    headYawDegrees: 20,
    headYawTimeScale: 0.22,
    headTiltDegrees: 15,
    headTiltTimeScale: 0.17,
    dynamicMotionIdleScale: 0.2,
    staticMotionIdleScale: 0.5,
    idleMotionSuppressDurationSeconds: 0.35,
    idleMotionReturnDurationSeconds: 1.2,
    armSwayDegrees: 2,
    armSwayTimeScale: 0.9,
  },
  expressions: {
    // neutral以外の表情は口元も変形するため、感情制御を実装するまでは自動適用しません。
    idle: {},
    generating: {},
    synthesizing: {},
    speaking: {},
    error: {},
  },
}

/** 全身確認と上半身確認をマウス操作で行えるカメラの既定値です。 */
export const defaultAvatarCamera: AvatarCameraConfig = {
  fovDegrees: 30,
  fitPadding: 1.08,
  targetHeightRatio: 0.58,
  // 表情や目のモーフを接写確認でき、かつモデル内部へ入りにくい最短距離を残します。
  minDistance: 0.1,
  maxDistance: 8,
  dampingFactor: 0.08,
}
