// Hermesが停止して待っている危険操作を、影響範囲の説明付きで判断するパネルです。
import { t, useTranslation, translateMessage } from '../i18n'
import { useEffect, useState } from 'react'

import type { ApprovalChoice, ApprovalRequestState } from '../types'

// 承認の許可範囲を翻訳キーへ対応付けます。
const choiceLabels: Record<ApprovalChoice, string> = {
  once: 'approval.choices.once', // 今回の操作だけ許可
  session: 'approval.choices.session', // 現在のセッション内で許可
  always: 'approval.choices.always', // 以後の同種操作も許可
  deny: 'approval.choices.deny', // 実行を拒否
}

interface ApprovalPanelProps {
  request: ApprovalRequestState | null
  onRespond: (choice: ApprovalChoice) => Promise<void>
}

/** 影響範囲の広いalwaysだけ再確認し、主要な一回許可と拒否は直接選べるようにします。 */
export default function ApprovalPanel({ request, onRespond }: ApprovalPanelProps) {
  useTranslation()
  const [confirmingAlways, setConfirmingAlways] = useState(false)

  useEffect(() => {
    setConfirmingAlways(false)
  }, [request?.id])

  if (!request) return null
  const disabled = request.status !== 'pending'
  const canChoose = (choice: ApprovalChoice) => request.choices.includes(choice)

  return (
    <section className="approval-panel" aria-label={t('approval.panelLabel')} aria-live="assertive">
      <header className="approval-header">
        <div>
          <span className="approval-eyebrow">{t('approval.eyebrow')}</span>
          <h2>{t('approval.title')}</h2>
        </div>
        <span className={`approval-status approval-status-${request.status}`}>
          {request.status === 'submitting' ? t('approval.status.submitting') : request.status === 'resolved' ? t('approval.status.resolved') : t('approval.status.pending')}
        </span>
      </header>

      {request.status === 'resolved' ? (
        <p className="approval-result">
          {t('approval.result', { choice: request.resolvedChoice ? t(choiceLabels[request.resolvedChoice]) : t('approval.status.resolved') })}
        </p>
      ) : (
        <>
          {request.description && <p className="approval-description">{request.description}</p>}
          <div className="approval-command">
            <span>{t('approval.commandLabel')}</span>
            <code>{request.command || t('approval.commandUnavailable')}</code>
          </div>
          {request.error && <p className="approval-error" role="alert">{translateMessage(request.error)}</p>}
          <div className="approval-primary-actions">
            {canChoose('once') && (
              <button type="button" disabled={disabled} onClick={() => void onRespond('once')}>{t('approval.choices.once')}</button>
            )}
            {canChoose('deny') && (
              <button type="button" className="approval-deny" disabled={disabled} onClick={() => void onRespond('deny')}>{t('approval.choices.deny')}</button>
            )}
          </div>

          {(canChoose('session') || canChoose('always')) && (
            <details className="approval-expanded-actions">
              <summary>{t('approval.expandScope')}</summary>
              <p>{t('approval.expandScopeDescription')}</p>
              <div>
                {canChoose('session') && (
                  <button type="button" disabled={disabled} onClick={() => void onRespond('session')}>
                    {t('approval.choices.session')}</button>
                )}
                {canChoose('always') && !confirmingAlways && (
                  <button type="button" className="approval-always" disabled={disabled} onClick={() => setConfirmingAlways(true)}>
                    {t('approval.choices.always')}</button>
                )}
              </div>
            </details>
          )}

          {confirmingAlways && request.status === 'pending' && (
            <div className="approval-confirm-always" role="alert">
              <strong>{t('approval.confirmAlways')}</strong>
              <p>{t('approval.confirmAlwaysDescription')}</p>
              <div>
                <button type="button" className="approval-always" onClick={() => void onRespond('always')}>{t('approval.allowAlways')}</button>
                <button type="button" className="approval-back" onClick={() => setConfirmingAlways(false)}>{t('approval.back')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
