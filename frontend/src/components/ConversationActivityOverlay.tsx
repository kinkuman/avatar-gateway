// 会話画面で、内部推論を出さずに観測可能な処理段階とツール実行だけを逐次表示します。

import type { ConversationActivityPhase, ToolTimelineItem } from '../types'

const phaseLabels: Record<ConversationActivityPhase, string> = {
  starting: '処理を始めています…',
  thinking: '考えています…',
  using_tool: 'ツールを実行しています…',
  reviewing: '結果を確認しています…',
  composing: '返答をまとめています…',
  synthesizing: '音声を準備しています…',
  speaking: '話しています…',
  waiting_for_approval: '操作の承認を待っています',
  stopping: '停止しています…',
  completed: '返答が完了しました',
  failed: '処理に失敗しました',
  stopped: '処理を停止しました',
}

interface Props {
  phase: ConversationActivityPhase | null
  tools: ToolTimelineItem[]
}

/** Hermesが提供した所要時間だけを短く表示し、未提供の時間は推測しません。 */
function formatDuration(durationSeconds: number | null): string {
  if (durationSeconds === null) return ''
  if (durationSeconds < 1) return ` ${Math.round(durationSeconds * 1000)}ms`
  return ` ${durationSeconds.toFixed(1)}秒`
}

/** 現在段階と直近のツールだけを表示し、アバターを覆う大きな作業パネルを作りません。 */
export default function ConversationActivityOverlay({ phase, tools }: Props) {
  if (!phase && tools.length === 0) return null
  const visibleTools = tools.slice(-3)
  const hiddenCount = tools.length - visibleTools.length

  return (
    <section className="conversation-activity" aria-label="現在の作業状況" aria-live="polite">
      {phase && (
        <p className={`conversation-activity-phase phase-${phase}`}>
          {phase === 'thinking' ? (
            <span className="thinking-animation" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : (
            <span aria-hidden="true">●</span>
          )}
          {' '}{phaseLabels[phase]}
        </p>
      )}
      {visibleTools.length > 0 && (
        <ul className="conversation-activity-tools" aria-label="直近のツール実行">
          {hiddenCount > 0 && <li className="conversation-activity-more">ほか{hiddenCount}件</li>}
          {visibleTools.map((tool) => (
            <li className={`conversation-activity-tool tool-${tool.status}`} key={tool.id}>
              <span aria-hidden="true">{tool.status === 'running' ? '●' : tool.status === 'succeeded' ? '✓' : '×'}</span>
              <strong>{tool.tool}</strong>
              <span>
                {tool.status === 'running' ? '実行中' : tool.status === 'succeeded' ? '完了' : '失敗'}
                {formatDuration(tool.durationSeconds)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
