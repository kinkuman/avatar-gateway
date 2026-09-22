// Hermes Runの状態と安全化済みツールイベントを、会話本文とは分けて表示するパネルです。
import { useEffect, useState } from 'react'

import type { AgentRunState, ToolTimelineItem } from '../types'

const runStateLabels: Record<AgentRunState, string> = {
  idle: '待機中',
  starting: '開始中',
  running: '作業中',
  using_tool: 'ツール実行中',
  waiting_for_approval: '承認待ち',
  stopping: '停止処理中',
  completed: '完了',
  failed: '失敗',
  stopped: '停止済み',
}

const toolStateLabels: Record<ToolTimelineItem['status'], string> = {
  running: '実行中',
  succeeded: '成功',
  failed: '失敗',
}

interface ToolTimelineProps {
  runState: AgentRunState
  items: ToolTimelineItem[]
}

/** HermesのUNIX秒を、利用者のローカル時刻へ短く整形します。 */
function formatStartedAt(timestamp: number | null): string {
  if (timestamp === null) return '開始時刻不明'
  return new Date(timestamp * 1000).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Hermesが提供した所要時間だけを表示し、不明な時間を画面側で推測しません。 */
function formatDuration(durationSeconds: number | null): string | null {
  if (durationSeconds === null) return null
  if (durationSeconds < 1) return `${Math.round(durationSeconds * 1000)}ms`
  return `${durationSeconds.toFixed(1)}秒`
}

/** 一つのRunに属するツールを実行順に表示します。 */
export default function ToolTimeline({ runState, items }: ToolTimelineProps) {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    // 新しいRunは必ず展開し、前回の折りたたみで進捗が隠れないようにします。
    if (runState === 'starting') setCollapsed(false)
  }, [runState])

  if (runState === 'idle') return null

  return (
    <section className="work-panel" aria-label="Hermes作業状況" aria-live="polite">
      <header className="work-panel-header">
        <div>
          <span className="work-panel-eyebrow">AGENT RUN</span>
          <h2>作業状況</h2>
        </div>
        <div className="work-panel-actions">
          <span className={`run-state run-state-${runState}`}>{runStateLabels[runState]}</span>
          <button
            type="button"
            className="work-panel-toggle"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? '展開' : '折りたたむ'}
          </button>
        </div>
      </header>
      {!collapsed && <ol className="tool-timeline" aria-label="ツール実行タイムライン">
        {items.length === 0 ? (
          <li className="tool-timeline-empty">このRunではツールをまだ使用していません。</li>
        ) : items.map((item) => {
          const duration = formatDuration(item.durationSeconds)
          return (
            <li className={`tool-entry tool-entry-${item.status}`} key={item.id}>
              <span className="tool-entry-marker" aria-hidden="true" />
              <div className="tool-entry-body">
                <div className="tool-entry-title">
                  <strong>{item.tool}</strong>
                  <span>{toolStateLabels[item.status]}</span>
                </div>
                <div className="tool-entry-meta">
                  <time>{formatStartedAt(item.startedAt)}</time>
                  {duration && <span>所要時間 {duration}</span>}
                </div>
              </div>
            </li>
          )
        })}
      </ol>}
    </section>
  )
}
