// 画面上部の主要操作を、省スペースで判別しやすい共通線画アイコンとして描画します。

export type SessionActionIconName =
  | 'conversation'
  | 'standard'
  | 'history'
  | 'features'
  | 'settings'
  | 'new-session'

interface Props {
  name: SessionActionIconName
}

/** ボタン側の日本語ラベルを支援技術へ任せ、装飾用SVGだけを統一した寸法で返します。 */
export default function SessionActionIcon({ name }: Props) {
  const common = {
    className: 'session-action-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  }

  if (name === 'conversation') {
    return (
      <svg {...common}>
        <path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4" />
        <circle cx="12" cy="9" r="2.75" />
        <path d="M7.25 17.5c.45-3 2.05-4.5 4.75-4.5s4.3 1.5 4.75 4.5" />
      </svg>
    )
  }
  if (name === 'standard') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M14 4v16M17 8h1M17 12h1M17 16h1" />
      </svg>
    )
  }
  if (name === 'history') {
    return (
      <svg {...common}>
        <path d="M4 7v4h4M4.8 10.5a8 8 0 1 1 .7 5.2" />
        <path d="M12 7v5l3 2" />
      </svg>
    )
  }
  if (name === 'features') {
    return (
      <svg {...common}>
        <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.3" />
        <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.3" />
        <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.3" />
        <rect x="14" y="14" width="6.5" height="6.5" rx="1.3" />
      </svg>
    )
  }
  if (name === 'settings') {
    return (
      <svg {...common}>
        <path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M4 5h16v11H9l-4 3v-3H4z" />
      <path d="M12 8v5M9.5 10.5h5" />
    </svg>
  )
}
