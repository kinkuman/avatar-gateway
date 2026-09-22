/* 現在の送信先を変えず、Hermesに保存されたAvatar Gateway会話を閲覧するパネルです。 */

import { useEffect, useState } from 'react'

import { readSessionMessages, readSessionPage } from '../lib/session'
import type { HermesSessionSummary, Message } from '../types'
import MarkdownMessage from './MarkdownMessage'

const PAGE_SIZE = 50
const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'short',
  timeStyle: 'short',
})

interface SessionHistoryPanelProps {
  currentSessionId: string | null
  sessionSwitching: boolean
  onOpenSession: (sessionId: string) => Promise<boolean>
  onContinueSession: (sessionId: string) => Promise<boolean>
}

/** Unix秒を利用者のローカル日時へ変換し、不明値を誤った1970年表示にしません。 */
function formatSessionTime(value: number | null): string {
  if (value === null) return '日時不明'
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : '日時不明'
}

/** タイトル未設定のセッションにも、内容から識別できる短い見出しを付けます。 */
function sessionHeading(session: HermesSessionSummary): string {
  return session.title ?? session.preview ?? `セッション ${session.id.slice(-8)}`
}

/** Hermesの実額を優先し、未確定時だけ見積額を読みやすいドル表記にします。 */
function formatSessionCost(session: HermesSessionSummary): string {
  const cost = session.actualCostUsd ?? session.estimatedCostUsd
  if (cost === null || cost < 0) return 'コスト不明'
  if (cost > 0 && cost < 0.0001) return '$0.0001未満'
  return `$${cost.toFixed(4)}`
}

