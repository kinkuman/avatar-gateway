import assert from 'node:assert/strict'

import {
  DETECT_EASE_LUMA_FLOOR,
  DETECT_EASE_MIN_EXPONENT,
  applyGammaByte,
  averageLuma,
  centerSampleRegion,
  detectorTune,
  gammaExponentForLuma,
} from '../src/lib/detectEase.ts'

const plain = detectorTune(false)
assert.equal(plain.inputSize, 224)
assert.equal(plain.scoreThreshold, 0.5)

const eased = detectorTune(true)
assert.equal(eased.inputSize, 320)
assert.equal(eased.inputSize % 32, 0)
assert.equal(eased.scoreThreshold, 0.4)

const region = centerSampleRegion(640, 480)
assert.equal(region.x, 160)
assert.equal(region.y, 120)
assert.ok(region.x + region.width <= 640)
assert.ok(region.y + region.height <= 480)
assert.ok(region.width > 0)
assert.ok(region.height > 0)

const bright = new Uint8ClampedArray([200, 200, 200, 255, 210, 210, 210, 255])
assert.ok(averageLuma(bright, 1) > DETECT_EASE_LUMA_FLOOR)
const dark = new Uint8ClampedArray([20, 20, 20, 255, 30, 30, 30, 255])
assert.ok(averageLuma(dark, 1) < 40)
assert.equal(averageLuma(new Uint8ClampedArray(), 1), 255)

assert.equal(gammaExponentForLuma(DETECT_EASE_LUMA_FLOOR), null)
assert.equal(gammaExponentForLuma(180), null)
assert.equal(gammaExponentForLuma(Number.NaN), null)
const dim = gammaExponentForLuma(70)
assert.ok(dim !== null)
assert.ok(dim <= 1)
assert.ok(dim >= DETECT_EASE_MIN_EXPONENT)
const veryDark = gammaExponentForLuma(10)
assert.equal(veryDark, DETECT_EASE_MIN_EXPONENT)

assert.equal(applyGammaByte(0, 0.62), 0)
assert.equal(applyGammaByte(255, 0.62), 255)
assert.ok(applyGammaByte(40, 0.62) > 40)
assert.ok(applyGammaByte(40, 0.62) < 160)

console.log('detect ease ok')
