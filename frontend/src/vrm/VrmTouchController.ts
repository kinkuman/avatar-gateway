// VRM標準ボーンへ透明な当たり判定を追従させ、画面上の接触を部位タグへ変換します。
import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

import type {
  UiTouchHitboxProfile,
  UiTouchInteractionSettings,
  VrmTouchColliderId,
  VrmTouchHit,
  VrmTouchRegion,
} from '../types'

type RegionShape = 'sphere' | 'box'

interface VrmTouchShapeDefinition {
  region: VrmTouchRegion
  tag: `[touch:${VrmTouchRegion}]`
  shape: RegionShape
  radius?: number
  size?: [number, number, number]
  offset: [number, number, number]
}

export interface VrmTouchRegionDefinition extends VrmTouchShapeDefinition {
  bones: VRMHumanBoneName[]
}

interface VrmCustomTouchColliderDefinition extends VrmTouchShapeDefinition {
  colliderId: VrmTouchColliderId
  bone: VRMHumanBoneName
}

type RegionMesh = THREE.Mesh & {
  userData: {
    colliderId: VrmTouchColliderId
    region: VrmTouchRegion
    tag: `[touch:${VrmTouchRegion}]`
  }
}

export const VRM_TOUCH_COLLIDER_LABELS: Readonly<Record<VrmTouchColliderId, string>> = {
  head: '頭',
  leftEar: '左耳',
  rightEar: '右耳',
  tail: '尻尾',
  chest: '胸',
  hips: '尻',
  groin: '股間',
  leftThigh: '左太もも',
  rightThigh: '右太もも',
  leftHand: '左手',
  rightHand: '右手',
  leftFoot: '左足',
  rightFoot: '右足',
}

const MIRRORED_COLLIDERS: Partial<Record<VrmTouchColliderId, VrmTouchColliderId>> = {
  leftEar: 'rightEar',
  rightEar: 'leftEar',
  leftThigh: 'rightThigh',
  rightThigh: 'leftThigh',
  leftHand: 'rightHand',
  rightHand: 'leftHand',
  leftFoot: 'rightFoot',
  rightFoot: 'leftFoot',
}

/** 同じ接触タグを送る左右メッシュへ、編集時だけ使う固有IDを割り当てます。 */
function colliderIdFor(region: VrmTouchRegion, bone: VRMHumanBoneName): VrmTouchColliderId {
  if (region === 'thigh') return bone === 'leftUpperLeg' ? 'leftThigh' : 'rightThigh'
  if (region === 'hand') return bone === 'leftHand' ? 'leftHand' : 'rightHand'
  if (region === 'foot') return bone === 'leftFoot' ? 'leftFoot' : 'rightFoot'
  if (region === 'ear') throw new Error('耳判定にはモデル固有の左右IDが必要です')
  return region
}

// 前実装の完成版と同じ形状・寸法・ローカルオフセットを移植します。
export const VRM_TOUCH_REGION_DEFINITIONS: readonly VrmTouchRegionDefinition[] = [
  {
    region: 'head',
    tag: '[touch:head]',
    bones: ['head'],
    shape: 'sphere',
    radius: 0.125,
    offset: [0, 0.09, 0],
  },
  {
    region: 'chest',
    tag: '[touch:chest]',
    bones: ['upperChest', 'chest'],
    shape: 'box',
    size: [0.22, 0.28, 0.12],
    offset: [0, 0, -0.08],
  },
  {
    region: 'hips',
    tag: '[touch:hips]',
    bones: ['hips'],
    shape: 'box',
    size: [0.36, 0.22, 0.1],
    offset: [0, -0.02, 0.14],
  },
  {
    region: 'groin',
    tag: '[touch:groin]',
    bones: ['hips'],
    shape: 'box',
    size: [0.22, 0.18, 0.1],
    offset: [0, -0.11, -0.13],
  },
  {
    region: 'thigh',
    tag: '[touch:thigh]',
    bones: ['leftUpperLeg', 'rightUpperLeg'],
    shape: 'box',
    size: [0.16, 0.6, 0.16],
    offset: [0, -0.35, 0],
  },
  {
    region: 'hand',
    tag: '[touch:hand]',
    bones: ['leftHand', 'rightHand'],
    shape: 'sphere',
    radius: 0.12,
    offset: [0, 0, 0],
  },
  {
    region: 'foot',
    tag: '[touch:foot]',
    bones: ['leftFoot', 'rightFoot'],
    shape: 'box',
    size: [0.14, 0.1, 0.26],
    offset: [0, -0.02, -0.06],
  },
]

