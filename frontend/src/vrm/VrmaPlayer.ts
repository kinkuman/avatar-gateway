// 公式VRMAローダーとAnimationMixerを使い、主動作の再生と待機姿勢への復帰を管理します。
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMHumanBoneList, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm'
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation'

import type { MotionPlayback, MotionPlaybackMode } from '../types'

type TransitionPhase = 'idle' | 'entering' | 'playing' | 'exiting'
export type PrimaryMotionKind = 'pose' | 'animation'

interface LoadedClip {
  clip: THREE.AnimationClip
  isStatic: boolean
  staticPose: StaticVrmPose | null
  finalPose: StaticVrmPose | null
}

interface PendingMotion {
  requestId: number
  name: string
  url: string
  playback: MotionPlaybackMode
  exitDurationSeconds: number
  loadedClip: LoadedClip
  transient: boolean
}

export interface StaticVrmPose {
  rotations: Map<VRMHumanBoneName, THREE.Quaternion>
  positions: Map<VRMHumanBoneName, THREE.Vector3>
}

/** 急加速を避け、開始と停止の両端が滑らかな補間値を返します。 */
function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2
}

/** 一体のVRMに対するVRMAロード、再生、停止、遷移重みを所有します。 */
export class VrmaPlayer {
  private readonly loader = new GLTFLoader()
  private readonly mixer: THREE.AnimationMixer
  private readonly clipCache = new Map<string, LoadedClip>()
  private action: THREE.AnimationAction | null = null
  private staticPose: StaticVrmPose | null = null
  private dynamicFinalPose: StaticVrmPose | null = null
  private phase: TransitionPhase = 'idle'
  private transitionElapsed = 0
  private influence = 0
  private motionName: string | null = null
  private motionUrl: string | null = null
  private motionPlayback: MotionPlaybackMode | null = null
  private motionKind: PrimaryMotionKind | null = null
  private activeExitDuration: number
  private requestId = 0
  private pendingMotion: PendingMotion | null = null
  private transientClip: THREE.AnimationClip | null = null

  constructor(
    private readonly vrm: VRM,
    private readonly onStatus: (status: MotionPlayback) => void,
    private readonly enterDuration = 0.8,
    private readonly defaultExitDuration = 0.6,
  ) {
    this.activeExitDuration = defaultExitDuration
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.mixer.addEventListener('finished', () => this.finishDynamicMotion())
  }

  /** VRMAを必要時だけ読み込み、同じモーションの再実行ではキャッシュを使います。 */
  async play(
    name: string,
    url: string,
    playback: MotionPlaybackMode = 'auto',
    exitDurationSeconds = this.defaultExitDuration,
    transient = false,
  ): Promise<void> {
    const currentRequest = ++this.requestId
    // 連続した切替要求では、まだ始まっていない古い要求を再生せず最新だけを残します。
    this.pendingMotion = null
    // 静止ポーズは発話の文境界で完成姿勢を解除せず、同じ選択が続く間そのまま保持します。
    if (this.isHoldingStaticMotion(url, playback)) {
      this.motionName = name
      this.activeExitDuration = exitDurationSeconds
      this.onStatus({ state: 'playing', name })
      return
    }
    this.onStatus({ state: 'loading', name })
    try {
      const { clip, isStatic, staticPose, finalPose } = await this.loadClip(url, playback, !transient)
      if (currentRequest !== this.requestId) return

      // 読み込み中に同じ静止ポーズが別命令で確定した場合も、完成姿勢を再適用しません。
      if (isStatic && this.isHoldingStaticMotion(url, playback)) {
        this.motionName = name
        this.onStatus({ state: 'playing', name })
        return
      }

      const pendingMotion = {
        requestId: currentRequest,
        name,
        url,
        playback,
        exitDurationSeconds,
        loadedClip: { clip, isStatic, staticPose, finalPose },
        transient,
      }

      if (this.phase === 'idle') {
        this.startLoadedMotion(pendingMotion)
      } else {
        // 現在姿勢を突然破棄せず、設定済み終了時間で待機姿勢へ戻ってから次を始めます。
        this.pendingMotion = pendingMotion
        this.beginExit()
      }
    } catch (cause) {
      if (currentRequest !== this.requestId) return
      const message = cause instanceof Error ? cause.message : '不明なVRMA読み込みエラー'
      this.onStatus({ state: 'error', name, message })
    }
  }

