// 会話画面で、内部推論を出さずに観測可能な処理段階とツール実行だけを逐次表示します。
import { t, useTranslation } from '../i18n'

import type { ConversationActivityPhase, ToolTimelineItem } from '../types'

// 会話処理の進行段階を翻訳キーへ対応付けます。
const phaseLabels: Record<ConversationActivityPhase, string> = {
  starting: 'activity.phase.starting', // 会話処理の開始
  thinking: 'activity.phase.thinking', // 回答を検討
  using_tool: 'activity.phase.usingTool', // 外部ツールの実行
  reviewing: 'activity.phase.reviewing', // ツール結果を確認
  composing: 'activity.phase.composing', // 返答を構成
  synthesizing: 'activity.phase.synthesizing', // 発話音声を準備
  speaking: 'activity.phase.speaking', // 音声を再生
  waiting_for_approval: 'activity.phase.waitingForApproval', // 利用者の許可を待機
  stopping: 'activity.phase.stopping', // 中断処理中
  completed: 'activity.phase.completed', // 返答の完了
  failed: 'activity.phase.failed', // 処理の失敗
  stopped: 'activity.phase.stopped', // 中断の完了
}

interface Props {
  phase: ConversationActivityPhase | null
  tools: ToolTimelineItem[]
}

/** Hermesが提供した所要時間だけを短く表示し、未提供の時間は推測しません。 */
function formatDuration(durationSeconds: number | null): string {
  if (durationSeconds === null) return ''
  if (durationSeconds < 1) return ` ${Math.round(durationSeconds * 1000)}ms`
  return t('activity.duration', { duration: durationSeconds.toFixed(1) })
}

/** 現在段階と直近のツールだけを表示し、アバターを覆う大きな作業パネルを作りません。 */
export default function ConversationActivityOverlay({ phase, tools }: Props) {
  useTranslation()
  if (!phase && tools.length === 0) return null
  const visibleTools = tools.slice(-3)
  const hiddenCount = tools.length - visibleTools.length

  return (
    <section className="conversation-activity" aria-label={t('activity.panelLabel')} aria-live="polite">
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
          {' '}{t(phaseLabels[phase])}
        </p>
      )}
      {visibleTools.length > 0 && (
        <ul className="conversation-activity-tools" aria-label={t('activity.recentToolsLabel')}>
          {hiddenCount > 0 && <li className="conversation-activity-more">{t('activity.moreTools', { count: hiddenCount })}</li>}
          {visibleTools.map((tool) => (
            <li className={`conversation-activity-tool tool-${tool.status}`} key={tool.id}>
              <span aria-hidden="true">{tool.status === 'running' ? '●' : tool.status === 'succeeded' ? '✓' : '×'}</span>
              <strong>{tool.tool}</strong>
              <span>
                {tool.status === 'running' ? t('activity.tool.running') : tool.status === 'succeeded' ? t('activity.tool.succeeded') : t('activity.tool.failed')}
                {formatDuration(tool.durationSeconds)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
