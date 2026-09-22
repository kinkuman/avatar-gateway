// サーバー既定値とブラウザ上書きを検証し、壊れた保存値をUI状態へ持ち込みません。

import type {
  BackgroundAsset,
  UiBackgroundSettings,
  UiCameraSettings,
  UiSettings,
  UiSettingsOverrides,
  UiTouchHitboxProfile,
  UiTouchHitboxProfiles,
  UiTouchHitboxTransform,
  UiTouchInteractionSettings,
  UiTouchRegions,
  UiVector3,
  UiVoiceInputSettings,
} from '../types'

export const UI_SETTINGS_STORAGE_KEY = 'avatar-gateway.ui-settings'

export const fallbackUiSettings: UiSettings = {
  schema_version: 1,
  cast_off_enabled: false,
  show_motion_controls: false,
  show_camera_help: true,
  speech_volume: 1,
  camera: null,
  background: { file: null, fit: 'cover' },
  touch_interaction: {
    extended_regions_enabled: false,
    enabled: true,
    debug_hitboxes: false,
    edit_hitboxes: false,
    recoil_test_enabled: false,
    hitbox_profiles: {},
    regions: {
      head: true,
      ear: false,
      tail: false,
      chest: true,
      hips: true,
      groin: true,
      thigh: true,
      hand: true,
      foot: true,
    },
  },
  voice_input: {
    silence_ms: 800,
    speech_threshold: 0.02,
  },
}

const backgroundSuffixes = ['.jpg', '.jpeg', '.png', '.webp']

/** 設定値を背景ディレクトリ直下の対応画像名だけに限定します。 */
function readBackgroundFile(value: unknown): string | null | undefined {
  if (value === null) return null
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 255
    || value.includes('/')
    || value.includes('\\')
    || !backgroundSuffixes.some((suffix) => value.toLowerCase().endsWith(suffix))
  ) return undefined
  return value
}

/** 壁紙名と表示方法を、一つの整合した設定として検証します。 */
function readBackground(value: unknown): UiBackgroundSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const file = readBackgroundFile(item.file)
  if (file === undefined || (item.fit !== 'cover' && item.fit !== 'contain')) return undefined
  return { file, fit: item.fit }
}

const touchRegionNames = ['head', 'ear', 'tail', 'chest', 'hips', 'groin', 'thigh', 'hand', 'foot'] as const
const optionalTouchRegionNames = ['ear', 'tail'] as const
const touchColliderNames = [
  'head',
  'leftEar',
  'rightEar',
  'tail',
  'chest',
  'hips',
  'groin',
  'leftThigh',
  'rightThigh',
  'leftHand',
  'rightHand',
  'leftFoot',
  'rightFoot',
] as const

/** 保存済みの当たり判定座標を、ボーン近傍で扱える有限値だけに限定します。 */
function readHitboxTransform(value: unknown): UiTouchHitboxTransform | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const readVector = (raw: unknown, minimum: number, maximum: number): UiVector3 | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    const vector = raw as Record<string, unknown>
    if ([vector.x, vector.y, vector.z].some((axis) => (
      typeof axis !== 'number' || !Number.isFinite(axis) || axis < minimum || axis > maximum
    ))) return undefined
    return { x: vector.x as number, y: vector.y as number, z: vector.z as number }
  }
  const offset = readVector(item.offset, -2, 2)
  const scale = readVector(item.scale, 0.1, 5)
  return offset && scale ? { offset, scale } : undefined
}

/** VRMファイル名ごとに、既知の判定IDだけを調整値として受け入れます。 */
function readHitboxProfiles(value: unknown): UiTouchHitboxProfiles | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const profiles: UiTouchHitboxProfiles = {}
  for (const [model, rawProfile] of Object.entries(value)) {
    if (!model || model.length > 255 || model.includes('/') || model.includes('\\')) return undefined
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) return undefined
    const profile: UiTouchHitboxProfile = {}
    for (const collider of touchColliderNames) {
      const rawTransform = (rawProfile as Record<string, unknown>)[collider]
      if (rawTransform === undefined) continue
      const transform = readHitboxTransform(rawTransform)
      if (!transform) return undefined
      profile[collider] = transform
    }
    if (Object.keys(rawProfile).some((key) => !touchColliderNames.includes(key as typeof touchColliderNames[number]))) {
      return undefined
    }
    profiles[model] = profile
  }
  return profiles
}

