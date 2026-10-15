/** これ以下の表情ウェイトは、無表情と同じとみなしてまばたきを許します。 */
export const EXPRESSION_TRANSITION_EPSILON = 0.02

/**
 * まばたき抑制が有効なとき、表情が無表情から離れているあいだは true を返します。
 * 現在値と目標値の大きい方を見るので、切り替わりの途中も、着地したあとも、消える途中も止まります。
 */
export function shouldHoldBlinkDuringExpression(
  enabled: boolean,
  currents: readonly number[],
  targets: readonly number[] = [],
  epsilon = EXPRESSION_TRANSITION_EPSILON,
): boolean {
  if (!enabled) return false
  const count = Math.max(currents.length, targets.length)
  for (let index = 0; index < count; index += 1) {
    const current = currents[index]
    const target = targets[index]
    const level = Math.max(
      typeof current === 'number' && Number.isFinite(current) ? current : 0,
      typeof target === 'number' && Number.isFinite(target) ? target : 0,
    )
    if (level > epsilon) return true
  }
  return false
}
