// 画面右上から、Hermesが提供するモデルへ切り替えます。

import { useEffect, useId, useRef, useState } from 'react'

import SessionActionIcon from './SessionActionIcon'

interface ProviderOption {
  slug: string
  name: string
  models: string[]
  truncated: boolean
}

interface ModelCatalog {
  defaultModel: string
  selected: { model: string, provider: string } | null
  currentModel: string
  currentProvider: string
  providers: ProviderOption[]
}

interface Props {
  sessionId: string | null
  disabled: boolean
}

function readCatalog(payload: unknown): ModelCatalog | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.default_model !== 'string' || !Array.isArray(record.providers)) return null
  const providers: ProviderOption[] = []
  for (const item of record.providers) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    if (typeof row.slug !== 'string' || typeof row.name !== 'string' || !Array.isArray(row.models)) return null
    if (!row.models.every((model) => typeof model === 'string')) return null
    providers.push({
      slug: row.slug,
      name: row.name,
      models: row.models,
      truncated: row.truncated === true,
    })
  }
  const selectedRecord = record.selected
  const selected = selectedRecord && typeof selectedRecord === 'object'
    && typeof (selectedRecord as { model?: unknown }).model === 'string'
    && typeof (selectedRecord as { provider?: unknown }).provider === 'string'
    ? {
      model: (selectedRecord as { model: string }).model,
      provider: (selectedRecord as { provider: string }).provider,
    }
    : null
  return {
    defaultModel: record.default_model,
    selected,
    currentModel: typeof record.current_model === 'string' ? record.current_model : '',
    currentProvider: typeof record.current_provider === 'string' ? record.current_provider : '',
    providers,
  }
}

/** 機能一覧の右に置き、開いたときだけHermesのモデル一覧を取得します。 */
export default function ModelSelectMenu({ sessionId, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [busyModel, setBusyModel] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const response = await fetch('/api/hermes/models', { signal: controller.signal })
        if (!response.ok) throw new Error(`モデル一覧を取得できませんでした (${response.status})`)
        const next = readCatalog(await response.json())
        if (!next) throw new Error('モデル一覧の形式が正しくありません。')
        setCatalog(next)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : 'モデル一覧を取得できませんでした。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [open])

  const activeLabel = catalog?.selected?.model ?? catalog?.defaultModel ?? ''
  const normalizedQuery = query.trim().toLowerCase()
  const visibleProviders = (catalog?.providers ?? []).map((provider) => ({
    ...provider,
    models: provider.models.filter((model) => (
      !normalizedQuery
      || model.toLowerCase().includes(normalizedQuery)
      || provider.name.toLowerCase().includes(normalizedQuery)
    )),
  })).filter((provider) => provider.models.length > 0)

  const selectModel = async (model: string | null, provider: string | null) => {
    setBusyModel(model ?? '__default__')
    setError('')
    try {
      const response = await fetch('/api/hermes/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          use_default: model === null,
          model,
          provider,
          session_id: sessionId,
        }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { detail?: unknown } | null
        const detail = typeof payload?.detail === 'string' ? payload.detail : `モデルを切り替えられませんでした (${response.status})`
        throw new Error(detail)
      }
      const payload = await response.json() as { selected?: { model?: string, provider?: string } | null }
      setCatalog((current) => current && ({
        ...current,
        selected: payload.selected?.model && payload.selected.provider
          ? { model: payload.selected.model, provider: payload.selected.provider }
          : null,
      }))
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'モデルを切り替えられませんでした。')
    } finally {
      setBusyModel('')
    }
  }

  return (
    <div className="model-select" ref={rootRef}>
      <button
        type="button"
        className="model-select-button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={listId}
        aria-label={activeLabel ? `モデルを切り替える（現在: ${activeLabel}）` : 'モデルを切り替える'}
        title={activeLabel ? `モデルを切り替える（現在: ${activeLabel}）` : 'モデルを切り替える'}
      >
        <SessionActionIcon name="model" />
      </button>
      {open && (
        <div className="model-select-menu" id={listId} role="dialog" aria-label="モデル選択">
          <input
            className="model-select-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="モデルを絞り込む"
            aria-label="モデルを絞り込む"
          />
          {loading && <p className="model-select-status">読み込み中です</p>}
          {error && <p className="model-select-error">{error}</p>}
          {catalog && (
            <div className="model-select-list">
              <button
                type="button"
                className={catalog.selected ? undefined : 'active'}
                disabled={busyModel !== ''}
                onClick={() => void selectModel(null, null)}
              >
                既定のモデル（{catalog.defaultModel}）
              </button>
              {visibleProviders.map((provider) => (
                <section key={provider.slug}>
                  <h3>{provider.name}</h3>
                  {provider.models.map((model) => {
                    const active = catalog.selected?.model === model && catalog.selected.provider === provider.slug
                    return (
                      <button
                        type="button"
                        key={`${provider.slug}:${model}`}
                        className={active ? 'active' : undefined}
                        disabled={busyModel !== ''}
                        onClick={() => void selectModel(model, provider.slug)}
                      >
                        {model}
                      </button>
                    )
                  })}
                  {provider.truncated && <p className="model-select-status">一部のみ表示しています</p>}
                </section>
              ))}
              {!loading && visibleProviders.length === 0 && <p className="model-select-status">一致するモデルがありません</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