  /** 再生途中でも最終姿勢から待機姿勢へ滑らかに戻します。 */
  stop(): void {
    // 読み込み途中のVRMAも無効化し、中断後に古いポーズが遅れて始まることを防ぎます。
    this.requestId += 1
    this.pendingMotion = null
    this.beginExit()
  }

  /** 次の再生要求を維持したまま、現在のモーションだけを終了補間へ移します。 */
  private beginExit(): void {
    if ((!this.action && !this.staticPose) || this.phase === 'idle') {
      this.onStatus({ state: 'idle', name: null })
      return
    }
    if (this.phase === 'exiting') return
    this.phase = 'exiting'
    this.transitionElapsed = 0
    this.onStatus({ state: 'stopping', name: this.motionName })
  }

  /** AnimationMixerを先に評価し、ランタイムが合成に使う主動作重みを返します。 */
  update(delta: number): number {
    if (this.action) this.mixer.update(delta)
    if (this.phase === 'entering') {
      this.transitionElapsed += delta
      const progress = Math.min(this.transitionElapsed / this.enterDuration, 1)
      this.influence = easeInOutCubic(progress)
      if (progress >= 1) this.phase = 'playing'
    } else if (this.phase === 'playing') {
      this.influence = 1
    } else if (this.phase === 'exiting') {
      this.transitionElapsed += delta
      const progress = Math.min(this.transitionElapsed / this.activeExitDuration, 1)
      this.influence = 1 - easeInOutCubic(progress)
      if (progress >= 1) {
        this.action?.stop()
        if (this.transientClip) this.mixer.uncacheClip(this.transientClip)
        this.action = null
        this.transientClip = null
        this.staticPose = null
        this.dynamicFinalPose = null
        this.motionName = null
        this.motionUrl = null
        this.motionPlayback = null
        this.motionKind = null
        this.phase = 'idle'
        this.influence = 0
        this.onStatus({ state: 'idle', name: null })

        const pendingMotion = this.pendingMotion
        this.pendingMotion = null
        if (pendingMotion?.requestId === this.requestId) this.startLoadedMotion(pendingMotion)
      }
    }
    return this.influence
  }

  /** 静止VRMAまたは動作終了時の固定姿勢を、ランタイムの合成入力として公開します。 */
  getStaticPose(): StaticVrmPose | null {
    return this.staticPose
  }

  /** 開始・終了補間を含め、主動作のライフサイクルが続いているかを公開します。 */
  isActive(): boolean {
    return this.phase !== 'idle'
  }

  /** 待機微動をポーズ用とアニメーション用に調整できるよう、現在の主動作種別を返します。 */
  getMotionKind(): PrimaryMotionKind | null {
    return this.phase === 'idle' ? null : this.motionKind
  }

