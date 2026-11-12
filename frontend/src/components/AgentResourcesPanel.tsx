/* Hermesが現在利用できるSkillとToolsetを、変更操作なしで確認する画面です。 */
import { readResponseMessage, t, useTranslation, translateMessage } from '../i18n'

import { useEffect, useState } from 'react'

import { readSkills, readToolsets } from '../lib/agentResources'
import type { HermesSkillSummary, HermesToolsetSummary } from '../types'

/** 二つの参照APIを並行取得し、Hermesエージェントの現在の能力を一覧表示します。 */
export default function AgentResourcesPanel() {
  useTranslation()
  const [skills, setSkills] = useState<HermesSkillSummary[]>([])
  const [toolsets, setToolsets] = useState<HermesToolsetSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    /** 片方だけ古い表示を残さないよう、両APIの検証完了後にまとめて反映します。 */
    const loadResources = async () => {
      setLoading(true)
      setError('')
      try {
        const [skillsResponse, toolsetsResponse] = await Promise.all([
          fetch('/api/hermes/skills', { signal: controller.signal }),
          fetch('/api/hermes/toolsets', { signal: controller.signal }),
        ])
        // ここで中断する条件: Skill一覧APIエラー: 対象値。
        if (!skillsResponse.ok) throw new Error(await readResponseMessage(skillsResponse, t('resources.errors.skillsStatus', { status: skillsResponse.status })))
        // ここで中断する条件: Toolset一覧APIエラー: 対象値。
        if (!toolsetsResponse.ok) throw new Error(await readResponseMessage(toolsetsResponse, t('resources.errors.toolsetsStatus', { status: toolsetsResponse.status })))
        const nextSkills = readSkills(await skillsResponse.json())
        const nextToolsets = readToolsets(await toolsetsResponse.json())
        // ここで中断する条件: Hermes機能一覧の応答形式が正しくありません。
        if (!nextSkills || !nextToolsets) throw new Error(t('resources.errors.responseFormat'))
        setSkills(nextSkills)
        setToolsets(nextToolsets)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        // Hermes機能一覧の取得失敗を利用者へ知らせます。
        setError(cause instanceof Error ? cause.message : t('resources.errors.fetch'))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    void loadResources()
    return () => controller.abort()
  }, [reloadToken])

  const enabledToolsets = toolsets.filter((toolset) => toolset.enabled)
  const disabledToolsets = toolsets.filter((toolset) => !toolset.enabled)

  return (
    <section className="agent-resources" aria-label={t('resources.panelLabel')}>
      <header className="agent-resources-header">
        <div>
          <span>{t('resources.readOnly')}</span>
          <h2>{t('resources.title')}</h2>
          <p>{t('resources.description')}</p>
        </div>
        <button type="button" disabled={loading} onClick={() => setReloadToken((current) => current + 1)}>
          {loading ? t('resources.loading') : t('resources.reload')}
        </button>
      </header>

      <div className="agent-resources-scroll">
        {error && <p className="agent-resources-error" role="alert">{translateMessage(error)}</p>}
        {loading && <p className="session-placeholder">{t('resources.loadingResources')}</p>}
        {!loading && !error && (
          <>
            {/* 現在有効なツール群を参照表示します。 */}
            <section className="resource-section">
              <div className="resource-section-heading">
                <h3>{t('resources.enabledToolsets')}</h3>
                <span>{enabledToolsets.length}</span>
              </div>
              {enabledToolsets.length === 0 && <p className="resource-empty">{t('resources.noEnabledToolsets')}</p>}
              <div className="resource-grid">
                {enabledToolsets.map((toolset) => <ToolsetCard key={toolset.name} toolset={toolset} />)}
              </div>
            </section>

            {disabledToolsets.length > 0 && (
              <details className="disabled-toolsets">
                <summary>{t('resources.disabledToolsets', { count: disabledToolsets.length })}</summary>
                <div className="resource-grid">
                  {disabledToolsets.map((toolset) => <ToolsetCard key={toolset.name} toolset={toolset} />)}
                </div>
              </details>
            )}

            {/* 利用可能なスキルを参照表示します。 */}
            <section className="resource-section">
              <div className="resource-section-heading">
                <h3>{t('resources.availableSkills')}</h3>
                <span>{skills.length}</span>
              </div>
              {skills.length === 0 && <p className="resource-empty">{t('resources.noAvailableSkills')}</p>}
              <div className="resource-grid">
                {skills.map((skill) => (
                  <article className="resource-card" key={skill.name}>
                    <div className="resource-card-title">
                      <strong>{skill.name}</strong>
                      {skill.category && <span>{skill.category}</span>}
                    </div>
                    {skill.description && <p>{skill.description}</p>}
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </section>
  )
}

/** Toolsetの状態と展開後ツールを一枚にまとめ、設定済みと有効を混同させません。 */
function ToolsetCard({ toolset }: { toolset: HermesToolsetSummary }) {
  return (
    <article className={`resource-card toolset-card${toolset.enabled ? ' enabled' : ''}`}>
      <div className="resource-card-title">
        <strong>{toolset.label}</strong>
        <span>{toolset.enabled ? t('resources.enabled') : toolset.configured ? t('resources.configuredDisabled') : t('resources.unconfigured')}</span>
      </div>
      {toolset.description && <p>{toolset.description}</p>}
      <div className="resource-tool-list">
        {toolset.tools.length > 0
          ? toolset.tools.map((tool) => <code key={tool}>{tool}</code>)
          : <span>{t('resources.noTools')}</span>}
      </div>
    </article>
  )
}
