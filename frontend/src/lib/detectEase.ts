// 暗い映像だけ検出用に明るくします。本人判定の特徴量は元の映像から計算します。

export const DETECT_INPUT_SIZE = 224
export const DETECT_SCORE_THRESHOLD = 0.5
export const DETECT_EASE_INPUT_SIZE = 320
export const DETECT_EASE_SCORE_THRESHOLD = 0.4

/** これより明るい中央部は、そのまま検出します。 */
export const DETECT_EASE_LUMA_FLOOR = 108
/** 暗い中央部を寄せる目安の輝度です。 */
export const DETECT_EASE_LUMA_TARGET = 128
/** 持ち上げの上限です。1未満で明るくなります。 */
export const DETECT_EASE_MIN_EXPONENT = 0.62

export interface DetectorTune {
  inputSize: number
  scoreThreshold: number
}

export interface SampleRegion {
  x: number
  y: number
  width: number
  height: number
}

/** 設定がオンのときだけ、入力を広げて弱い検出も残します。 */
export function detectorTune(ease: boolean): DetectorTune {
  if (!ease) {
    return { inputSize: DETECT_INPUT_SIZE, scoreThreshold: DETECT_SCORE_THRESHOLD }
  }
  return { inputSize: DETECT_EASE_INPUT_SIZE, scoreThreshold: DETECT_EASE_SCORE_THRESHOLD }
}

/** 映像の中央付近だけを見て、端の明るさで誤判しないようにします。 */
export function centerSampleRegion(width: number, height: number): SampleRegion {
  const x = Math.floor(width * 0.25)
  const y = Math.floor(height * 0.25)
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(width * 0.75) - x),
    height: Math.max(1, Math.ceil(height * 0.75) - y),
  }
}

/** ピクセル並びを間引いて、Rec.709の輝度平均を返します。 */
export function averageLuma(data: Uint8ClampedArray, step = 8): number {
  if (data.length < 4) return 255
  const stride = Math.max(1, step)
  let sum = 0
  let count = 0
  const pixels = Math.floor(data.length / 4)
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const index = pixel * 4
    sum += (0.2126 * data[index]) + (0.7152 * data[index + 1]) + (0.0722 * data[index + 2])
    count += 1
  }
  return count === 0 ? 255 : sum / count
}

/** 明るい映像では null。暗いときだけ、1未満の指数で明るくします。 */
export function gammaExponentForLuma(mean: number): number | null {
  if (!Number.isFinite(mean) || mean >= DETECT_EASE_LUMA_FLOOR) return null
  const safe = Math.min(DETECT_EASE_LUMA_FLOOR - 1, Math.max(mean, 24))
  const raw = Math.log(DETECT_EASE_LUMA_TARGET / 255) / Math.log(safe / 255)
  if (!Number.isFinite(raw)) return null
  const exponent = Math.min(1, Math.max(DETECT_EASE_MIN_EXPONENT, raw))
  if (exponent > 0.97) return null
  return exponent
}

/** 0は0、255は255のまま、中間調だけを持ち上げます。 */
export function applyGammaByte(value: number, exponent: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(exponent)) return 0
  const normalized = Math.min(1, Math.max(0, value / 255))
  return Math.round(Math.min(255, 255 * (normalized ** exponent)))
}
