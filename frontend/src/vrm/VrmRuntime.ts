// VRM一体分の表情、視線、口パク、待機動作を状態に応じて合成します。
import * as THREE from 'three'
import { VRMHumanBoneList, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm'

import type { AvatarMotionConfig } from '../config/avatar'
import type {
  AvatarExpression,
  AvatarMorphExpression,
  AvatarState,
  VrmTouchColliderId,
  VrmTouchRegion,
} from '../types'
import { PerlinNoise2D } from './PerlinNoise2D'
import type { PrimaryMotionKind, StaticVrmPose } from './VrmaPlayer'

const MOTION_WEIGHTS: Record<AvatarState, number> = {
  idle: 1,
  generating: 0.55,
  synthesizing: 0.45,
  speaking: 0.7,
  error: 0.25,
}

const FACE_HEAT_COLOR = new THREE.Color(1, 0.3, 0.3)
const FACE_HEAT_INTENSITY = 0.35
const EXPRESSION_NAMES = ['happy', 'relaxed', 'sad', 'angry', 'surprised'] as const
type ExpressionName = AvatarMorphExpression
type ColorMaterial = THREE.Material & { color: THREE.Color }
const EXPRESSION_ALIASES: Record<ExpressionName, readonly string[]> = {
  happy: ['happy', 'joy'],
  relaxed: ['relaxed', 'fun'],
  sad: ['sad', 'sorrow'],
  angry: ['angry'],
  surprised: ['surprised', 'Surprised', 'surprise'],
}
type BlinkMode = 'half' | 'one' | 'close'
interface LocalTouchRecoilState {
  angle: number
  velocity: number
}

const LOCAL_TOUCH_COLLIDERS = new Set<VrmTouchColliderId>([
  'leftThigh',
  'rightThigh',
  'leftHand',
  'rightHand',
  'leftFoot',
  'rightFoot',
])

/** 同じseedなら同じ個性を再現できる軽量な疑似乱数を作ります。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** VRMAなどの主動作を後から挿入できるよう、差分モーションを一体単位で管理します。 */
export class VrmRuntime {
  private readonly restRotations = new Map<VRMHumanBoneName, THREE.Quaternion>()
  private readonly restPositions = new Map<VRMHumanBoneName, THREE.Vector3>()
  private readonly random: () => number
  private readonly noise: PerlinNoise2D
  private readonly timeDomainData = new Float32Array(2048)
  private readonly expressionValues = new Map<ExpressionName, number>()
  private readonly resolvedExpressionNames = new Map<ExpressionName, string>()
  private readonly faceMaterials: Array<{ material: ColorMaterial, baseColor: THREE.Color }>
  private readonly evaluatedRotations = new Map<VRMHumanBoneName, THREE.Quaternion>()
  private readonly evaluatedPositions = new Map<VRMHumanBoneName, THREE.Vector3>()
  private state: AvatarState = 'idle'
  private agentExpression: AvatarExpression = 'neutral'
  private analyser: AnalyserNode | null = null
  private motionWeight = 1
  private basePoseWeight = 0
  private primaryMotionWeight = 0
  private primaryMotionActive = false
  private primaryMotionKind: PrimaryMotionKind | null = null
  private staticPrimaryPose: StaticVrmPose | null = null
  private idleMotionScale = 1
  private idleMotionTransitionStart = 1
  private idleMotionTransitionTarget = 1
  private idleMotionTransitionElapsed = 0
  private bodyX = 0
  private bodyZ = 0
  private bodyXVelocity = 0
  private bodyZVelocity = 0
  private lastBodyJerkAt = 0
  private touchRecoilPitch = 0
  private touchRecoilRoll = 0
  private touchRecoilPitchVelocity = 0
  private touchRecoilRollVelocity = 0
  private chestTouchRecoilPitch = 0
  private chestTouchRecoilRoll = 0
  private chestTouchRecoilPitchVelocity = 0
  private chestTouchRecoilRollVelocity = 0
  private readonly localTouchRecoils = new Map<VrmTouchColliderId, LocalTouchRecoilState>()
  private touchFollowColliderId: VrmTouchColliderId | null = null
  private touchFollowRegion: VrmTouchRegion | null = null
  private touchFollowActive = false
  private touchFollowTargetX = 0
  private touchFollowTargetY = 0
  private touchFollowX = 0
  private touchFollowY = 0
  private blinkActive = false
  private blinkStartedAt = 0
  private blinkDuration = 0.3
  private blinkMode: BlinkMode = 'close'
  private blinkCloseRight = false
  private blinkGamma = 1
  private saccadeTimer = 0
  private saccadeYaw = 0
  private saccadePitch = 0
  private faceHeat = 0

  constructor(private readonly vrm: VRM, private readonly config: AvatarMotionConfig) {
    this.random = seededRandom(config.seed)
    this.noise = new PerlinNoise2D(config.seed)
    this.captureRestPose(VRMHumanBoneList)
    this.resolveExpressionNames()
    this.faceMaterials = this.captureFaceMaterials()
    if (this.vrm.lookAt) this.vrm.lookAt.autoUpdate = false
  }

  /** React側の変化をVRM再ロードなしで描画ループへ反映します。 */
  setInputs(state: AvatarState, analyser: AnalyserNode | null, expression: AvatarExpression): void {
    this.state = state
    this.analyser = analyser
    this.agentExpression = expression
  }

  /** VRM0/1とカスタム名の差をロード時に吸収し、描画中は検証済みの実名だけを使います。 */
  private resolveExpressionNames(): void {
    const manager = this.vrm.expressionManager
    if (!manager) return
    for (const name of EXPRESSION_NAMES) {
      const resolved = EXPRESSION_ALIASES[name].find((candidate) => manager.getExpression(candidate) !== null)
      if (resolved) this.resolvedExpressionNames.set(name, resolved)
    }
  }

  /** AnimationMixerが評価した姿勢を、待機Base Poseとの合成比率付きで受け取ります。 */
  setPrimaryMotionWeight(weight: number): void {
    this.primaryMotionWeight = THREE.MathUtils.clamp(weight, 0, 1)
  }

  /** Mixer評価前に微動追加前の姿勢へ戻し、一定値トラックをBase Poseで消さないようにします。 */
  preparePrimaryMotionEvaluation(): void {
    for (const [name, restRotation] of this.restRotations) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name)
      if (!node) continue
      // 主動作中は前回の評価値を復元し、Mixerが同値の再書き込みを省いても姿勢を維持します。
      const evaluatedRotation = this.primaryMotionActive
        ? this.evaluatedRotations.get(name)
        : null
      node.quaternion.copy(evaluatedRotation ?? restRotation)
      const restPosition = this.restPositions.get(name)
      const evaluatedPosition = this.primaryMotionActive
        ? this.evaluatedPositions.get(name)
        : null
      if (restPosition) node.position.copy(evaluatedPosition ?? restPosition)
    }
    this.forEachBasePoseRotation((name, x, y, z) => {
      // 静止ポーズなどで評価値を持たないボーンだけは、従来のBase Poseを評価開始点にします。
      if (!this.primaryMotionActive || !this.evaluatedRotations.has(name)) {
        this.applyRestDeltaRotation(name, x, y, z)
      }
    })
  }

  /** 静止・動的モーションごとの待機微動量を選び、終了補間中も同じ種別を維持します。 */
  setPrimaryMotionKind(kind: PrimaryMotionKind | null): void {
    if (this.primaryMotionKind === kind) return
    this.primaryMotionKind = kind
    this.primaryMotionActive = kind !== null
    this.idleMotionTransitionStart = this.idleMotionScale
    const target = kind === 'pose'
      ? this.config.motion.staticMotionIdleScale
      : kind === 'animation'
        ? this.config.motion.dynamicMotionIdleScale
        : 1
    this.idleMotionTransitionTarget = THREE.MathUtils.clamp(target, 0, 1)
    this.idleMotionTransitionElapsed = 0
  }

  /** Mixerと同じボーンを奪い合わず、静止VRMAの完成姿勢を直接合成入力にします。 */
  setStaticPrimaryPose(pose: StaticVrmPose | null): void {
    this.staticPrimaryPose = pose
  }

  /** 判定された左右の部位へ短い反動を加え、通信結果を待たず触れた実感を返します。 */
  applyTouchRecoil(colliderId: VrmTouchColliderId, region: VrmTouchRegion, screenX: number): void {
    const recoil = this.config.touchRecoil
    const strength = recoil.regionStrengths[region]
    if (colliderId === 'chest') {
      const horizontal = THREE.MathUtils.clamp(screenX, -1, 1)
      this.chestTouchRecoilPitchVelocity = THREE.MathUtils.clamp(
        this.chestTouchRecoilPitchVelocity + recoil.pitchVelocityDegreesPerSecond * strength,
        -recoil.maxPitchVelocityDegreesPerSecond,
        recoil.maxPitchVelocityDegreesPerSecond,
      )
      this.chestTouchRecoilRollVelocity = THREE.MathUtils.clamp(
        this.chestTouchRecoilRollVelocity - horizontal * recoil.rollVelocityDegreesPerSecond * strength,
        -recoil.maxRollVelocityDegreesPerSecond,
        recoil.maxRollVelocityDegreesPerSecond,
      )
      return
    }
    if (LOCAL_TOUCH_COLLIDERS.has(colliderId)) {
      const current = this.localTouchRecoils.get(colliderId) ?? { angle: 0, velocity: 0 }
      current.velocity = THREE.MathUtils.clamp(
        current.velocity + recoil.localVelocityDegreesPerSecond * strength,
        -recoil.maxLocalVelocityDegreesPerSecond,
        recoil.maxLocalVelocityDegreesPerSecond,
      )
      this.localTouchRecoils.set(colliderId, current)
      return
    }

    const horizontal = THREE.MathUtils.clamp(screenX, -1, 1)
    this.touchRecoilPitchVelocity = THREE.MathUtils.clamp(
      this.touchRecoilPitchVelocity + recoil.pitchVelocityDegreesPerSecond * strength,
      -recoil.maxPitchVelocityDegreesPerSecond,
      recoil.maxPitchVelocityDegreesPerSecond,
    )
    this.touchRecoilRollVelocity = THREE.MathUtils.clamp(
      this.touchRecoilRollVelocity - horizontal * recoil.rollVelocityDegreesPerSecond * strength,
      -recoil.maxRollVelocityDegreesPerSecond,
      recoil.maxRollVelocityDegreesPerSecond,
    )
  }

  /** 撫で始めた部位を保持し、以後のドラッグ差分を同じボーンへ合成できるようにします。 */
  beginTouchFollow(colliderId: VrmTouchColliderId, region: VrmTouchRegion): void {
    if (this.touchFollowColliderId !== colliderId) {
      this.touchFollowX = 0
      this.touchFollowY = 0
    }
    this.touchFollowColliderId = colliderId
    this.touchFollowRegion = region
    this.touchFollowActive = true
    this.touchFollowTargetX = 0
    this.touchFollowTargetY = 0
  }

  /** 画面上の移動量を上限付きの目標姿勢へ積み上げ、モデルがカーソルへ貼り付くのを防ぎます。 */
  updateTouchFollow(deltaX: number, deltaY: number): void {
    if (!this.touchFollowActive) return
    const distance = Math.max(this.config.touchFollow.inputDistancePx, 1)
    this.touchFollowTargetX = THREE.MathUtils.clamp(this.touchFollowTargetX + deltaX / distance, -1, 1)
    this.touchFollowTargetY = THREE.MathUtils.clamp(this.touchFollowTargetY + deltaY / distance, -1, 1)
  }

  /** 撫で終わりでは目標だけを中央へ戻し、現在姿勢は描画ループで滑らかに復帰させます。 */
  endTouchFollow(): void {
    this.touchFollowActive = false
    this.touchFollowTargetX = 0
    this.touchFollowTargetY = 0
  }

  /** 毎フレーム、基準姿勢に小さな差分を重ねてからVRM全体を更新します。 */
  update(delta: number, elapsed: number): void {
    this.captureEvaluatedPose()
    const blend = 1 - Math.exp(-this.config.transitionSpeed * delta)
    this.motionWeight = THREE.MathUtils.lerp(this.motionWeight, MOTION_WEIGHTS[this.state], blend)
    this.basePoseWeight = THREE.MathUtils.lerp(this.basePoseWeight, 1, blend)

    this.applyPrimaryPose()
    this.updateGaze(delta)
    this.updateBody(delta, elapsed)
    this.updateExpressions(delta, elapsed)
    this.updateFaceHeat(delta)
    this.updateMouth()
    this.vrm.update(delta)
  }

  /** プロシージャル差分を加える前に、主動作が出力したQuaternionを退避します。 */
  private captureEvaluatedPose(): void {
    if (this.staticPrimaryPose) {
      this.evaluatedRotations.clear()
      this.evaluatedPositions.clear()
      for (const [name, rotation] of this.staticPrimaryPose.rotations) {
        this.evaluatedRotations.set(name, rotation)
      }
      for (const [name, position] of this.staticPrimaryPose.positions) {
        this.evaluatedPositions.set(name, position)
      }
      return
    }

    for (const name of this.restRotations.keys()) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name)
      if (node) {
        this.evaluatedRotations.set(name, node.quaternion.clone())
        this.evaluatedPositions.set(name, node.position.clone())
      }
    }
  }

  /** モデルが持つ全Humanoidボーンの待機基準姿勢を、位置と回転の両方で保存します。 */
  private captureRestPose(names: VRMHumanBoneName[]): void {
    for (const name of names) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name)
      if (node) {
        this.restRotations.set(name, node.quaternion.clone())
        this.restPositions.set(name, node.position.clone())
      }
    }
  }

  /** 肩から指先まで全ボーンを同じ重みで補間し、親子階層の一時的な破綻を防ぎます。 */
  private applyPrimaryPose(): void {
    for (const [name, restRotation] of this.restRotations) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name)
      if (!node) continue

      const evaluatedRotation = this.evaluatedRotations.get(name)
      node.quaternion.copy(restRotation)
      if (evaluatedRotation && this.primaryMotionWeight > 0) {
        node.quaternion.slerp(evaluatedRotation, this.primaryMotionWeight)
      }

      const restPosition = this.restPositions.get(name)
      const evaluatedPosition = this.evaluatedPositions.get(name)
      if (restPosition) {
        node.position.copy(restPosition)
        if (evaluatedPosition && this.primaryMotionWeight > 0) {
          node.position.lerp(evaluatedPosition, this.primaryMotionWeight)
        }
      }
    }
  }

  /** 前実装と同じFBMとスプリングで、慣性を持つ大きめの全身運動を作ります。 */
  private updateBody(delta: number, elapsed: number): void {
    const { motion } = this.config
    const weight = this.motionWeight * this.updateIdleMotionScale(delta)
    const allowBodyJerk = this.primaryMotionKind !== 'animation'
      && this.idleMotionScale === this.idleMotionTransitionTarget
    const sway = this.updateBodySway(elapsed, Math.min(delta, 1 / 30), allowBodyJerk)
    const radians = THREE.MathUtils.degToRad
    this.applyProceduralRotation('hips', radians(sway.z * 0.04) * weight, 0, radians(sway.x * 0.1) * weight)
    this.applyProceduralRotation('spine', radians(sway.z * 0.06) * weight, 0, radians(sway.x * 0.18) * weight)
    this.applyProceduralRotation('chest', radians(sway.z * 0.08) * weight, 0, radians(sway.x * 0.22) * weight)

    const headYaw = this.noise.perlin2(elapsed * motion.headYawTimeScale, 560) * motion.headYawDegrees
    const headTilt = this.noise.perlin2(elapsed * motion.headTiltTimeScale, 840) * motion.headTiltDegrees
    const neckTilt = this.noise.perlin2(elapsed * motion.headTiltTimeScale, 917) * motion.headTiltDegrees * 0.5
    this.applyProceduralRotation('neck', 0, 0, radians(neckTilt) * weight)
    this.applyProceduralRotation('head', 0, radians(headYaw) * weight, radians(headTilt) * weight)

    // 調整済みの±76度をBase Poseとし、発話中は上に重ねる腕の微動だけを弱めます。
    const armWeight = weight * (this.state === 'speaking' ? 0.45 : 1)
    const leftArm = this.noise.perlin2(elapsed * motion.armSwayTimeScale, 1330) * motion.armSwayDegrees
    const rightArm = this.noise.perlin2(elapsed * motion.armSwayTimeScale, 1770) * motion.armSwayDegrees
    this.forEachBasePoseRotation((name, x, y, z) => this.applyBaseRotation(name, x, y, z))
    this.applyProceduralRotation('leftUpperArm', 0, 0, radians(leftArm) * armWeight)
    this.applyProceduralRotation('rightUpperArm', 0, 0, radians(rightArm) * armWeight)

    // 主動作へ小さく加算し、タッチのために再生中VRMAを停止または差し替えません。
    const recoil = this.updateTouchRecoil(Math.min(delta, 1 / 30))
    const recoilScale = this.primaryMotionActive ? this.config.touchRecoil.primaryMotionScale : 1
    const pitch = radians(recoil.pitch * recoilScale)
    const roll = radians(recoil.roll * recoilScale)
    this.applyProceduralRotation('hips', pitch * 0.15, 0, roll * 0.15)
    this.applyProceduralRotation('spine', pitch * 0.3, 0, roll * 0.3)
    this.applyProceduralRotation('chest', pitch * 0.4, 0, roll * 0.4)
    this.applyProceduralRotation('neck', pitch * 0.15, 0, roll * 0.15)
    this.updateChestTouchRecoil(Math.min(delta, 1 / 30), recoilScale)
    this.updateLocalTouchRecoils(Math.min(delta, 1 / 30), recoilScale)
    this.updateTouchFollowMotion(Math.min(delta, 1 / 30))
  }

  /** 部位に応じたボーンへ追従姿勢を加算し、待機動作やVRMAを置き換えずに撫で感を作ります。 */
  private updateTouchFollowMotion(delta: number): void {
    const colliderId = this.touchFollowColliderId
    const region = this.touchFollowRegion
    if (!colliderId || !region) return

    const speed = this.touchFollowActive
      ? this.config.touchFollow.followSpeed
      : this.config.touchFollow.returnSpeed
    const blend = 1 - Math.exp(-speed * delta)
    this.touchFollowX = THREE.MathUtils.lerp(this.touchFollowX, this.touchFollowTargetX, blend)
    this.touchFollowY = THREE.MathUtils.lerp(this.touchFollowY, this.touchFollowTargetY, blend)

    if (
      !this.touchFollowActive
      && Math.abs(this.touchFollowX) < 0.001
      && Math.abs(this.touchFollowY) < 0.001
    ) {
      this.touchFollowX = 0
      this.touchFollowY = 0
      this.touchFollowColliderId = null
      this.touchFollowRegion = null
      return
    }

    const config = this.config.touchFollow
    const scale = this.primaryMotionActive ? config.primaryMotionScale : 1
    const radians = THREE.MathUtils.degToRad
    const applyWeightedFollow = (bone: VRMHumanBoneName, maxDegrees: number, weight: number, side = 1) => {
      const pitch = radians(this.touchFollowY * maxDegrees * scale * weight)
      const roll = radians(this.touchFollowX * maxDegrees * scale * weight * side)
      this.applyProceduralRotation(bone, pitch, 0, roll)
    }

    if (region === 'head' || region === 'ear') {
      applyWeightedFollow('chest', config.headMaxDegrees, 0.1)
      applyWeightedFollow('neck', config.headMaxDegrees, 0.3)
      applyWeightedFollow('head', config.headMaxDegrees, 0.6)
      return
    }
    if (region === 'chest') {
      const chestBone = this.vrm.humanoid.getNormalizedBoneNode('upperChest') ? 'upperChest' : 'chest'
      applyWeightedFollow('spine', config.bodyMaxDegrees, 0.25)
      applyWeightedFollow(chestBone, config.bodyMaxDegrees, 0.75)
      return
    }
    if (region === 'tail' || region === 'hips' || region === 'groin') {
      applyWeightedFollow('hips', config.bodyMaxDegrees, 0.35)
      applyWeightedFollow('spine', config.bodyMaxDegrees, 0.35)
      applyWeightedFollow('chest', config.bodyMaxDegrees, 0.3)
      return
    }

    // 左右の手足はミラー軸を補正し、画面上では同じドラッグ方向へ見えるようにします。
    const side = colliderId.startsWith('left') ? -1 : 1
    if (region === 'hand') {
      const lowerArm = colliderId === 'leftHand' ? 'leftLowerArm' : 'rightLowerArm'
      const hand = colliderId === 'leftHand' ? 'leftHand' : 'rightHand'
      applyWeightedFollow(lowerArm, config.localMaxDegrees, 0.4, side)
      applyWeightedFollow(hand, config.localMaxDegrees, 0.6, side)
    } else if (region === 'thigh') {
      const upperLeg = colliderId === 'leftThigh' ? 'leftUpperLeg' : 'rightUpperLeg'
      const lowerLeg = colliderId === 'leftThigh' ? 'leftLowerLeg' : 'rightLowerLeg'
      applyWeightedFollow(upperLeg, config.localMaxDegrees, 0.7, side)
      applyWeightedFollow(lowerLeg, config.localMaxDegrees, 0.3, side)
    } else if (region === 'foot') {
      const lowerLeg = colliderId === 'leftFoot' ? 'leftLowerLeg' : 'rightLowerLeg'
      const foot = colliderId === 'leftFoot' ? 'leftFoot' : 'rightFoot'
      applyWeightedFollow(lowerLeg, config.localMaxDegrees, 0.35, side)
      applyWeightedFollow(foot, config.localMaxDegrees, 0.65, side)
    }
  }

  /** 接触反動を減衰スプリングでゼロへ戻し、短い揺り返しだけを残します。 */
  private updateTouchRecoil(delta: number): { pitch: number; roll: number } {
    ;[this.touchRecoilPitch, this.touchRecoilPitchVelocity] = this.updateTouchRecoilAxis(
      this.touchRecoilPitch,
      this.touchRecoilPitchVelocity,
      delta,
    )
    ;[this.touchRecoilRoll, this.touchRecoilRollVelocity] = this.updateTouchRecoilAxis(
      this.touchRecoilRoll,
      this.touchRecoilRollVelocity,
      delta,
    )
    return { pitch: this.touchRecoilPitch, roll: this.touchRecoilRoll }
  }

  /** 胸を押された反動だけを胸郭へ重ね、腰・背骨を直接倒す全身反動と分離します。 */
  private updateChestTouchRecoil(delta: number, recoilScale: number): void {
    ;[this.chestTouchRecoilPitch, this.chestTouchRecoilPitchVelocity] = this.updateTouchRecoilAxis(
      this.chestTouchRecoilPitch,
      this.chestTouchRecoilPitchVelocity,
      delta,
    )
    ;[this.chestTouchRecoilRoll, this.chestTouchRecoilRollVelocity] = this.updateTouchRecoilAxis(
      this.chestTouchRecoilRoll,
      this.chestTouchRecoilRollVelocity,
      delta,
    )
    if (
      this.chestTouchRecoilPitch === 0
      && this.chestTouchRecoilRoll === 0
      && this.chestTouchRecoilPitchVelocity === 0
      && this.chestTouchRecoilRollVelocity === 0
    ) return

    const radians = THREE.MathUtils.degToRad
    // 従来の腰・背骨・胸の合計寄与に近い0.85倍とし、局所化で急に弱く見えないようにします。
    const pitch = radians(this.chestTouchRecoilPitch * recoilScale * 0.85)
    const roll = radians(this.chestTouchRecoilRoll * recoilScale * 0.85)
    const chestBone = this.vrm.humanoid.getNormalizedBoneNode('upperChest') ? 'upperChest' : 'chest'
    this.applyProceduralRotation(chestBone, pitch, 0, roll)
  }

  /** 左右別の手足へ独立した反動を合成し、連続接触でも他部位の動きを上書きしません。 */
  private updateLocalTouchRecoils(delta: number, recoilScale: number): void {
    const radians = THREE.MathUtils.degToRad
    for (const [colliderId, state] of this.localTouchRecoils) {
      ;[state.angle, state.velocity] = this.updateTouchRecoilAxis(state.angle, state.velocity, delta)
      if (state.angle === 0 && state.velocity === 0) {
        this.localTouchRecoils.delete(colliderId)
        continue
      }
      const angle = radians(state.angle * recoilScale)
      const side = colliderId.startsWith('left') ? -1 : 1
      if (colliderId === 'leftHand' || colliderId === 'rightHand') {
        const lowerArm = colliderId === 'leftHand' ? 'leftLowerArm' : 'rightLowerArm'
        const hand = colliderId === 'leftHand' ? 'leftHand' : 'rightHand'
        this.applyProceduralRotation(lowerArm, angle * 0.45, 0, angle * side * 0.18)
        this.applyProceduralRotation(hand, angle * 0.9, 0, angle * side * 0.3)
      } else if (colliderId === 'leftThigh' || colliderId === 'rightThigh') {
        const upperLeg = colliderId === 'leftThigh' ? 'leftUpperLeg' : 'rightUpperLeg'
        const lowerLeg = colliderId === 'leftThigh' ? 'leftLowerLeg' : 'rightLowerLeg'
        this.applyProceduralRotation(upperLeg, angle * 0.8, 0, angle * side * 0.2)
        this.applyProceduralRotation(lowerLeg, -angle * 0.25, 0, 0)
      } else {
        const lowerLeg = colliderId === 'leftFoot' ? 'leftLowerLeg' : 'rightLowerLeg'
        const foot = colliderId === 'leftFoot' ? 'leftFoot' : 'rightFoot'
        this.applyProceduralRotation(lowerLeg, angle * 0.35, 0, angle * side * 0.12)
        this.applyProceduralRotation(foot, -angle, 0, angle * side * 0.2)
      }
    }
  }

  /** 全身反動と局所反動で同じ減衰特性を使い、戻る速さの不一致を防ぎます。 */
  private updateTouchRecoilAxis(value: number, velocity: number, delta: number): [number, number] {
    const { springStiffness, springDamping } = this.config.touchRecoil
    const acceleration = -value * springStiffness - velocity * springDamping
    const nextVelocity = velocity + acceleration * delta
    const nextValue = value + nextVelocity * delta
    if (Math.abs(nextValue) < 0.001 && Math.abs(nextVelocity) < 0.001) return [0, 0]
    return [nextValue, nextVelocity]
  }

  /** 主動作終了後だけ全身の待機微動を戻し、親ボーンから伝わる急な傾きを防ぎます。 */
  private updateIdleMotionScale(delta: number): number {
    if (this.idleMotionScale === this.idleMotionTransitionTarget) return this.idleMotionScale

    const duration = this.primaryMotionActive
      ? this.config.motion.idleMotionSuppressDurationSeconds
      : this.config.motion.idleMotionReturnDurationSeconds
    if (duration <= 0) {
      this.idleMotionScale = this.idleMotionTransitionTarget
      return this.idleMotionScale
    }

    this.idleMotionTransitionElapsed = Math.min(this.idleMotionTransitionElapsed + delta, duration)
    const progress = this.idleMotionTransitionElapsed / duration
    // 始点と終点の速度を0にし、復帰開始と完了の両方で見た目の折れを作りません。
    const eased = progress * progress * (3 - 2 * progress)
    this.idleMotionScale = THREE.MathUtils.lerp(
      this.idleMotionTransitionStart,
      this.idleMotionTransitionTarget,
      eased,
    )
    return this.idleMotionScale
  }

  /** 複数オクターブのノイズを重ね、単一周期に見えない身体目標を作ります。 */
  private fbm(time: number, offset: number): number {
    let value = 0
    let amplitude = 1
    let frequency = 1
    let maximum = 0
    for (let octave = 0; octave < 3; octave += 1) {
      value += amplitude * this.noise.perlin2(time * frequency, offset)
      maximum += amplitude
      amplitude *= 0.5
      frequency *= 2
    }
    return maximum > 0 ? value / maximum : 0
  }

  /** 通常の揺れを常時保ち、動的モーションと復帰中だけ大きなランダム反応を抑えます。 */
  private updateBodySway(elapsed: number, delta: number, allowJerk: boolean): { x: number; z: number } {
    const { motion } = this.config
    let targetX = this.fbm(elapsed * motion.bodyTimeScale, 0) * motion.bodyAmplitudeDegrees
    let targetZ = this.fbm(elapsed * motion.bodyTimeScale, 100) * motion.bodyAmplitudeDegrees
    // 抑制解除の瞬間に蓄積済みの確率判定が発火しないよう、最後の抑制時刻から間隔を取り直します。
    if (!allowJerk) {
      this.lastBodyJerkAt = elapsed
    } else if (elapsed - this.lastBodyJerkAt > 1 && this.random() < 0.05) {
      targetX *= -(4 + this.random() * 4)
      targetZ *= -(4 + this.random() * 4)
      this.lastBodyJerkAt = elapsed
    }
    ;[this.bodyX, this.bodyXVelocity] = this.spring(this.bodyX, this.bodyXVelocity, targetX, delta)
    ;[this.bodyZ, this.bodyZVelocity] = this.spring(this.bodyZ, this.bodyZVelocity, targetZ, delta)
    return { x: this.bodyX, z: this.bodyZ }
  }

  /** 急な目標変化を慣性のある動きへ変換します。 */
  private spring(current: number, velocity: number, target: number, delta: number): [number, number] {
    const acceleration = (target - current) * 2 - velocity * 0.1
    const nextVelocity = THREE.MathUtils.clamp(velocity + acceleration * delta, -5, 5)
    return [current + nextVelocity * delta, nextVelocity]
  }

  /** 腕と指のBase Poseを同じ定義から再現し、Mixer前後で姿勢が食い違うのを防ぎます。 */
  private forEachBasePoseRotation(
    apply: (name: VRMHumanBoneName, x: number, y: number, z: number) => void,
  ): void {
    const armBase = THREE.MathUtils.degToRad(this.config.basePose.upperArmAngleDegrees) * this.basePoseWeight
    apply('leftUpperArm', 0, 0, armBase)
    apply('rightUpperArm', 0, 0, -armBase)
    for (const [bone, rotation] of Object.entries(this.config.basePose.fingerRotations)) {
      const toRadians = (degrees = 0) => THREE.MathUtils.degToRad(degrees) * this.basePoseWeight
      apply(
        bone as VRMHumanBoneName,
        toRadians(rotation.x),
        toRadians(rotation.y),
        toRadians(rotation.z),
      )
    }
  }

  /** 保存したRest Poseへ差分を一度だけ加え、Mixerが読む安定した基準姿勢を作ります。 */
  private applyRestDeltaRotation(name: VRMHumanBoneName, x: number, y: number, z: number): void {
    const node = this.vrm.humanoid.getNormalizedBoneNode(name)
    const rest = this.restRotations.get(name)
    if (!node || !rest) return
    const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'))
    node.quaternion.copy(rest).multiply(delta)
  }

  /** A字姿勢などのBase Poseを主動作と補間し、VRMA側の完成姿勢を優先します。 */
  private applyBaseRotation(name: VRMHumanBoneName, x: number, y: number, z: number): void {
    const node = this.vrm.humanoid.getNormalizedBoneNode(name)
    const rest = this.restRotations.get(name)
    if (!node || !rest) return
    const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'))
    const idlePose = rest.clone().multiply(delta)
    const evaluated = this.evaluatedRotations.get(name)
    if (evaluated && this.primaryMotionWeight > 0) {
      idlePose.slerp(evaluated, this.primaryMotionWeight)
    }
    node.quaternion.copy(idlePose)
  }

  /** 主動作との補間後に微動を乗算し、VRMA中も指定強度の生命感を残します。 */
  private applyProceduralRotation(name: VRMHumanBoneName, x: number, y: number, z: number): void {
    const node = this.vrm.humanoid.getNormalizedBoneNode(name)
    if (!node) return
    const procedural = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'))
    node.quaternion.multiply(procedural)
  }

  /** VRM標準LookAtへ角度を渡し、骨型・表情型のどちらでも約5度のサッカードを出します。 */
  private updateGaze(delta: number): void {
    const lookAt = this.vrm.lookAt
    if (!lookAt) return
    const { saccade } = this.config
    if (this.saccadeTimer > saccade.minInterval && this.random() < saccade.probability) {
      this.saccadeYaw = (this.random() * 2 - 1) * saccade.radiusDegrees
      this.saccadePitch = (this.random() * 2 - 1) * saccade.radiusDegrees
      this.saccadeTimer = 0
    }
    this.saccadeTimer += delta
    const weight = THREE.MathUtils.lerp(1, 0.2, this.primaryMotionWeight)
    lookAt.yaw = this.saccadeYaw * weight
    lookAt.pitch = this.saccadePitch * weight
  }

  /** 状態表情と瞬きを滑らかに合成し、切替時の顔の跳ねを防ぎます。 */
  private updateExpressions(delta: number, elapsed: number): void {
    const manager = this.vrm.expressionManager
    if (!manager) return
    const blend = 1 - Math.exp(-5 * delta)
    const targets = this.config.expressions[this.state]
    for (const name of EXPRESSION_NAMES) {
      const current = this.expressionValues.get(name) ?? 0
      // shyは専用モーフを要求せず、参照実装と同じくhappy表情へ赤面を重ねます。
      const selectedExpression = this.agentExpression === 'shy' ? 'happy' : this.agentExpression
      const agentTarget = selectedExpression === name ? this.config.agentExpressionWeights[name] : 0
      const next = THREE.MathUtils.lerp(current, Math.max(targets[name] ?? 0, agentTarget), blend)
      this.expressionValues.set(name, next)
      const resolved = this.resolvedExpressionNames.get(name)
      if (resolved) manager.setValue(resolved, next)
    }
    this.updateBlink(manager, delta, elapsed)
  }

  /** 顔または頭のメッシュが使う色付きマテリアルと、変更前の基準色を保存します。 */
  private captureFaceMaterials(): Array<{ material: ColorMaterial, baseColor: THREE.Color }> {
    const materials = new Map<string, ColorMaterial>()
    this.vrm.scene.traverse((object) => {
      if (!(object instanceof THREE.SkinnedMesh || object instanceof THREE.Mesh)) return
      const matchesFace = /face|head/i.test(object.name)
      if (!matchesFace) return
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of objectMaterials) {
        if (!material || !this.isColorMaterial(material)) continue
        materials.set(material.uuid, material)
      }
    })
    return [...materials.values()].map((material) => ({
      material,
      baseColor: material.color.clone(),
    }))
  }

  /** Three.jsの多様なマテリアルから、色を安全に変更できるものだけを選別します。 */
  private isColorMaterial(material: THREE.Material): material is ColorMaterial {
    return 'color' in material && material.color instanceof THREE.Color
  }

  /** shy発話の開始と終了に追従し、元の肌色を失わず滑らかに赤面を出し入れします。 */
  private updateFaceHeat(delta: number): void {
    if (this.faceMaterials.length === 0) return
    const target = this.agentExpression === 'shy' ? 1 : 0
    const smoothing = 1 - Math.exp(-delta * 5)
    this.faceHeat = THREE.MathUtils.lerp(this.faceHeat, target, smoothing)
    for (const { material, baseColor } of this.faceMaterials) {
      material.color.copy(baseColor).lerp(FACE_HEAT_COLOR, this.faceHeat * FACE_HEAT_INTENSITY)
    }
  }

  /** Perlinで頻度を揺らし、通常・浅い・片目の3種類から瞬きを選びます。 */
  private updateBlink(manager: NonNullable<VRM['expressionManager']>, delta: number, elapsed: number): void {
    const config = this.config.blink
    if (!this.blinkActive) {
      const noise = this.noise.perlin2(elapsed * config.noiseTimeScale, 220)
      const rate = THREE.MathUtils.lerp(config.minRateHz, config.maxRateHz, noise * 0.5 + 0.5)
      if (this.random() < rate * delta) this.startBlink(elapsed)
    }

    let left = 0
    let right = 0
    if (this.blinkActive) {
      const progress = (elapsed - this.blinkStartedAt) / this.blinkDuration
      if (progress >= 1) {
        this.blinkActive = false
      } else {
        const raw = progress < 0.5
          ? (1 - Math.cos(progress * 2 * Math.PI)) * 0.5
          : (1 - Math.cos((1 - progress) * 2 * Math.PI)) * 0.5
        const amount = Math.pow(raw, this.blinkGamma)
        if (this.blinkMode === 'half') {
          left = right = amount * 0.2
        } else if (this.blinkMode === 'one') {
          if (this.blinkCloseRight) right = amount
          else left = amount
        } else {
          left = right = amount
        }
      }
    }

    const hasSeparateEyes = manager.getExpression('blinkLeft') != null
      && manager.getExpression('blinkRight') != null
    if (hasSeparateEyes) {
      manager.setValue('blink', 0)
      manager.setValue('blinkLeft', left)
      manager.setValue('blinkRight', right)
    } else {
      manager.setValue('blink', Math.max(left, right))
    }
  }

  /** 瞬き時間、カーブ、片目の左右を毎回変え、繰り返し感を弱めます。 */
  private startBlink(elapsed: number): void {
    const config = this.config.blink
    this.blinkActive = true
    this.blinkStartedAt = elapsed
    this.blinkDuration = config.minDuration + this.random() * (config.maxDuration - config.minDuration)
    this.blinkGamma = 0.75 + this.random() * 0.6
    const mode = this.random()
    this.blinkMode = mode < 1 / 7 ? 'half' : mode < 2 / 7 ? 'one' : 'close'
    this.blinkCloseRight = this.random() < 0.5
  }

  /** 発話中のみ周波数平均を母音へ反映し、無音区間では自然に口を閉じます。 */
  private updateMouth(): void {
    const config = this.config.lipSync
    let mouth = 0
    if (this.state === 'speaking' && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.timeDomainData)
      let peak = 0
      for (const sample of this.timeDomainData) {
        peak = Math.max(peak, Math.abs(sample))
      }

      // 波形の山を強調し、音節間の小さな値は0へ落としてパクパクする動きを作ります。
      const cooked = 1 / (1 + Math.exp(-config.sigmoidSlope * peak + config.sigmoidOffset))
      if (cooked >= config.cutoff) {
        mouth = Math.min(cooked * config.expressionScale, config.maxOpen)
      }
    }
    this.vrm.expressionManager?.setValue('aa', mouth)
  }
}