// 人間の耳を汎用的な初期位置とし、動物耳モデルでは編集UIから頭頂へ移動できる基準値です。
const VRM_CUSTOM_TOUCH_COLLIDER_DEFINITIONS: readonly VrmCustomTouchColliderDefinition[] = [
  {
    colliderId: 'leftEar',
    region: 'ear',
    tag: '[touch:ear]',
    bone: 'head',
    shape: 'sphere',
    radius: 0.06,
    offset: [0.13, 0.09, 0],
  },
  {
    colliderId: 'rightEar',
    region: 'ear',
    tag: '[touch:ear]',
    bone: 'head',
    shape: 'sphere',
    radius: 0.06,
    offset: [-0.13, 0.09, 0],
  },
  {
    colliderId: 'tail',
    region: 'tail',
    tag: '[touch:tail]',
    bone: 'hips',
    shape: 'sphere',
    radius: 0.08,
    offset: [0, 0.05, 0.18],
  },
]

/** 描画対象とは独立した小さなメッシュ群だけをRaycasterへ渡し、安定して部位を判定します。 */
export class VrmTouchController {
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly meshes: RegionMesh[] = []
  private readonly defaultOffsets = new Map<VrmTouchColliderId, THREE.Vector3>()
  private readonly hiddenMaterial = new THREE.MeshBasicMaterial({
    color: 0xff00ff,
    transparent: true,
    opacity: 0,
    colorWrite: false,
    depthWrite: false,
  })
  private readonly debugMaterial = new THREE.MeshBasicMaterial({
    color: 0xff00ff,
    transparent: true,
    opacity: 0.25,
    wireframe: true,
    depthTest: false,
    depthWrite: false,
  })
  private readonly selectedMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd43b,
    transparent: true,
    opacity: 0.5,
    wireframe: true,
    depthTest: false,
    depthWrite: false,
  })
  private interaction: UiTouchInteractionSettings
  private selectedCollider: VrmTouchColliderId | null = null

  constructor(
    private readonly vrm: VRM,
    interaction: UiTouchInteractionSettings,
    private readonly modelKey: string,
  ) {
    this.interaction = interaction
    this.createRegions()
    this.applyProfile(this.currentProfile())
    this.refreshMaterials()
  }

  /** 設定画面とサーバー許可の変更を、VRM再読込なしで反映します。 */
  setInteraction(interaction: UiTouchInteractionSettings): void {
    this.interaction = interaction
    this.applyProfile(this.currentProfile())
    this.refreshMaterials()
  }

  /** 調整中だけ半透明ワイヤーフレームを表示し、通常利用では完全に描画しません。 */
  setDebug(enabled: boolean): void {
    this.interaction = { ...this.interaction, debug_hitboxes: enabled }
    this.refreshMaterials()
  }

  /** 編集UIへ、現在のVRMが実際に持つ有効な判定だけを安定順で返します。 */
  getEditableColliders(): VrmTouchColliderId[] {
    return this.meshes
      .filter((mesh) => this.isRegionEnabled(mesh.userData.region))
      .map((mesh) => mesh.userData.colliderId)
  }

  /** 選択色とTransformControlsの対象を一致させるため、選択状態を一か所で管理します。 */
  selectCollider(id: VrmTouchColliderId | null): THREE.Object3D | null {
    this.selectedCollider = id
    this.refreshMaterials()
    return id ? this.meshFor(id) : null
  }

  /** 編集中の画面クリックから、通常の接触送信を行わず判定IDだけを取得します。 */
  pickCollider(event: PointerEvent, camera: THREE.Camera, canvas: HTMLCanvasElement): VrmTouchColliderId | null {
    const hit = this.raycast(event, camera, canvas, this.meshes.filter((mesh) => (
      this.isRegionEnabled(mesh.userData.region)
    )))
    return hit?.userData.colliderId ?? null
  }

  /** ギズモ操作中の負数や巨大化を防ぎ、必要なら左右相手へ鏡映した値を反映します。 */
  constrainAndMirror(id: VrmTouchColliderId, mirror: boolean): void {
    const mesh = this.meshFor(id)
    if (!mesh) return
    mesh.scale.set(
      THREE.MathUtils.clamp(Math.abs(mesh.scale.x), 0.1, 5),
      THREE.MathUtils.clamp(Math.abs(mesh.scale.y), 0.1, 5),
      THREE.MathUtils.clamp(Math.abs(mesh.scale.z), 0.1, 5),
    )
    mesh.position.clampScalar(-2, 2)
    if (!mirror) return
    const counterpart = MIRRORED_COLLIDERS[id]
    const target = counterpart ? this.meshFor(counterpart) : null
    if (!target) return
    target.position.set(-mesh.position.x, mesh.position.y, mesh.position.z)
    target.scale.copy(mesh.scale)
  }

  /** 選択した判定だけをコード既定値へ戻し、他部位の調整を失わないようにします。 */
  resetCollider(id: VrmTouchColliderId, mirror: boolean): void {
    const reset = (targetId: VrmTouchColliderId) => {
      const mesh = this.meshFor(targetId)
      const offset = this.defaultOffsets.get(targetId)
      if (!mesh || !offset) return
      mesh.position.copy(offset)
      mesh.scale.setScalar(1)
    }
    reset(id)
    if (mirror && MIRRORED_COLLIDERS[id]) reset(MIRRORED_COLLIDERS[id])
  }

  /** 現在モデルの全判定を既定値へ戻し、別モデルの保存値には触れません。 */
  resetAll(): void {
    this.applyProfile({})
  }

  /** 現在モデルの既定値との差分だけを、JSON保存可能なプロファイルへ変換します。 */
  readProfile(): UiTouchHitboxProfile {
    const profile: UiTouchHitboxProfile = {}
    for (const mesh of this.meshes) {
      const id = mesh.userData.colliderId
      const defaultOffset = this.defaultOffsets.get(id)
      if (!defaultOffset) continue
      const moved = !mesh.position.equals(defaultOffset)
      const scaled = !mesh.scale.equals(new THREE.Vector3(1, 1, 1))
      if (!moved && !scaled) continue
      profile[id] = {
        offset: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
        scale: { x: mesh.scale.x, y: mesh.scale.y, z: mesh.scale.z },
      }
    }
    return profile
  }

  /** PointerEventの画面座標から、最も手前にある有効な部位を返します。 */
  hitTest(event: PointerEvent, camera: THREE.Camera, canvas: HTMLCanvasElement): VrmTouchHit | null {
    const candidates = this.meshes.filter((mesh) => this.isRegionEnabled(mesh.userData.region))
    const hit = this.raycast(event, camera, canvas, candidates)
    return hit ? {
      colliderId: hit.userData.colliderId,
      region: hit.userData.region,
      tag: hit.userData.tag,
      screenX: this.pointer.x,
    } : null
  }

  /** VRM差し替え時に子メッシュとGPU資源を残しません。 */
  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.parent?.remove(mesh)
      mesh.geometry.dispose()
    }
    this.meshes.length = 0
    this.hiddenMaterial.dispose()
    this.debugMaterial.dispose()
    this.selectedMaterial.dispose()
  }

  /** モデル固有メッシュ名ではなくNormalized Humanoidボーンへ全定義を取り付けます。 */
  private createRegions(): void {
    for (const definition of VRM_TOUCH_REGION_DEFINITIONS) {
      for (const boneName of definition.bones) {
        const bone = this.vrm.humanoid.getNormalizedBoneNode(boneName)
        if (!bone) continue
        const colliderId = colliderIdFor(definition.region, boneName)
        this.createRegionMesh(bone, definition, colliderId)
      }
    }
    for (const definition of VRM_CUSTOM_TOUCH_COLLIDER_DEFINITIONS) {
      const bone = this.vrm.humanoid.getNormalizedBoneNode(definition.bone)
      if (!bone) continue
      this.createRegionMesh(bone, definition, definition.colliderId)
    }
  }

  /** 標準ボーンとモデル固有ボーンで同じ生成・保存処理を使い、判定の挙動差を作りません。 */
  private createRegionMesh(
    parent: THREE.Object3D,
    definition: VrmTouchShapeDefinition,
    colliderId: VrmTouchColliderId,
  ): void {
    const geometry = definition.shape === 'sphere'
      ? new THREE.SphereGeometry(definition.radius ?? 0.1, 12, 8)
      : new THREE.BoxGeometry(...(definition.size ?? [0.1, 0.1, 0.1]))
    const mesh = new THREE.Mesh(geometry, this.hiddenMaterial) as unknown as RegionMesh
    mesh.name = `VRMTouchRegion_${colliderId}`
    mesh.position.fromArray(definition.offset)
    mesh.userData = { colliderId, region: definition.region, tag: definition.tag }
    parent.add(mesh)
    this.meshes.push(mesh)
    this.defaultOffsets.set(colliderId, mesh.position.clone())
  }

  /** 拡張部位が禁止されても、基本部位と任意追加の耳・尻尾は利用可能にします。 */
  private isRegionEnabled(region: VrmTouchRegion): boolean {
    const allowed = this.interaction.extended_regions_enabled
      || region === 'head'
      || region === 'ear'
      || region === 'tail'
      || region === 'hand'
    return allowed && this.interaction.regions[region]
  }

  /** デバッグ表示でも、実際に反応できない部位は表示しません。 */
  private refreshMaterials(): void {
    for (const mesh of this.meshes) {
      const visible = this.isRegionEnabled(mesh.userData.region)
        && (this.interaction.debug_hitboxes || this.interaction.edit_hitboxes)
      mesh.material = visible
        ? mesh.userData.colliderId === this.selectedCollider && this.interaction.edit_hitboxes
          ? this.selectedMaterial
          : this.debugMaterial
        : this.hiddenMaterial
    }
  }

  /** モデルキーに対応する調整がなければ、コード内の既定寸法をそのまま利用します。 */
  private currentProfile(): UiTouchHitboxProfile {
    return this.interaction.hitbox_profiles[this.modelKey] ?? {}
  }

  /** React設定の更新やモデル読込時に、保存済みローカル変換を全判定へ反映します。 */
  private applyProfile(profile: UiTouchHitboxProfile): void {
    for (const mesh of this.meshes) {
      const id = mesh.userData.colliderId
      const transform = profile[id]
      const defaultOffset = this.defaultOffsets.get(id)
      if (!defaultOffset) continue
      mesh.position.copy(defaultOffset)
      mesh.scale.setScalar(1)
      if (!transform) continue
      mesh.position.set(transform.offset.x, transform.offset.y, transform.offset.z)
      mesh.scale.set(transform.scale.x, transform.scale.y, transform.scale.z)
    }
  }

  /** 固有IDから、Normalized Bone配下にある編集対象メッシュを取得します。 */
  private meshFor(id: VrmTouchColliderId): RegionMesh | null {
    return this.meshes.find((mesh) => mesh.userData.colliderId === id) ?? null
  }

  /** 通常接触と編集選択で同じ座標変換を使い、判定順の差を作りません。 */
  private raycast(
    event: PointerEvent,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    candidates: RegionMesh[],
  ): RegionMesh | null {
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.vrm.scene.updateWorldMatrix(true, true)
    this.raycaster.setFromCamera(this.pointer, camera)
    return (this.raycaster.intersectObjects(candidates, false)[0]?.object as RegionMesh | undefined) ?? null
  }
}
