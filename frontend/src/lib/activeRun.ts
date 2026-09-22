/* 実行中のHermes Runを再読み込み後も識別するため、最小限の再接続情報だけを保存します。 */

const ACTIVE_RUN_STORAGE_KEY = 'avatar-gateway.hermes-active-run'
const SESSION_ID_PATTERN = /^avatar_gateway_[0-9a-f]{32}$/
const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/

export interface StoredActiveRun {
  sessionId: string
  runId: string
  lastSequence: number
}

/** 壊れた値や別用途のIDを復元対象にせず、安全なRun情報だけを読み取ります。 */
export function readActiveRun(): StoredActiveRun | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_RUN_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof value.sessionId !== 'string'
      || !SESSION_ID_PATTERN.test(value.sessionId)
      || typeof value.runId !== 'string'
      || !RUN_ID_PATTERN.test(value.runId)
      || typeof value.lastSequence !== 'number'
      || !Number.isInteger(value.lastSequence)
      || value.lastSequence < 0
    ) {
      sessionStorage.removeItem(ACTIVE_RUN_STORAGE_KEY)
      return null
    }
    return {
      sessionId: value.sessionId,
      runId: value.runId,
      lastSequence: value.lastSequence,
    }
  } catch {
    // 保存領域が無効な環境や破損JSONでも、通常の新規会話は継続できるようにします。
    try {
      sessionStorage.removeItem(ACTIVE_RUN_STORAGE_KEY)
    } catch {
      // 保存領域そのものが利用不能な場合は、後始末も行えません。
    }
    return null
  }
}

/** Run開始直後から再接続できるよう、所有セッションと連番を一組で保存します。 */
export function saveActiveRun(value: StoredActiveRun): void {
  try {
    sessionStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // sessionStorageを使えないブラウザでも、現在開いている会話自体は停止させません。
  }
}

/** 新しいイベントだけを要求できるよう、同じRunの受信済み連番を単調増加させます。 */
export function advanceActiveRun(runId: string, sequence: unknown): number | null {
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) return null
  const current = readActiveRun()
  if (!current || current.runId !== runId) return null
  const nextSequence = Math.max(current.lastSequence, sequence)
  if (nextSequence !== current.lastSequence) {
    saveActiveRun({ ...current, lastSequence: nextSequence })
  }
  return nextSequence
}

/** 別Runの開始情報を誤って消さないよう、指定されたRunと一致する場合だけ破棄します。 */
export function clearActiveRun(runId?: string): void {
  try {
    if (runId) {
      const current = readActiveRun()
      if (current && current.runId !== runId) return
    }
    sessionStorage.removeItem(ACTIVE_RUN_STORAGE_KEY)
  } catch {
    // 既に利用不能な保存領域の後始末は、画面操作へ影響させません。
  }
}