/** 旧設定にない任意部位はOFFで補完し、従来7部位の不完全な設定は拒否します。 */
function readTouchRegions(value: unknown): UiTouchRegions | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const isOptional = (name: typeof touchRegionNames[number]) => (
    optionalTouchRegionNames.includes(name as typeof optionalTouchRegionNames[number])
  )
  if (touchRegionNames.some((name) => !isOptional(name) && typeof item[name] !== 'boolean')) return undefined
  if (optionalTouchRegionNames.some((name) => item[name] !== undefined && typeof item[name] !== 'boolean')) {
    return undefined
  }
  return Object.fromEntries(touchRegionNames.map((name) => [
    name,
    isOptional(name) ? item[name] === true : item[name],
  ])) as UiTouchRegions
}

/** ふれあい機能とデバッグ表示を、一つの整合した設定として検証します。 */
function readTouchInteraction(value: unknown): UiTouchInteractionSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const regions = readTouchRegions(item.regions)
  const hitboxProfiles = item.hitbox_profiles === undefined ? {} : readHitboxProfiles(item.hitbox_profiles)
  if (
    (item.extended_regions_enabled !== undefined && typeof item.extended_regions_enabled !== 'boolean')
    ||
    typeof item.enabled !== 'boolean'
    || typeof item.debug_hitboxes !== 'boolean'
    || (item.edit_hitboxes !== undefined && typeof item.edit_hitboxes !== 'boolean')
    || (item.recoil_test_enabled !== undefined && typeof item.recoil_test_enabled !== 'boolean')
    || !hitboxProfiles
    || !regions
  ) return undefined
  return {
    // 旧いブラウザ保存値にはこの項目がないため、安全側のfalseで読みます。
    extended_regions_enabled: item.extended_regions_enabled === true,
    enabled: item.enabled,
    debug_hitboxes: item.debug_hitboxes,
    // 編集モードは旧設定では存在しないため、表示だけの従来動作を維持します。
    edit_hitboxes: item.edit_hitboxes === true,
    // 旧いui.jsonとブラウザ保存値では、通常動作を変えないOFFとして補完します。
    recoil_test_enabled: item.recoil_test_enabled === true,
    hitbox_profiles: hitboxProfiles,
    regions,
  }
}

/** ブラウザVADが暴走しない範囲に、無音時間と音量しきい値を限定します。 */
function readVoiceInput(value: unknown): UiVoiceInputSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (
    typeof item.silence_ms !== 'number'
    || !Number.isInteger(item.silence_ms)
    || item.silence_ms < 600
    || item.silence_ms > 2000
    || typeof item.speech_threshold !== 'number'
    || !Number.isFinite(item.speech_threshold)
    || item.speech_threshold < 0.005
    || item.speech_threshold > 0.1
  ) return undefined
  return {
    silence_ms: item.silence_ms,
    speech_threshold: item.speech_threshold,
  }
}

/** JSON境界の値を有限なThree.js座標として利用できる範囲へ限定します。 */
function readVector3(value: unknown): UiVector3 | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    typeof item.x !== 'number' || !Number.isFinite(item.x) || Math.abs(item.x) > 100
    || typeof item.y !== 'number' || !Number.isFinite(item.y) || Math.abs(item.y) > 100
    || typeof item.z !== 'number' || !Number.isFinite(item.z) || Math.abs(item.z) > 100
  ) return null
  return { x: item.x, y: item.y, z: item.z }
}

/** 位置と注視点が操作可能な距離にある場合だけ、保存カメラとして採用します。 */
function readCamera(value: unknown): UiCameraSettings | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const position = readVector3(item.position)
  const target = readVector3(item.target)
  if (!position || !target) return undefined
  const distance = Math.hypot(
    position.x - target.x,
    position.y - target.y,
    position.z - target.z,
  )
  if (distance < 0.05 || distance > 50) return undefined
  return { position, target }
}

