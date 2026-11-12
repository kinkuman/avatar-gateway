/* 現在の送信先を変えず、Hermesに保存されたAvatar Gateway会話を閲覧するパネルです。 */
import { messageContent, readResponseMessage, readMessage, t, useTranslation, translateMessage } from '../i18n'

import { useEffect, useState } from 'react'

import { splitGatewayMessages } from '../lib/gatewayMessage'
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
  if (value === null) return t('history.unknownDate')
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : t('history.unknownDate')
}

/** タイトル未設定のセッションにも、内容から識別できる短い見出しを付けます。 */
function sessionHeading(session: HermesSessionSummary): string {
  return session.title ?? session.preview ?? t('history.fallbackTitle', { id: session.id.slice(-8) })
}

/** Hermesの実額を優先し、未確定時だけ見積額を読みやすいドル表記にします。 */
function formatSessionCost(session: HermesSessionSummary): string {
  const cost = session.actualCostUsd ?? session.estimatedCostUsd
  if (cost === null || cost < 0) return t('history.unknownCost')
  if (cost > 0 && cost < 0.0001) return t('history.costBelowMinimum')
  return `$${cost.toFixed(4)}`
}

/** 一覧選択と正式履歴の取得を分離し、過去セッションを読み取り専用で表示します。 */
export default function SessionHistoryPanel({
  currentSessionId,
  sessionSwitching,
  onOpenSession,
  onContinueSession,
}: SessionHistoryPanelProps) {
  useTranslation()
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
        // ここで中断する条件: セッション一覧APIエラー: 対象値。
        if (!response.ok) throw new Error(await readResponseMessage(response, t('history.errors.listStatus', { status: response.status })))
        const page = readSessionPage(await response.json())
        // ここで中断する条件: セッション一覧の応答形式が正しくありません。
        if (!page) throw new Error(t('history.errors.listFormat'))
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
        // セッション一覧の取得失敗を利用者へ知らせます。
        setListError(cause instanceof Error ? cause.message : t('history.errors.list'))
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
        // ここで中断する条件: セッション履歴APIエラー: 対象値。
        if (!response.ok) throw new Error(await readResponseMessage(response, t('history.errors.historyStatus', { status: response.status })))
        const data = await response.json() as Record<string, unknown>
        // ここで中断する条件: セッション履歴の応答形式が正しくありません。
        if (!Array.isArray(data.data)) throw new Error(t('history.errors.historyFormat'))
        setMessages(readSessionMessages(data.data))
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        // セッション履歴の取得失敗を利用者へ知らせます。
        setHistoryError(cause instanceof Error ? cause.message : t('history.errors.history'))
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
      // ここで中断する条件: セッション一覧APIエラー: 対象値。
      if (!response.ok) throw new Error(await readResponseMessage(response, t('history.errors.listStatus', { status: response.status })))
      const page = readSessionPage(await response.json())
      // ここで中断する条件: セッション一覧の応答形式が正しくありません。
      if (!page) throw new Error(t('history.errors.listFormat'))
      setSessions((current) => {
        const knownIds = new Set(current.map((session) => session.id))
        return [...current, ...page.sessions.filter((session) => !knownIds.has(session.id))]
      })
      setHasMore(page.hasMore)
    } catch (cause) {
      // 追加のセッションの取得失敗を利用者へ知らせます。
      setListError(cause instanceof Error ? cause.message : t('history.errors.loadMore'))
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
      // セッションの切り替えが完了しなかったことを知らせます。
      setOpenError(cause instanceof Error ? cause.message : t('history.errors.switch'))
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
      t('history.confirmDelete', { title: heading }),
    )) return

    setDeletingSessionId(selectedSession.id)
    setDeleteError('')
    try {
      const response = await fetch(`/api/hermes/sessions/${selectedSession.id}`, { method: 'DELETE' })
      if (!response.ok) {
        // 履歴を削除できない場合、APIが返した理由を優先して知らせます。
        let message = t('history.errors.deleteStatus', { status: response.status })
        try {
          const data = await response.json() as Record<string, unknown>
          message = readMessage(data, message)
        } catch {
          // JSON以外のエラーでも状態コードによる案内を残します。
        }
        throw new Error(message)
      }
      const data = await response.json() as Record<string, unknown>
      if (data.id !== selectedSession.id || data.deleted !== true) {
        // セッション削除の形式異常を利用者へ知らせます。
        throw new Error(t('history.errors.deleteFormat'))
      }
      const remaining = sessions.filter((session) => session.id !== selectedSession.id)
      setSessions(remaining)
      setSelectedSessionId(remaining[0]?.id ?? null)
      setMessages([])
    } catch (cause) {
      // 履歴削除の失敗を通知し、画面に履歴を残します。
      setDeleteError(cause instanceof Error ? cause.message : t('history.errors.delete'))
    } finally {
      setDeletingSessionId(null)
    }
  }

  return (
    <section className="session-history" aria-label={t('history.title')}>
      <aside className="session-list-panel">
        <header className="session-list-header">
          <div>
            <span>{t('history.eyebrow')}</span>
            <h2>{t('history.title')}</h2>
          </div>
          <span className="session-count">{t(hasMore ? 'history.countAtLeast' : 'history.count', { count: sessions.length })}</span>
        </header>

        <div className="session-list">
          {listLoading && <p className="session-placeholder">{t('history.loadingSessions')}</p>}
          {!listLoading && sessions.length === 0 && !listError && (
            <p className="session-placeholder">{t('history.noSessions')}</p>
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
                  <span>{t('history.messageCount', { count: session.messageCount })}</span>
                </span>
                <span className="session-list-statuses">
                  {current && <span className="session-current-badge">{t('history.current')}</span>}
                  <span className={session.endedAt === null ? 'session-open-badge' : 'session-ended-badge'}>
                    {session.endedAt === null ? t('history.active') : t('history.ended')}
                  </span>
                </span>
              </button>
            )
          })}
          {hasMore && (
            <button type="button" className="session-load-more" disabled={moreLoading || sessionSwitching} onClick={() => void loadMore()}>
              {moreLoading ? t('history.loadingMore') : t('history.loadMore')}
            </button>
          )}
        </div>

        {listError && (
          <div className="session-list-error" role="alert">
            <p>{translateMessage(listError)}</p>
            {!listLoading && sessions.length === 0 && (
              <button type="button" onClick={() => setReloadToken((current) => current + 1)}>{t('history.retry')}</button>
            )}
          </div>
        )}
      </aside>

      <section className="session-history-detail" aria-live="polite">
        {selectedSession ? (
          <>
            <header className="session-history-header">
              <div>
                <span>{t('history.readOnly')}</span>
                <h2>{sessionHeading(selectedSession)}</h2>
                <p>{t('history.summary', { time: formatSessionTime(selectedSession.lastActive ?? selectedSession.startedAt), messageCount: selectedSession.messageCount, toolCount: selectedSession.toolCallCount })}</p>
                <p className="session-history-stats">
                  {t('history.usage', { inputTokens: selectedSession.inputTokens.toLocaleString(), outputTokens: selectedSession.outputTokens.toLocaleString(), reasoningTokens: selectedSession.reasoningTokens.toLocaleString(), apiCallCount: selectedSession.apiCallCount, cost: formatSessionCost(selectedSession) })}
                </p>
                {selectedSession.parentSessionId && (
                  <p className="session-parent">{t('history.parent', { id: selectedSession.parentSessionId.slice(-8) })}</p>
                )}
              </div>
              <div className="session-history-actions">
                <span className={selectedSession.endedAt === null ? 'session-open-badge' : 'session-ended-badge'}>
                  {selectedSession.endedAt === null ? t('history.active') : t('history.ended')}
                </span>
                <button
                  type="button"
                  disabled={selectedSession.id === currentSessionId || historyLoading || Boolean(historyError) || sessionSwitching}
                  onClick={() => void useSelectedSession()}
                >
                  {selectedSession.id === currentSessionId
                    ? t('history.currentSession')
                    : sessionSwitching
                      ? t('history.switching')
                      : selectedSession.endedAt === null
                        ? t('history.openSession')
                        : t('history.continueSession')}
                </button>
                {selectedSession.endedAt !== null && selectedSession.id !== currentSessionId && (
                  <button
                    type="button"
                    className="session-delete-button"
                    disabled={sessionSwitching || deletingSessionId !== null}
                    onClick={() => void deleteSelectedSession()}
                  >
                    {deletingSessionId === selectedSession.id ? t('history.deleting') : t('history.delete')}
                  </button>
                )}
              </div>
            </header>
            <div className="session-history-messages">
              {openError && <p className="error-message" role="alert">{translateMessage(openError)}</p>}
              {deleteError && <p className="error-message" role="alert">{translateMessage(deleteError)}</p>}
              {historyLoading && <p className="session-placeholder">{t('history.loadingHistory')}</p>}
              {!historyLoading && !historyError && messages.length === 0 && (
                <p className="session-placeholder">{t('history.noMessages')}</p>
              )}
              {splitGatewayMessages(messages).map((message) => (
                <article className={`message ${message.role}`} key={message.key}>
                  <span>{message.role === 'user' ? t('history.user') : t('app.conversation.assistant')}</span>
                  {message.role === 'assistant' ? (
                    <MarkdownMessage content={messageContent(message)} />
                  ) : (
                    <p>{message.content}</p>
                  )}
                </article>
              ))}
              {historyError && <p className="error-message" role="alert">{translateMessage(historyError)}</p>}
            </div>
          </>
        ) : (
          <p className="session-placeholder session-no-selection">{t('history.selectSession')}</p>
        )}
      </section>
    </section>
  )
}