  /** GPU側のVRMを破棄する前にAnimationMixerの参照を切ります。 */
  dispose(): void {
    this.requestId += 1
    this.pendingMotion = null
    this.staticPose = null
    this.dynamicFinalPose = null
    this.motionUrl = null
    this.motionPlayback = null
    this.transientClip = null
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.vrm.scene)
  }

  /** glTF内の先頭VRMAnimationを対象VRM用のAnimationClipへ変換します。 */
  private async loadClip(url: string, playback: MotionPlaybackMode, useCache = true): Promise<LoadedClip> {
    // 同じVRMAでも明示再生種別が違えば、静止姿勢の抽出有無を分けて保持します。
    const cacheKey = `${playback}:${url}`
    const cached = useCache ? this.clipCache.get(cacheKey) : undefined
    if (cached) return cached

    const gltf = await this.loader.loadAsync(url)
    const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined
    const animation = animations?.[0]
    if (!animation) throw new Error('VRMC_vrm_animationを含むアニメーションが見つかりません')
    const clip = createVRMAnimationClip(animation, this.vrm)
    const detectedStatic = clip.duration <= 0.0001 || clip.tracks.every((track) => track.times.length <= 1)
    const isStatic = playback === 'pose' || (playback === 'auto' && detectedStatic)
    let staticPose: StaticVrmPose | null = null
    let finalPose: StaticVrmPose | null = null

    if (isStatic) {
      // 作成元モデルの腰高を持ち込むと全身が上下するため、静止ポーズでは現在位置を維持します。
      const hips = this.vrm.humanoid.getNormalizedBoneNode('hips')
      if (hips) clip.tracks = clip.tracks.filter((track) => track.name !== `${hips.name}.position`)

      staticPose = this.extractPoseAtTime(clip, 0)
    } else {
      // LoopOnce完了後も終了補間が見えるよう、動作の最終姿勢を先に保存します。
      finalPose = this.extractPoseAtTime(clip, clip.duration)
    }

    const loaded = { clip, isStatic, staticPose, finalPose }
    if (useCache) this.clipCache.set(cacheKey, loaded)
    return loaded
  }

  /** 同じ静止VRMAが既に完成姿勢へ向かっているか保持中なら、文境界での再遷移を省きます。 */
  private isHoldingStaticMotion(url: string, playback: MotionPlaybackMode): boolean {
    return (
      this.motionUrl === url
      && this.motionPlayback === playback
      && this.staticPose !== null
      && (this.phase === 'entering' || this.phase === 'playing')
    )
  }

  /** 読込済みVRMAを、直前モーションが完全に終了した後の待機姿勢から開始します。 */
  private startLoadedMotion(pending: PendingMotion): void {
    if (pending.requestId !== this.requestId) return

    const { clip, isStatic, staticPose, finalPose } = pending.loadedClip
    this.action?.stop()
    if (this.transientClip) this.mixer.uncacheClip(this.transientClip)
    this.action = null
    this.transientClip = null
    this.staticPose = staticPose
    this.dynamicFinalPose = finalPose
    if (!isStatic) {
      this.action = this.mixer.clipAction(clip)
      this.action.setLoop(THREE.LoopOnce, 1)
      this.action.clampWhenFinished = true
      this.action.reset().play()
      if (pending.transient) this.transientClip = clip
    }
    this.motionName = pending.name
    this.motionUrl = pending.url
    this.motionPlayback = pending.playback
    this.motionKind = isStatic ? 'pose' : 'animation'
    this.activeExitDuration = pending.exitDurationSeconds
    this.phase = 'entering'
    this.transitionElapsed = 0
    this.influence = 0
    this.onStatus({ state: 'playing', name: pending.name })
  }

  /** 動的VRMAの自然終了時に最終姿勢を固定し、そこから終了補間を開始します。 */
  private finishDynamicMotion(): void {
    if (this.dynamicFinalPose) this.staticPose = this.dynamicFinalPose
    this.beginExit()
  }

  /** 公式ローダーでリターゲット済みの指定時刻の値をHumanoidボーン名へ戻します。 */
  private extractPoseAtTime(clip: THREE.AnimationClip, time: number): StaticVrmPose {
    const nodeNames = new Map<string, VRMHumanBoneName>()
    for (const bone of VRMHumanBoneList) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone)
      if (node) nodeNames.set(node.name, bone)
    }

    const rotations = new Map<VRMHumanBoneName, THREE.Quaternion>()
    const positions = new Map<VRMHumanBoneName, THREE.Vector3>()
    for (const track of clip.tracks) {
      const separator = track.name.lastIndexOf('.')
      if (separator < 0) continue
      const nodeName = track.name.slice(0, separator)
      const property = track.name.slice(separator + 1)
      const bone = nodeNames.get(nodeName)
      if (!bone || track.times.length === 0) continue

      // トラックごとの終端内に時刻を収め、補間方式を保ったまま正確な姿勢を得ます。
      const firstTime = track.times[0]
      const lastTime = track.times[track.times.length - 1]
      const sampleTime = Math.min(Math.max(time, firstTime), lastTime)
      const sample = track.createInterpolant().evaluate(sampleTime)

      if (property === 'quaternion' && sample.length >= 4) {
        rotations.set(
          bone,
          new THREE.Quaternion(sample[0], sample[1], sample[2], sample[3]).normalize(),
        )
      } else if (property === 'position' && sample.length >= 3) {
        positions.set(bone, new THREE.Vector3(sample[0], sample[1], sample[2]))
      }
    }
    return { rotations, positions }
  }
}
