import assert from 'node:assert/strict'

import {
  EXPRESSION_TRANSITION_EPSILON,
  shouldHoldBlinkDuringExpression,
} from '../src/vrm/expressionBlinkGate.ts'

assert.equal(shouldHoldBlinkDuringExpression(false, [1]), false)
assert.equal(shouldHoldBlinkDuringExpression(true, [0, EXPRESSION_TRANSITION_EPSILON]), false)
assert.equal(
  shouldHoldBlinkDuringExpression(true, [0, EXPRESSION_TRANSITION_EPSILON + 0.001]),
  true,
)
assert.equal(shouldHoldBlinkDuringExpression(true, [Number.NaN, 0]), false)

// 表情が目標まで着いて差が無くても、表情が乗っているあいだはまばたきを止める。
assert.equal(shouldHoldBlinkDuringExpression(true, [1], [1]), true)
assert.equal(shouldHoldBlinkDuringExpression(true, [0], [1]), true)
assert.equal(shouldHoldBlinkDuringExpression(true, [0.5], [0]), true)
assert.equal(shouldHoldBlinkDuringExpression(true, [0], [0]), false)
assert.equal(
  shouldHoldBlinkDuringExpression(
    true,
    [EXPRESSION_TRANSITION_EPSILON],
    [EXPRESSION_TRANSITION_EPSILON],
  ),
  false,
)
assert.equal(shouldHoldBlinkDuringExpression(false, [1], [1]), false)
assert.equal(shouldHoldBlinkDuringExpression(true, [Number.NaN], [Number.NaN]), false)

console.log('expression blink gate ok')
