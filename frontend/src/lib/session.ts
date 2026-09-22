/* Hermes Session APIの任意JSONを、画面が安全に扱える型へ変換します。 */

import type { HermesSessionSummary, Message } from '../types'

const OWNED_SESSION_ID_PATTERN = /^avatar_gateway_[0-9a-f]{32}$/

/** APIの数値項目から、日時や件数として利用できる有限値だけを取り出します。 */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 一覧応答を検証し、Avatar Gateway所有IDと表示用メタデータだけを返します。 */
export function readSessionPage(data: unknown): {
  sessions: HermesSessionSummary[]
  hasMore: boolean
} | null {
  if (!data || typeof data !== 'object') return null
  const page = data as Record<string, unknown>
  if (!Array.isArray(page.data)) return null

  const sessions = page.data.flatMap((item) => {
    const session = readSessionSummary(item)
    return session ? [session] : []
  })
  return { sessions, hasMore: page.has_more === true }
}

/** 単一セッション応答を検証し、所有IDと安全な表示項目だけへ正規化します。 */
export function readSessionSummary(data: unknown): HermesSessionSummary | null {
  if (!data || typeof data !== 'object') return null
  const session = data as Record<string, unknown>
  if (typeof session.id !== 'string' || !OWNED_SESSION_ID_PATTERN.test(session.id)) return null
  const messageCount = readNumber(session.message_count)
  const toolCallCount = readNumber(session.tool_call_count)
  const inputTokens = readNumber(session.input_tokens)
  const outputTokens = readNumber(session.output_tokens)
  const reasoningTokens = readNumber(session.reasoning_tokens)
  const apiCallCount = readNumber(session.api_call_count)
  return {
    id: session.id,
    title: typeof session.title === 'string' && session.title.trim() ? session.title.trim() : null,
    preview: typeof session.preview === 'string' && session.preview.trim() ? session.preview.trim() : null,
    startedAt: readNumber(session.started_at),
    lastActive: readNumber(session.last_active),
    endedAt: readNumber(session.ended_at),
    endReason: typeof session.end_reason === 'string' && session.end_reason ? session.end_reason : null,
    parentSessionId: typeof session.parent_session_id === 'string' && session.parent_session_id
      ? session.parent_session_id
      : null,
    messageCount: messageCount !== null && messageCount >= 0 ? Math.floor(messageCount) : 0,
    toolCallCount: toolCallCount !== null && toolCallCount >= 0 ? Math.floor(toolCallCount) : 0,
    inputTokens: inputTokens !== null && inputTokens >= 0 ? Math.floor(inputTokens) : 0,
    outputTokens: outputTokens !== null && outputTokens >= 0 ? Math.floor(outputTokens) : 0,
    reasoningTokens: reasoningTokens !== null && reasoningTokens >= 0 ? Math.floor(reasoningTokens) : 0,
    apiCallCount: apiCallCount !== null && apiCallCount >= 0 ? Math.floor(apiCallCount) : 0,
    estimatedCostUsd: readNumber(session.estimated_cost_usd),
    actualCostUsd: readNumber(session.actual_cost_usd),
  }
}

/** Hermesの正式履歴から、画面表示できる利用者・アシスタント発言だけを取り出します。 */
export function readSessionMessages(data: unknown): Message[] {
  if (!Array.isArray(data)) return []
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const message = item as Record<string, unknown>
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') return []
    // Hermesのツール呼び出し用assistant記録は本文が空なので、会話欄へ混ぜません。
    if (!message.content.trim()) return []
    return [{ role: message.role, content: message.content } satisfies Message]
  })
}
