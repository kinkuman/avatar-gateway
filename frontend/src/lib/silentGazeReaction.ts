// 視線発話が空のときに、読み上げなしで回す身振りを選びます。

import type { AvatarExpression, MotionCatalogItem } from '../types'

export const SILENT_GAZE_HOLD_MS = 3200

const PREFERRED: { motion: string, expression: AvatarExpression }[] = [
  { motion: 'nod', expression: 'relaxed' },
  { motion: 'cute_standing', expression: 'shy' },
  { motion: 'lean_forward', expression: 'happy' },
  { motion: 'small_open_arms', expression: 'relaxed' },
  { motion: 'wave', expression: 'happy' },
  { motion: 'gentle_open_arms', expression: 'shy' },
  { motion: 'thinking_pose', expression: 'relaxed' },
  { motion: 'cute_confident', expression: 'happy' },
  { motion: 'hands_behind_back', expression: 'relaxed' },
  { motion: 'inspiration_pose', expression: 'surprised' },
  { motion: 'salute', expression: 'happy' },
  { motion: 'nervous_pose', expression: 'shy' },
]

const FACE_ONLY: AvatarExpression[] = ['happy', 'relaxed', 'shy', 'surprised']

export interface SilentGazeReaction {
  motion: string | null
  expression: AvatarExpression
  nextCursor: number
}

function playableNames(motions: MotionCatalogItem[]): Set<string> {
  return new Set(
    motions
      .filter((motion) => motion.enabled && motion.available && Boolean(motion.url))
      .map((motion) => motion.name),
  )
}

/** 使えるモーションを優先し、無ければ表情だけを、前回と重ならない順で返します。 */
export function nextSilentGazeReaction(
  motions: MotionCatalogItem[],
  cursor: number,
): SilentGazeReaction {
  const names = playableNames(motions)
  const preferred = PREFERRED.filter((item) => names.has(item.motion))
  if (preferred.length === 0 && names.size === 0) {
    const expression = FACE_ONLY[Math.abs(cursor) % FACE_ONLY.length]
    return { motion: null, expression, nextCursor: cursor + 1 }
  }
  const pool = preferred.length > 0
    ? preferred
    : [...names].map((motion) => ({ motion, expression: 'relaxed' as const }))
  const index = Math.abs(cursor) % pool.length
  const choice = pool[index]
  return { motion: choice.motion, expression: choice.expression, nextCursor: index + 1 }
}
