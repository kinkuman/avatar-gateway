/* HermesのSkill・Toolset一覧を、画面で安全に使える型へ絞り込む変換処理です。 */

import type { HermesSkillSummary, HermesToolsetSummary } from '../types'

/** 一覧応答から名前を持つSkillだけを抽出し、未知のフィールドを捨てます。 */
export function readSkills(data: unknown): HermesSkillSummary[] | null {
  if (!data || typeof data !== 'object') return null
  const payload = data as Record<string, unknown>
  if (!Array.isArray(payload.data)) return null
  const skills: HermesSkillSummary[] = []
  for (const item of payload.data) {
    if (!item || typeof item !== 'object') return null
    const skill = item as Record<string, unknown>
    if (typeof skill.name !== 'string' || !skill.name.trim()) return null
    skills.push({
      name: skill.name.trim(),
      description: typeof skill.description === 'string' ? skill.description : '',
      category: typeof skill.category === 'string' ? skill.category : '',
    })
  }
  return skills
}

/** Toolsetの有効状態と公開ツール名だけを検証し、設定値を受け入れません。 */
export function readToolsets(data: unknown): HermesToolsetSummary[] | null {
  if (!data || typeof data !== 'object') return null
  const payload = data as Record<string, unknown>
  if (!Array.isArray(payload.data)) return null
  const toolsets: HermesToolsetSummary[] = []
  for (const item of payload.data) {
    if (!item || typeof item !== 'object') return null
    const toolset = item as Record<string, unknown>
    if (typeof toolset.name !== 'string' || !toolset.name.trim() || !Array.isArray(toolset.tools)) return null
    if (!toolset.tools.every((tool) => typeof tool === 'string' && tool.trim())) return null
    toolsets.push({
      name: toolset.name.trim(),
      label: typeof toolset.label === 'string' && toolset.label.trim()
        ? toolset.label.trim()
        : toolset.name.trim(),
      description: typeof toolset.description === 'string' ? toolset.description : '',
      enabled: toolset.enabled === true,
      configured: toolset.configured === true,
      tools: toolset.tools.map((tool) => (tool as string).trim()),
    })
  }
  return toolsets
}
