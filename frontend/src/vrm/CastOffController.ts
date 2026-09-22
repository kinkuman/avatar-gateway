// 衣装Meshだけを識別し、キャストオフ時の飛翔とPUTON時の完全復元を管理します。
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

type CastOffPart = 'tops' | 'bottoms' | 'shoes' | 'accessory'

interface FlightConfig {
  offset: THREE.Vector3
  rotation: THREE.Vector3
}

interface CastOffTarget {
  mesh: THREE.SkinnedMesh
  flightRoot: THREE.Group
  originalParent: THREE.Object3D
  originalBindMode: THREE.SkinnedMesh['bindMode']
  originalBindMatrix: THREE.Matrix4
  originalBindMatrixInverse: THREE.Matrix4
  basePosition: THREE.Vector3
  flightOffset: THREE.Vector3
  flightRotation: THREE.Vector3
}

const CAST_OFF_DURATION_SECONDS = 1.2
const FLIGHT_CONFIGS: Record<CastOffPart, readonly FlightConfig[]> = {
  tops: [
    {
      offset: new THREE.Vector3(1.45, 1.05, 0.3),
      rotation: new THREE.Vector3(3.8, 5.4, -4.6),
    },
    {
      offset: new THREE.Vector3(-1.35, 1.2, 0.4),
      rotation: new THREE.Vector3(-4.2, 4.8, 5.1),
    },
  ],
  bottoms: [
    {
      offset: new THREE.Vector3(-1.4, 0.65, 0.35),
      rotation: new THREE.Vector3(-4.5, 5.2, 4.7),
    },
  ],
  shoes: [
    {
      offset: new THREE.Vector3(1.25, -0.65, 0.5),
      rotation: new THREE.Vector3(5.6, -4.8, -4.2),
    },
  ],
  accessory: [
    {
      offset: new THREE.Vector3(0.55, 1.55, 0.55),
      rotation: new THREE.Vector3(5.2, 4.6, -5.8),
    },
    {
      offset: new THREE.Vector3(-0.75, 1.4, 0.45),
      rotation: new THREE.Vector3(-4.8, 5.5, 5.1),
    },
  ],
}

/** Ear・Tailを名前に持つ身体アクセサリーだけを、Accessoryの飛翔対象から保護します。 */
function isProtectedBodyAccessory(materialName: string): boolean {
  const tokens = materialName.split(/[_\s()]+/)
  return tokens.some((token) => {
    const lowerToken = token.toLowerCase()
    return lowerToken === 'ear'
      || lowerToken === 'tail'
      || token.includes('Ear')
      || token.includes('Tail')
  })
}

/** VRoid系Materialから衣装を選び、耳・尻尾だけは身体の一部として除外します。 */
function identifyCastOffPart(mesh: THREE.Mesh): CastOffPart | null {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const materialNames = materials.map((material) => material.name)
  const lowerMaterialNames = materialNames.map((name) => name.toLowerCase())

  if (lowerMaterialNames.some((name) => name.includes('_tops_'))) return 'tops'
  if (lowerMaterialNames.some((name) => name.includes('_bottoms_'))) return 'bottoms'
  if (lowerMaterialNames.some((name) => name.includes('_shoes_'))) return 'shoes'
  if (materialNames.some((name) => /(?:^|_)Accessory_/i.test(name) && !isProtectedBodyAccessory(name))) {
    return 'accessory'
  }
  return null
}

/** VRMの身体動作から独立して衣装全体を飛ばし、再着用時には元のTransformへ戻します。 */
export class CastOffController {
  private readonly targets: CastOffTarget[] = []
  private elapsedSeconds: number | null = null
  private onComplete: (() => void) | null = null

