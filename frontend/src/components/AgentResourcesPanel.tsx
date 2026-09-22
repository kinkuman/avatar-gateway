/* Hermesが現在利用できるSkillとToolsetを、変更操作なしで確認する画面です。 */

import { useEffect, useState } from 'react'

import { readSkills, readToolsets } from '../lib/agentResources'
import type { HermesSkillSummary, HermesToolsetSummary } from '../types'

/** 二つの参照APIを並行取得し、Hermesエージェントの現在の能力を一覧表示します。 */
export default function AgentResourcesPanel() {
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
        if (!skillsResponse.ok) throw new Error(`Skill一覧APIエラー: ${skillsResponse.status}`)
        if (!toolsetsResponse.ok) throw new Error(`Toolset一覧APIエラー: ${toolsetsResponse.status}`)
        const nextSkills = readSkills(await skillsResponse.json())
        const nextToolsets = readToolsets(await toolsetsResponse.json())
        if (!nextSkills || !nextToolsets) throw new Error('Hermes機能一覧の応答形式が正しくありません。')
        setSkills(nextSkills)
        setToolsets(nextToolsets)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : 'Hermes機能一覧を取得できませんでした。')
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
    <section className="agent-resources" aria-label="Hermes機能一覧">
      <header className="agent-resources-header">
        <div>
          <span>READ ONLY</span>
          <h2>Hermesの機能</h2>
          <p>現在のAPI Serverがエージェントへ公開しているSkillとToolsetです。ここから設定は変更しません。</p>
        </div>
        <button type="button" disabled={loading} onClick={() => setReloadToken((current) => current + 1)}>
          {loading ? '読込中…' : '再読込'}
        </button>
      </header>

      <div className="agent-resources-scroll">
        {error && <p className="agent-resources-error" role="alert">{error}</p>}
        {loading && <p className="session-placeholder">Hermesの機能を読み込み中…</p>}
        {!loading && !error && (
          <>
            <section className="resource-section">
              <div className="resource-section-heading">
                <h3>有効なToolset</h3>
                <span>{enabledToolsets.length}</span>
              </div>
              {enabledToolsets.length === 0 && <p className="resource-empty">有効なToolsetはありません。</p>}
              <div className="resource-grid">
                {enabledToolsets.map((toolset) => <ToolsetCard key={toolset.name} toolset={toolset} />)}
              </div>
            </section>

            {disabledToolsets.length > 0 && (
              <details className="disabled-toolsets">
                <summary>無効なToolset ({disabledToolsets.length})</summary>
                <div className="resource-grid">
                  {disabledToolsets.map((toolset) => <ToolsetCard key={toolset.name} toolset={toolset} />)}
                </div>
              </details>
            )}

            <section className="resource-section">
              <div className="resource-section-heading">
                <h3>利用可能なSkill</h3>
                <span>{skills.length}</span>
              </div>
              {skills.length === 0 && <p className="resource-empty">利用可能なSkillはありません。</p>}
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
        <span>{toolset.enabled ? '有効' : toolset.configured ? '設定済み・無効' : '未設定'}</span>
      </div>
      {toolset.description && <p>{toolset.description}</p>}
      <div className="resource-tool-list">
        {toolset.tools.length > 0
          ? toolset.tools.map((tool) => <code key={tool}>{tool}</code>)
          : <span>展開できるツールはありません</span>}
      </div>
    </article>
  )
}
