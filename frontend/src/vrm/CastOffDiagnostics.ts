// キャストオフ対象を実データから決めるため、VRMのObject・Mesh・Material構造を一覧化します。
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

interface VrmAssetInfo {
  generator?: string
  version?: string
}

interface VrmStructureRow {
  階層パス: string
  Object名: string
  種別: string
  Mesh名: string
  Material名: string
}

interface VrmMeshDetailRow {
  Object名: string
  Material名: string
  頂点数: number
  Index数: number
  三角形数: number
  Position指紋: string
  UV指紋: string
  Index指紋: string
  alphaTest: number
  transparent: boolean
  opacity: number
  Texture名: string
  Textureサイズ: string
  Texture指紋: string
  Alpha範囲: string
  Alpha250未満率: string
}

type GeometryAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute
type MapMaterial = THREE.Material & { map: THREE.Texture | null }

interface TexturePixelDetails {
  fingerprint: string
  alphaRange: string
  transparentRate: string
}

const texturePixelDetailsCache = new WeakMap<THREE.Texture, TexturePixelDetails>()

/** 同名Objectを区別し、非表示対象を安全に特定できるよう階層パスを組み立てます。 */
function getObjectPath(object: THREE.Object3D): string {
  const segments: string[] = []
  let current: THREE.Object3D | null = object

  while (current) {
    segments.unshift(current.name || `(名前なし:${current.type})`)
    current = current.parent
  }

  return segments.join('/')
}

/** Material未命名のモデルでも調査できるよう、型名を代替表示として残します。 */
function getMaterialNames(mesh: THREE.Mesh): string {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials
    .map((material, index) => material.name || `(名前なし:${material.type}, index=${index})`)
    .join(', ')
}

/** 頂点数が同じ別形状も区別できるよう、属性値から比較用の決定的な指紋を作ります。 */
function fingerprintAttribute(attribute: GeometryAttribute | null | undefined): string {
  if (!attribute) return '-'

  let hash = 0x811c9dc5
  const bytes = new DataView(new ArrayBuffer(8))
  const componentReaders = [
    (index: number) => attribute.getX(index),
    (index: number) => attribute.getY(index),
    (index: number) => attribute.getZ(index),
    (index: number) => attribute.getW(index),
  ]

  for (let index = 0; index < attribute.count; index += 1) {
    for (let component = 0; component < Math.min(attribute.itemSize, componentReaders.length); component += 1) {
      bytes.setFloat64(0, componentReaders[component](index), true)
      for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
        hash ^= bytes.getUint8(byteIndex)
        hash = Math.imul(hash, 0x01000193)
      }
    }
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** MToonを含むMaterialから、比較可能なベーステクスチャだけを安全に取得します。 */
function getMaterialMap(material: THREE.Material): THREE.Texture | null {
  if (!('map' in material)) return null
  return (material as MapMaterial).map
}

/** ImageBitmapとHTMLImageElementのどちらでも、テクスチャ寸法を同じ形式で表示します。 */
function getTextureSize(texture: THREE.Texture | null): string {
  if (!texture) return '-'
  const image = texture.image as { width?: unknown, height?: unknown } | undefined
  if (typeof image?.width !== 'number' || typeof image.height !== 'number') return '(不明)'
  return `${image.width}x${image.height}`
}

/** 肌マスクの差を検出できるよう、縮小画像のRGBAとAlpha分布を比較用に要約します。 */
function getTexturePixelDetails(texture: THREE.Texture | null): TexturePixelDetails {
  if (!texture) return { fingerprint: '-', alphaRange: '-', transparentRate: '-' }
  const cached = texturePixelDetailsCache.get(texture)
  if (cached) return cached

  try {
    const image = texture.image as CanvasImageSource & { width?: unknown, height?: unknown }
    if (typeof image?.width !== 'number' || typeof image.height !== 'number') throw new Error('画像寸法なし')
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.min(image.width, 128))
    canvas.height = Math.max(1, Math.min(image.height, 128))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2Dなし')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 0x811c9dc5
    let alphaMin = 255
    let alphaMax = 0
    let transparentPixels = 0

    for (let index = 0; index < pixels.length; index += 1) {
      hash ^= pixels[index]
      hash = Math.imul(hash, 0x01000193)
      if (index % 4 !== 3) continue
      const alpha = pixels[index]
      alphaMin = Math.min(alphaMin, alpha)
      alphaMax = Math.max(alphaMax, alpha)
      if (alpha < 250) transparentPixels += 1
    }

    const pixelCount = pixels.length / 4
    const details = {
      fingerprint: (hash >>> 0).toString(16).padStart(8, '0'),
      alphaRange: `${alphaMin}-${alphaMax}`,
      transparentRate: `${((transparentPixels / pixelCount) * 100).toFixed(2)}%`,
    }
    texturePixelDetailsCache.set(texture, details)
    return details
  } catch {
    const unavailable = { fingerprint: '(取得不可)', alphaRange: '(取得不可)', transparentRate: '(取得不可)' }
    texturePixelDetailsCache.set(texture, unavailable)
    return unavailable
  }
}

