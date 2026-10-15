import assert from 'node:assert/strict'

import {
  chooseFollowBox,
  createFaceFollowPose,
  FACE_FOLLOW_HOLD_SECONDS,
  faceFollowAngles,
  largestFaceBox,
  stepFaceFollow,
} from '../src/lib/faceFollow.ts'
import { readGazeSettings, writeGazeSettings } from '../src/lib/gazeFace.ts'

const center = faceFollowAngles({ x: 310, y: 230, width: 20, height: 20 }, 640, 480)
assert.ok(center)
assert.equal(center.lookYaw, 0)
assert.equal(center.lookPitch, 0)
assert.equal(center.headYaw, 0)
assert.equal(center.headPitch, 0)

const nearCenter = faceFollowAngles({ x: 300, y: 220, width: 40, height: 40 }, 640, 480)
assert.ok(nearCenter)
assert.equal(nearCenter.lookYaw, 0)
assert.equal(nearCenter.headPitch, 0)

const left = faceFollowAngles({ x: 0, y: 200, width: 40, height: 80 }, 640, 480)
assert.ok(left)
assert.ok(left.lookYaw > 20)
assert.ok(left.headYaw > 14)
assert.equal(left.lookPitch, 0)

const right = faceFollowAngles({ x: 600, y: 200, width: 40, height: 80 }, 640, 480)
assert.ok(right)
assert.ok(right.lookYaw < -20)
assert.ok(right.headYaw < -14)

const above = faceFollowAngles({ x: 300, y: 0, width: 40, height: 40 }, 640, 480)
assert.ok(above)
assert.ok(above.lookPitch > 0)
assert.ok(above.headPitch > 0)
assert.equal(above.lookYaw, 0)

assert.equal(faceFollowAngles({ x: 0, y: 0, width: 0, height: 10 }, 640, 480), null)
assert.equal(faceFollowAngles({ x: 0, y: 0, width: 10, height: 10 }, 0, 480), null)

const large = { x: 10, y: 10, width: 80, height: 80 }
const small = { x: 200, y: 10, width: 20, height: 20 }
assert.equal(largestFaceBox([small, large]), large)
assert.equal(
  chooseFollowBox([
    { box: large, distance: 0.7 },
    { box: small, distance: 0.2 },
  ], true, 0.5),
  small,
)
assert.equal(
  chooseFollowBox([{ box: large, distance: 0.8 }], true, 0.5),
  null,
)
assert.equal(
  chooseFollowBox([
    { box: small, distance: null },
    { box: large, distance: null },
  ], false, 0.5),
  large,
)

const storage = new Map<string, string>()
const memoryStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
} as Storage
assert.equal(readGazeSettings(memoryStorage).faceFollow, false)
assert.equal(readGazeSettings(memoryStorage).detectEase, false)
writeGazeSettings(memoryStorage, {
  enabled: true,
  faceFollow: true,
  detectEase: true,
  enrollment: null,
})
assert.equal(readGazeSettings(memoryStorage).faceFollow, true)
assert.equal(readGazeSettings(memoryStorage).detectEase, true)
assert.equal(readGazeSettings(memoryStorage).enabled, true)
memoryStorage.setItem('avatar-gateway.gaze-face', '{')
assert.equal(readGazeSettings(memoryStorage).faceFollow, false)

const side = {
  lookYaw: 18,
  lookPitch: -6,
  headYaw: 12,
  headPitch: -4,
}
const pose = createFaceFollowPose()
for (let step = 0; step < 120; step += 1) stepFaceFollow(pose, side, 1 / 60)
assert.ok(pose.weight > 0.95)
assert.ok(Math.abs(pose.headYaw - side.headYaw) < 0.5)
const heldYaw = pose.headYaw
const heldPitch = pose.headPitch
const heldLook = pose.lookYaw
for (let step = 0; step < Math.floor(FACE_FOLLOW_HOLD_SECONDS * 60) - 1; step += 1) {
  stepFaceFollow(pose, null, 1 / 60)
}
assert.ok(pose.lostFor < FACE_FOLLOW_HOLD_SECONDS)
assert.equal(pose.headYaw, heldYaw)
assert.equal(pose.headPitch, heldPitch)
assert.equal(pose.lookYaw, heldLook)
assert.ok(pose.weight > 0.95)
for (let step = 0; step < 90; step += 1) stepFaceFollow(pose, null, 1 / 60)
assert.ok(pose.lostFor >= FACE_FOLLOW_HOLD_SECONDS)
assert.equal(pose.headYaw, heldYaw)
assert.equal(pose.headPitch, heldPitch)
assert.ok(pose.weight < 0.95)
assert.ok(pose.weight > 0.2)
stepFaceFollow(pose, side, 1 / 60)
assert.equal(pose.lostFor, 0)
assert.ok(Math.abs(pose.headYaw - heldYaw) < 0.05)
assert.ok(Math.abs(pose.headYaw) > 10)

console.log('face follow ok')
