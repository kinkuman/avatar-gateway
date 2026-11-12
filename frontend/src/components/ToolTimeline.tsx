// Hermes Runの状態と安全化済みツールイベントを、会話本文とは分けて表示するパネルです。
import { t, useTranslation } from '../i18n'
import { useEffect, useState } from 'react'

import type { AgentRunState, ToolTimelineItem } from '../types'

// 作業の実行状態を翻訳キーへ対応付けます。
const runStateLabels: Record<AgentRunState, string> = {
  idle: 'timeline.run.idle', // 実行待ち
  starting: 'timeline.run.starting', // 実行を開始
  running: 'timeline.run.running', // 作業を実行
  using_tool: 'timeline.run.usingTool', // ツールを実行
  waiting_for_approval: 'timeline.run.waitingForApproval', // 許可を待機
  stopping: 'timeline.run.stopping', // 停止を処理
  completed: 'timeline.run.completed', // 作業の完了
  failed: 'timeline.run.failed', // 作業の失敗
  stopped: 'timeline.run.stopped', // 停止の完了
}

// ツールの実行結果を翻訳キーへ対応付けます。
const toolStateLabels: Record<ToolTimelineItem['status'], string> = {
  running: 'timeline.tool.running', // ツールを実行中
  succeeded: 'timeline.tool.succeeded', // ツールの正常終了
  failed: 'timeline.run.failed', // 作業の失敗
}

interface ToolTimelineProps {
  runState: AgentRunState
  items: ToolTimelineItem[]
}

/** HermesのUNIX秒を、利用者のローカル時刻へ短く整形します。 */
function formatStartedAt(timestamp: number | null): string {
  if (timestamp === null) return t('timeline.unknownStartTime')
  return new Date(timestamp * 1000).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Hermesが提供した所要時間だけを表示し、不明な時間を画面側で推測しません。 */
function formatDuration(durationSeconds: number | null): string | null {
  if (durationSeconds === null) return null
  if (durationSeconds < 1) return t('timeline.durationMilliseconds', { duration: Math.round(durationSeconds * 1000) })
  return t('timeline.duration', { duration: durationSeconds.toFixed(1) })
}

/** 一つのRunに属するツールを実行順に表示します。 */
export default function ToolTimeline({ runState, items }: ToolTimelineProps) {
  useTranslation()
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    // 新しいRunは必ず展開し、前回の折りたたみで進捗が隠れないようにします。
    if (runState === 'starting') setCollapsed(false)
  }, [runState])

  if (runState === 'idle') return null

  return (
    <section className="work-panel" aria-label={t('timeline.panelLabel')} aria-live="polite">
      <header className="work-panel-header">
        <div>
          <span className="work-panel-eyebrow">{t('timeline.eyebrow')}</span>
          <h2>{t('timeline.title')}</h2>
        </div>
        <div className="work-panel-actions">
          <span className={`run-state run-state-${runState}`}>{t(runStateLabels[runState])}</span>
          <button
            type="button"
            className="work-panel-toggle"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? t('timeline.expand') : t('timeline.collapse')}
          </button>
        </div>
      </header>
      {!collapsed && <ol className="tool-timeline" aria-label={t('timeline.listLabel')}>
        {items.length === 0 ? (
          <li className="tool-timeline-empty">{t('timeline.empty')}</li>
        ) : items.map((item) => {
          const duration = formatDuration(item.durationSeconds)
          return (
            <li className={`tool-entry tool-entry-${item.status}`} key={item.id}>
              <span className="tool-entry-marker" aria-hidden="true" />
              <div className="tool-entry-body">
                <div className="tool-entry-title">
                  <strong>{item.tool}</strong>
                  <span>{t(toolStateLabels[item.status])}</span>
                </div>
                <div className="tool-entry-meta">
                  <time>{formatStartedAt(item.startedAt)}</time>
                  {duration && <span>{t('timeline.elapsed', { duration })}</span>}
                </div>
              </div>
            </li>
          )
        })}
      </ol>}
    </section>
  )
}
