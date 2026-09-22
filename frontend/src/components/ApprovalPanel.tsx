// Hermesが停止して待っている危険操作を、影響範囲の説明付きで判断するパネルです。
import { useEffect, useState } from 'react'

import type { ApprovalChoice, ApprovalRequestState } from '../types'

const choiceLabels: Record<ApprovalChoice, string> = {
  once: '今回だけ許可',
  session: 'このセッション中は許可',
  always: '今後も許可',
  deny: '拒否',
}

interface ApprovalPanelProps {
  request: ApprovalRequestState | null
  onRespond: (choice: ApprovalChoice) => Promise<void>
}

/** 影響範囲の広いalwaysだけ再確認し、主要な一回許可と拒否は直接選べるようにします。 */
export default function ApprovalPanel({ request, onRespond }: ApprovalPanelProps) {
  const [confirmingAlways, setConfirmingAlways] = useState(false)

  useEffect(() => {
    setConfirmingAlways(false)
  }, [request?.id])

  if (!request) return null
  const disabled = request.status !== 'pending'
  const canChoose = (choice: ApprovalChoice) => request.choices.includes(choice)

  return (
    <section className="approval-panel" aria-label="Hermes承認要求" aria-live="assertive">
      <header className="approval-header">
        <div>
          <span className="approval-eyebrow">APPROVAL REQUIRED</span>
          <h2>操作の承認が必要です</h2>
        </div>
        <span className={`approval-status approval-status-${request.status}`}>
          {request.status === 'submitting' ? '回答送信中' : request.status === 'resolved' ? '回答済み' : '判断待ち'}
        </span>
      </header>

      {request.status === 'resolved' ? (
        <p className="approval-result">
          選択: {request.resolvedChoice ? choiceLabels[request.resolvedChoice] : '回答済み'}
        </p>
      ) : (
        <>
          {request.description && <p className="approval-description">{request.description}</p>}
          <div className="approval-command">
            <span>実行しようとしているコマンド</span>
            <code>{request.command || 'コマンド情報なし'}</code>
          </div>
          {request.error && <p className="approval-error" role="alert">{request.error}</p>}
          <div className="approval-primary-actions">
            {canChoose('once') && (
              <button type="button" disabled={disabled} onClick={() => void onRespond('once')}>今回だけ許可</button>
            )}
            {canChoose('deny') && (
              <button type="button" className="approval-deny" disabled={disabled} onClick={() => void onRespond('deny')}>拒否</button>
            )}
          </div>

          {(canChoose('session') || canChoose('always')) && (
            <details className="approval-expanded-actions">
              <summary>許可範囲を広げる</summary>
              <p>繰り返し確認を省けますが、同種の操作が自動で実行される範囲が広がります。</p>
              <div>
                {canChoose('session') && (
                  <button type="button" disabled={disabled} onClick={() => void onRespond('session')}>
                    このセッション中は許可
                  </button>
                )}
                {canChoose('always') && !confirmingAlways && (
                  <button type="button" className="approval-always" disabled={disabled} onClick={() => setConfirmingAlways(true)}>
                    今後も許可
                  </button>
                )}
              </div>
            </details>
          )}

          {confirmingAlways && request.status === 'pending' && (
            <div className="approval-confirm-always" role="alert">
              <strong>今後の同種操作も確認なしで許可しますか？</strong>
              <p>この選択は今回のRun終了後にも影響する可能性があります。</p>
              <div>
                <button type="button" className="approval-always" onClick={() => void onRespond('always')}>今後も許可する</button>
                <button type="button" className="approval-back" onClick={() => setConfirmingAlways(false)}>戻る</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