/** 一覧選択と正式履歴の取得を分離し、過去セッションを読み取り専用で表示します。 */
export default function SessionHistoryPanel({
  currentSessionId,
  sessionSwitching,
  onOpenSession,
  onContinueSession,
}: SessionHistoryPanelProps) {
  const [sessions, setSessions] = useState<HermesSessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [moreLoading, setMoreLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [openError, setOpenError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    /** パネルを開くたびに最新順の先頭ページを取得し、現在の会話を優先選択します。 */
    const loadInitialSessions = async () => {
      setListLoading(true)
      setListError('')
      try {
        const response = await fetch(`/api/hermes/sessions?limit=${PAGE_SIZE}&offset=0`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`セッション一覧APIエラー: ${response.status}`)
        const page = readSessionPage(await response.json())
        if (!page) throw new Error('セッション一覧の応答形式が正しくありません。')
        setSessions(page.sessions)
        setHasMore(page.hasMore)
        setSelectedSessionId((current) => {
          if (current && page.sessions.some((session) => session.id === current)) return current
          if (currentSessionId && page.sessions.some((session) => session.id === currentSessionId)) {
            return currentSessionId
          }
          return page.sessions[0]?.id ?? null
        })
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setListError(cause instanceof Error ? cause.message : 'セッション一覧を取得できませんでした。')
      } finally {
        if (!controller.signal.aborted) setListLoading(false)
      }
    }

    void loadInitialSessions()
    return () => controller.abort()
  }, [currentSessionId, reloadToken])

  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([])
      return
    }
    const controller = new AbortController()

    /** 選択した一件の正式履歴だけを取得し、一覧操作との通信競合を避けます。 */
    const loadHistory = async () => {
      setHistoryLoading(true)
      setHistoryError('')
      setMessages([])
      try {
        const response = await fetch(`/api/hermes/sessions/${selectedSessionId}/messages`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`セッション履歴APIエラー: ${response.status}`)
        const data = await response.json() as Record<string, unknown>
        if (!Array.isArray(data.data)) throw new Error('セッション履歴の応答形式が正しくありません。')
        setMessages(readSessionMessages(data.data))
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setHistoryError(cause instanceof Error ? cause.message : 'セッション履歴を取得できませんでした。')
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false)
      }
    }

    void loadHistory()
    return () => controller.abort()
  }, [selectedSessionId])

  /** 次ページだけを追記し、既に閲覧中のセッションと履歴を維持します。 */
  const loadMore = async () => {
    if (moreLoading || !hasMore) return
    setMoreLoading(true)
    setListError('')
    try {
      const response = await fetch(`/api/hermes/sessions?limit=${PAGE_SIZE}&offset=${sessions.length}`)
      if (!response.ok) throw new Error(`セッション一覧APIエラー: ${response.status}`)
      const page = readSessionPage(await response.json())
      if (!page) throw new Error('セッション一覧の応答形式が正しくありません。')
      setSessions((current) => {
        const knownIds = new Set(current.map((session) => session.id))
        return [...current, ...page.sessions.filter((session) => !knownIds.has(session.id))]
      })
      setHasMore(page.hasMore)
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : '追加のセッションを取得できませんでした。')
    } finally {
      setMoreLoading(false)
    }
  }

  /** 選択状態に応じて再開または分岐を要求し、失敗を履歴パネル内で説明します。 */
  const useSelectedSession = async () => {
    if (!selectedSession || sessionSwitching) return
    setOpenError('')
    try {
      if (selectedSession.endedAt === null) await onOpenSession(selectedSession.id)
      else await onContinueSession(selectedSession.id)
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : 'セッションを切り替えられませんでした。')
    }
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null

  /** 終了済み履歴だけを明示確認後に削除し、現在の送信先や子セッションには触れません。 */
  const deleteSelectedSession = async () => {
    if (
      !selectedSession
      || selectedSession.endedAt === null
      || selectedSession.id === currentSessionId
      || sessionSwitching
      || deletingSessionId
    ) return
    const heading = sessionHeading(selectedSession)
    if (!window.confirm(
      `「${heading}」をHermesから完全に削除しますか？\n\n`
      + 'この操作は取り消せません。分岐した子セッションは削除されませんが、親への参照が外れる場合があります。',
    )) return

    setDeletingSessionId(selectedSession.id)
    setDeleteError('')
    try {
      const response = await fetch(`/api/hermes/sessions/${selectedSession.id}`, { method: 'DELETE' })
      if (!response.ok) {
        let message = `セッション削除APIエラー: ${response.status}`
        try {
          const data = await response.json() as Record<string, unknown>
          if (typeof data.detail === 'string') message = data.detail
        } catch {
          // JSON以外のエラーでも状態コードによる案内を残します。
        }
        throw new Error(message)
      }
      const data = await response.json() as Record<string, unknown>
      if (data.id !== selectedSession.id || data.deleted !== true) {
        throw new Error('セッション削除の応答形式が正しくありません。')
      }
      const remaining = sessions.filter((session) => session.id !== selectedSession.id)
      setSessions(remaining)
      setSelectedSessionId(remaining[0]?.id ?? null)
      setMessages([])
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'セッションを削除できませんでした。')
    } finally {
      setDeletingSessionId(null)
    }
  }

  return (
    <section className="session-history" aria-label="セッション履歴">
      <aside className="session-list-panel">
        <header className="session-list-header">
          <div>
            <span>HERMES SESSIONS</span>
            <h2>セッション履歴</h2>
          </div>
          <span className="session-count">{sessions.length}{hasMore ? '件以上' : '件'}</span>
        </header>

        <div className="session-list">
          {listLoading && <p className="session-placeholder">セッションを読み込み中…</p>}
          {!listLoading && sessions.length === 0 && !listError && (
            <p className="session-placeholder">保存済みセッションはありません。</p>
          )}
          {sessions.map((session) => {
            const selected = session.id === selectedSessionId
            const current = session.id === currentSessionId
            return (
              <button
                type="button"
                className={`session-list-item${selected ? ' selected' : ''}`}
                aria-current={current ? 'true' : undefined}
                aria-pressed={selected}
                key={session.id}
                disabled={sessionSwitching}
                onClick={() => {
                  setOpenError('')
                  setDeleteError('')
                  setSelectedSessionId(session.id)
                }}
              >
                <span className="session-list-title">{sessionHeading(session)}</span>
                {session.title && session.preview && <span className="session-list-preview">{session.preview}</span>}
                <span className="session-list-meta">
                  <span>{formatSessionTime(session.lastActive ?? session.startedAt)}</span>
                  <span>{session.messageCount}メッセージ</span>
                </span>
                <span className="session-list-statuses">
                  {current && <span className="session-current-badge">現在</span>}
                  <span className={session.endedAt === null ? 'session-open-badge' : 'session-ended-badge'}>
                    {session.endedAt === null ? '継続中' : '終了済み'}
                  </span>
                </span>
              </button>
            )
          })}
          {hasMore && (
            <button type="button" className="session-load-more" disabled={moreLoading || sessionSwitching} onClick={() => void loadMore()}>
              {moreLoading ? '読み込み中…' : 'さらに読み込む'}
            </button>
          )}
        </div>

        {listError && (
          <div className="session-list-error" role="alert">
            <p>{listError}</p>
            {!listLoading && sessions.length === 0 && (
              <button type="button" onClick={() => setReloadToken((current) => current + 1)}>再試行</button>
            )}
          </div>
        )}
      </aside>

      <section className="session-history-detail" aria-live="polite">
        {selectedSession ? (
          <>
            <header className="session-history-header">
              <div>
                <span>READ ONLY</span>
                <h2>{sessionHeading(selectedSession)}</h2>
                <p>{formatSessionTime(selectedSession.lastActive ?? selectedSession.startedAt)} · {selectedSession.messageCount}メッセージ · {selectedSession.toolCallCount}ツール実行</p>
                <p className="session-history-stats">
                  入力 {selectedSession.inputTokens.toLocaleString()} · 出力 {selectedSession.outputTokens.toLocaleString()} · 推論 {selectedSession.reasoningTokens.toLocaleString()} tokens · API {selectedSession.apiCallCount}回 · {formatSessionCost(selectedSession)}
                </p>
                {selectedSession.parentSessionId && (
                  <p className="session-parent">分岐元: …{selectedSession.parentSessionId.slice(-8)}</p>
                )}
              </div>
              <div className="session-history-actions">
                <span className={selectedSession.endedAt === null ? 'session-open-badge' : 'session-ended-badge'}>
                  {selectedSession.endedAt === null ? '継続中' : '終了済み'}
                </span>
                <button
                  type="button"
                  disabled={selectedSession.id === currentSessionId || historyLoading || Boolean(historyError) || sessionSwitching}
                  onClick={() => void useSelectedSession()}
                >
                  {selectedSession.id === currentSessionId
                    ? '現在のセッション'
                    : sessionSwitching
                      ? '切り替え中…'
                      : selectedSession.endedAt === null
                        ? 'このセッションを開く'
                        : 'この会話の続きから開始'}
                </button>
                {selectedSession.endedAt !== null && selectedSession.id !== currentSessionId && (
                  <button
                    type="button"
                    className="session-delete-button"
                    disabled={sessionSwitching || deletingSessionId !== null}
                    onClick={() => void deleteSelectedSession()}
                  >
                    {deletingSessionId === selectedSession.id ? '削除中…' : 'この履歴を削除'}
                  </button>
                )}
              </div>
            </header>
            <div className="session-history-messages">
              {openError && <p className="error-message" role="alert">{openError}</p>}
              {deleteError && <p className="error-message" role="alert">{deleteError}</p>}
              {historyLoading && <p className="session-placeholder">会話履歴を読み込み中…</p>}
              {!historyLoading && !historyError && messages.length === 0 && (
                <p className="session-placeholder">表示できる会話はありません。</p>
              )}
              {messages.map((message, index) => (
                <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                  <span>{message.role === 'user' ? 'あなた' : 'Hermes'}</span>
                  {message.role === 'assistant' ? (
                    <MarkdownMessage content={message.content} />
                  ) : (
                    <p>{message.content}</p>
                  )}
                </article>
              ))}
              {historyError && <p className="error-message" role="alert">{historyError}</p>}
            </div>
          </>
        ) : (
          <p className="session-placeholder session-no-selection">閲覧するセッションを選んでください。</p>
        )}
      </section>
    </section>
  )
}