  constructor(vrm: VRM) {
    const matchedMeshes: Array<{ mesh: THREE.SkinnedMesh, part: CastOffPart }> = []
    vrm.scene.traverse((object) => {
      if (!(object instanceof THREE.SkinnedMesh)) return
      const part = identifyCastOffPart(object)
      if (!part) return
      matchedMeshes.push({ mesh: object, part })
    })

    const partCounts = new Map<CastOffPart, number>()
    for (const { mesh, part } of matchedMeshes) {
      const originalParent = mesh.parent
      if (!originalParent) continue
      const variantIndex = partCounts.get(part) ?? 0
      partCounts.set(part, variantIndex + 1)
      const variants = FLIGHT_CONFIGS[part]
      const config = variants[variantIndex % variants.length]

      // Mesh中心を回転軸にすることで、身体の原点を中心に大回転する不自然さを避けます。
      mesh.updateWorldMatrix(true, false)
      const worldCenter = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3())
      originalParent.updateWorldMatrix(true, false)
      const localCenter = originalParent.worldToLocal(worldCenter)
      const flightRoot = new THREE.Group()
      flightRoot.name = `CastOffFlight_${mesh.name || part}`
      flightRoot.position.copy(localCenter)
      originalParent.add(flightRoot)
      flightRoot.attach(mesh)

      this.targets.push({
        mesh,
        flightRoot,
        originalParent,
        originalBindMode: mesh.bindMode,
        originalBindMatrix: mesh.bindMatrix.clone(),
        originalBindMatrixInverse: mesh.bindMatrixInverse.clone(),
        basePosition: localCenter.clone(),
        flightOffset: config.offset.clone(),
        flightRotation: config.rotation.clone(),
      })
    }
  }

  /** 対象衣装がないモデルでは、身体Meshを推測で操作せずUIを無効化できるようにします。 */
  hasTargets(): boolean {
    return this.targets.length > 0
  }

  /** 開始直後から衣装を別方向へ飛ばし、完了後だけ描画対象から外します。 */
  startCastOff(onComplete: () => void): boolean {
    if (!this.hasTargets() || this.elapsedSeconds !== null) return false

    for (const target of this.targets) {
      this.restoreFlightRoot(target)
      // Attachedでは親Transformがskin行列に相殺されるため、飛翔中だけモデル行列を独立させます。
      target.mesh.updateWorldMatrix(true, false)
      target.mesh.bindMatrix.copy(target.mesh.matrixWorld)
      target.mesh.bindMatrixInverse.copy(target.mesh.matrixWorld).invert()
      target.mesh.bindMode = THREE.DetachedBindMode
      target.mesh.visible = true
    }
    this.elapsedSeconds = 0
    this.onComplete = onComplete
    return true
  }

  /** PUTONでは飛翔途中も取り消し、位置と回転を残さず即座に再表示します。 */
  putOn(): void {
    this.elapsedSeconds = null
    this.onComplete = null
    for (const target of this.targets) {
      this.restoreFlightRoot(target)
      this.restoreSkinBinding(target)
      target.mesh.visible = true
    }
  }

  /** フレーム時間から飛翔を評価し、端末速度にかかわらず同じ時間で完了させます。 */
  update(deltaSeconds: number): void {
    if (this.elapsedSeconds === null) return

    this.elapsedSeconds += deltaSeconds
    const progress = Math.min(this.elapsedSeconds / CAST_OFF_DURATION_SECONDS, 1)
    const travel = 1 - Math.pow(1 - progress, 1.35)
    const shrinkProgress = THREE.MathUtils.clamp((progress - 0.55) / 0.45, 0, 1)
    const scale = 1 - 0.7 * shrinkProgress * shrinkProgress

    for (const target of this.targets) {
      target.flightRoot.position.copy(target.basePosition).addScaledVector(target.flightOffset, travel)
      target.flightRoot.rotation.set(
        target.flightRotation.x * progress,
        target.flightRotation.y * progress,
        target.flightRotation.z * progress,
      )
      target.flightRoot.scale.setScalar(scale)
    }

    if (progress < 1) return

    for (const target of this.targets) {
      target.mesh.visible = false
      // 非表示中に元へ戻し、次のPUTONで一瞬だけ飛翔先が映ることを防ぎます。
      this.restoreFlightRoot(target)
      this.restoreSkinBinding(target)
    }
    this.elapsedSeconds = null
    const complete = this.onComplete
    this.onComplete = null
    complete?.()
  }

  /** コントローラー破棄時にも、共有VRMへ飛翔Transformを残しません。 */
  dispose(): void {
    this.putOn()
    for (const target of this.targets) {
      target.originalParent.attach(target.mesh)
      target.originalParent.remove(target.flightRoot)
    }
  }

  /** 専用Groupだけを初期化し、モデル固有のMesh TransformやSkeletonには触れません。 */
  private restoreFlightRoot(target: CastOffTarget): void {
    target.flightRoot.position.copy(target.basePosition)
    target.flightRoot.quaternion.identity()
    target.flightRoot.scale.setScalar(1)
  }

  /** PUTON後のスキニング計算を、VRM読み込み時の行列とBindModeへ正確に戻します。 */
  private restoreSkinBinding(target: CastOffTarget): void {
    target.mesh.bindMatrix.copy(target.originalBindMatrix)
    target.mesh.bindMatrixInverse.copy(target.originalBindMatrixInverse)
    target.mesh.bindMode = target.originalBindMode
  }
}