/** サーバー応答を全項目必須のUI既定値として検証します。 */
export function readUiSettings(value: unknown): UiSettings | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const camera = readCamera(item.camera)
  const background = readBackground(item.background)
  const touchInteraction = readTouchInteraction(item.touch_interaction)
  const voiceInput = readVoiceInput(item.voice_input)
  if (
    item.schema_version !== 1
    || (item.cast_off_enabled !== undefined && typeof item.cast_off_enabled !== 'boolean')
    || typeof item.show_motion_controls !== 'boolean'
    || typeof item.show_camera_help !== 'boolean'
    || typeof item.speech_volume !== 'number'
    || !Number.isFinite(item.speech_volume)
    || item.speech_volume < 0
    || item.speech_volume > 1
    || camera === undefined
    || background === undefined
    || touchInteraction === undefined
    || voiceInput === undefined
  ) return null
  return {
    schema_version: 1,
    // 旧い設定ファイルには存在しないため、表示しない安全側を採用します。
    cast_off_enabled: item.cast_off_enabled === true,
    show_motion_controls: item.show_motion_controls,
    show_camera_help: item.show_camera_help,
    speech_volume: item.speech_volume,
    camera,
    background,
    touch_interaction: touchInteraction,
    voice_input: voiceInput,
  }
}

/** localStorageは項目単位の差分だけを受け入れ、将来のサーバー既定値を不必要に隠しません。 */
export function readUiSettingsOverrides(storage: Storage): UiSettingsOverrides {
  const raw = storage.getItem(UI_SETTINGS_STORAGE_KEY)
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object') return {}
    const item = value as Record<string, unknown>
    const overrides: UiSettingsOverrides = {}
    if (typeof item.show_motion_controls === 'boolean') overrides.show_motion_controls = item.show_motion_controls
    if (typeof item.show_camera_help === 'boolean') overrides.show_camera_help = item.show_camera_help
    if (
      typeof item.speech_volume === 'number'
      && Number.isFinite(item.speech_volume)
      && item.speech_volume >= 0
      && item.speech_volume <= 1
    ) overrides.speech_volume = item.speech_volume
    if ('camera' in item) {
      const camera = readCamera(item.camera)
      if (camera !== undefined) overrides.camera = camera
    }
    if ('background' in item) {
      const background = readBackground(item.background)
      if (background !== undefined) overrides.background = background
    }
    if ('touch_interaction' in item) {
      const touchInteraction = readTouchInteraction(item.touch_interaction)
      if (touchInteraction !== undefined) overrides.touch_interaction = touchInteraction
    }
    if ('voice_input' in item) {
      const voiceInput = readVoiceInput(item.voice_input)
      if (voiceInput !== undefined) overrides.voice_input = voiceInput
    }
    return overrides
  } catch {
    return {}
  }
}

/** ブラウザ差分をJSONへ保存し、空になった場合はキー自体を削除します。 */
export function saveUiSettingsOverrides(storage: Storage, value: UiSettingsOverrides): void {
  if (Object.keys(value).length === 0) storage.removeItem(UI_SETTINGS_STORAGE_KEY)
  else storage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(value))
}

/** サーバー既定値の上へ、そのブラウザで変更した項目だけを重ねます。 */
export function mergeUiSettings(defaults: UiSettings, overrides: UiSettingsOverrides): UiSettings {
  const touchOverride = overrides.touch_interaction
  return {
    ...defaults,
    ...overrides,
    schema_version: 1,
    // キャストオフの許可はconfig/ui.jsonだけを正本とします。
    cast_off_enabled: defaults.cast_off_enabled,
    // 拡張部位の許可はconfig/ui.jsonを正本とし、localStorageからは上書きさせません。
    touch_interaction: touchOverride
      ? {
          ...touchOverride,
          extended_regions_enabled: defaults.touch_interaction.extended_regions_enabled,
        }
      : defaults.touch_interaction,
  }
}

/** 壁紙一覧APIを同一オリジンの同梱・ローカル資産だけに絞って画面へ渡します。 */
export function readBackgroundAssets(value: unknown): BackgroundAsset[] | null {
  if (!value || typeof value !== 'object') return null
  const data = (value as Record<string, unknown>).data
  if (!Array.isArray(data)) return null
  const assets: BackgroundAsset[] = []
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    const file = readBackgroundFile(item.file)
    if (
      typeof file !== 'string'
      || typeof item.url !== 'string'
      || !(
        item.url.startsWith('/assets/backgrounds/')
        || item.url.startsWith('/local-assets/backgrounds/')
      )
    ) return null
    assets.push({ file, url: item.url })
  }
  return assets
}