/** 服あり・服なしモデルの実形状と透明設定を、名前に依存せず比較できる行へ変換します。 */
function getMeshDetailRows(mesh: THREE.Mesh): VrmMeshDetailRow[] {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const position = mesh.geometry.getAttribute('position')
  const uv = mesh.geometry.getAttribute('uv')
  const index = mesh.geometry.index
  const vertexCount = position?.count ?? 0
  const indexCount = index?.count ?? 0
  const triangleCount = Math.floor((index ? indexCount : vertexCount) / 3)
  const positionFingerprint = fingerprintAttribute(position)
  const uvFingerprint = fingerprintAttribute(uv)
  const indexFingerprint = fingerprintAttribute(index)

  return materials.map((material) => {
    const texture = getMaterialMap(material)
    const texturePixels = getTexturePixelDetails(texture)
    return {
      Object名: mesh.name || '(名前なし)',
      Material名: material.name || `(名前なし:${material.type})`,
      頂点数: vertexCount,
      Index数: indexCount,
      三角形数: triangleCount,
      Position指紋: positionFingerprint,
      UV指紋: uvFingerprint,
      Index指紋: indexFingerprint,
      alphaTest: material.alphaTest,
      transparent: material.transparent,
      opacity: material.opacity,
      Texture名: texture?.name || '(名前なし)',
      Textureサイズ: getTextureSize(texture),
      Texture指紋: texturePixels.fingerprint,
      Alpha範囲: texturePixels.alphaRange,
      Alpha250未満率: texturePixels.transparentRate,
    }
  })
}

/** 実モデルに存在する名前だけを根拠に部位判定を設計できるよう、ブラウザのConsoleへ表形式で出力します。 */
export function logCastOffVrmStructure(vrm: VRM, assetInfo?: VrmAssetInfo): void {
  const rows: VrmStructureRow[] = []
  const meshDetailRows: VrmMeshDetailRow[] = []

  vrm.scene.traverse((object) => {
    const mesh = object instanceof THREE.Mesh ? object : null
    rows.push({
      階層パス: getObjectPath(object),
      Object名: object.name || '(名前なし)',
      種別: object.type,
      Mesh名: mesh ? (mesh.name || '(名前なし)') : '-',
      Material名: mesh ? getMaterialNames(mesh) : '-',
    })
    if (mesh) meshDetailRows.push(...getMeshDetailRows(mesh))
  })

  console.group(`[キャストオフ調査] VRM構造: ${rows.length} Objects`)
  console.info('[キャストオフ調査] glTF asset情報（VRoid判定には使用しません）', {
    generator: assetInfo?.generator ?? '(不明)',
    version: assetInfo?.version ?? '(不明)',
  })
  console.table(rows)
  console.info('[キャストオフ調査] Mesh詳細（服あり版と服なし版の同名Materialを比較してください）')
  console.table(meshDetailRows)
  console.groupEnd()
}
