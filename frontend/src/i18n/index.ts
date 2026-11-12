// UI翻訳を一か所で初期化し、追加言語と日本語へのフォールバックを提供します。
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import ja from '../../../assets/locales/ja.json'
import en from '../../../assets/locales/en.json'

export { useTranslation } from 'react-i18next'

export interface UiLanguage {
  code: string
  name: string
}

const japanese = Object.fromEntries(Object.entries(ja).filter(([key]) => key !== '_meta')) as Record<string, string>
const english = Object.fromEntries(Object.entries(en).filter(([key]) => key !== '_meta')) as Record<string, string>
const catalogs = [japanese, english]

export const languages: UiLanguage[] = [
  { code: 'ja', name: ja._meta.name },
  { code: 'en', name: en._meta.name },
]

// APIへ到達できない場合でも、接続エラー自体を表示できるよう同梱訳を用意します。
void i18n.use(initReactI18next).init({
  lng: 'ja',
  fallbackLng: 'ja',
  keySeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { ja: { translation: japanese }, en: { translation: english } },
})

/** 翻訳資産が削除されたブラウザ保存値は、日本語として表示します。 */
export function resolveLanguage(code: string): string {
  return languages.some((language) => language.code === code) ? code : 'ja'
}

/** 保存操作を伴わず、現在の画面と言語属性だけを切り替えます。 */
export function changeLanguage(code: string): void {
  const language = resolveLanguage(code)
  document.documentElement.lang = language
  if (i18n.language !== language) void i18n.changeLanguage(language)
}

/** React以外のエラー生成やモーション処理からも、同じ辞書を参照します。 */
export function t(key: string, values: Record<string, string | number> = {}): string {
  return i18n.t(key, values) as string
}

/** 壊れた差し込み変数で文面が欠けないよう、原文と同じ変数を持つ項目だけ採用します。 */
function variables(text: string): string {
  return [...text.matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)].map((match) => match[1]).sort().join(',')
}

/** 起動時に両資産ディレクトリを読み、利用者の追加訳を再ビルドなしで使います。 */
export async function loadLocales(): Promise<void> {
  try {
    const response = await fetch('/api/locales', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return
    const payload = await response.json() as { data?: unknown }
    if (!Array.isArray(payload.data)) return
    for (const raw of payload.data) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      if (typeof item.code !== 'string' || item.code.length > 64 || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item.code)
        || typeof item.name !== 'string' || !item.messages || typeof item.messages !== 'object') continue
      const messages: Record<string, string> = {}
      for (const [key, value] of Object.entries(item.messages)) {
        if (typeof value !== 'string' || !value.trim()) continue
        if (/[{}]/.test(value.replace(/\{\{[A-Za-z][A-Za-z0-9]*\}\}/g, ''))) continue
        if (japanese[key] !== undefined && variables(japanese[key]) !== variables(value)) continue
        messages[key] = value
      }
      i18n.addResourceBundle(item.code, 'translation', messages, true, true)
      catalogs.push(messages)
      const existing = languages.find((language) => language.code === item.code)
      if (existing) existing.name = item.name
      else languages.push({ code: item.code, name: item.name })
    }
    patterns.splice(0, patterns.length, ...messagePatterns())
  } catch {
    // 接続障害や不正な追加JSONでも、同梱訳で設定画面とエラーを表示します。
  }
}

// API由来の通知は文章から推測せず、受信した翻訳情報を保持して再表示します。
const receivedMessages = new Map<string, Record<string, unknown>>()

interface MessagePattern {
  key: string
  expression: RegExp
  names: string[]
}

/** フロント内部に保存済みの通知だけを再表示する互換処理です。APIはキーで解決します。 */
function messagePatterns(): MessagePattern[] {
  const patterns: MessagePattern[] = []
  for (const catalog of catalogs) {
    for (const [key, text] of Object.entries(catalog)) {
      const names: string[] = []
      const pieces = text.split(/(\{\{[A-Za-z][A-Za-z0-9]*\}\})/g).map((piece) => {
        if (piece.startsWith('{{')) {
          names.push(piece.slice(2, -2))
          return '([\\s\\S]*?)'
        }
        return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      // 値だけのテンプレートが未知のメッセージへ一致しないよう、固定部分を必須にします。
      if (!text.replace(/\{\{[^{}]+\}\}/g, '').trim()) continue
      // 秒数や件数のような短いテンプレートで、未知の外部エラーを誤認しません。
      if (names.length && !/(?:errors\.|^gateway\.|^app\.recovery\.|^app\.settings\.)/.test(key)) continue
      patterns.push({ key, expression: new RegExp(`^${pieces.join('')}$`), names })
    }
  }
  return patterns.sort((a, b) => a.names.length - b.names.length)
}

const patterns = messagePatterns()

/** 状態に保存済みの通知やAPI由来のエラーも、画面を切り替えた時点の言語で表示します。 */
export function translateMessage(message: string, depth = 0): string {
  const reference = receivedMessages.get(message)
  if (reference) return readMessage(reference, message)
  for (const pattern of patterns) {
    const match = message.match(pattern.expression)
    if (match) {
      const values = Object.fromEntries(pattern.names.map((name, index) => [
        name, name === 'detail' && depth < 2 ? translateMessage(match[index + 1], depth + 1) : match[index + 1],
      ]))
      return t(pattern.key, values)
    }
  }
  return message
}

/** APIの翻訳キーを優先し、未知の上流診断だけは渡された原文を保持します。 */
export function readMessage(value: unknown, fallback = '', depth = 0): string {
  if (!value || typeof value !== 'object') return fallback
  const payload = value as Record<string, unknown>
  const key = payload.message_key
  if (typeof key === 'string' && i18n.exists(key) && depth < 5) {
    const values: Record<string, string | number> = {}
    if (payload.message_params && typeof payload.message_params === 'object') {
      for (const [name, parameter] of Object.entries(payload.message_params)) {
        if (typeof parameter === 'string' || typeof parameter === 'number') values[name] = parameter
        else if (parameter && typeof parameter === 'object') values[name] = readMessage(parameter, '', depth + 1)
      }
    }
    const rendered = t(key, values)
    // 通知の再表示に必要な分だけを保持し、長期利用時の蓄積を制限します。
    receivedMessages.set(rendered, payload)
    if (receivedMessages.size > 256) receivedMessages.delete(receivedMessages.keys().next().value!)
    return rendered
  }
  for (const field of ['detail', 'message', 'reason', 'content']) {
    if (typeof payload[field] === 'string') return payload[field] as string
  }
  return fallback
}

/** HTTPエラーのキーを共通処理で解決し、HTML応答でも呼び出し元の説明を残します。 */
export async function readResponseMessage(response: Response, fallback: string): Promise<string> {
  try {
    return readMessage(await response.json(), fallback)
  } catch {
    return fallback
  }
}

/** 無応答などアプリが付けた案内だけを訳し、通常の会話本文はそのまま表示します。 */
export function messageContent(message: { content: string; message_key?: string; message_params?: Record<string, unknown> }): string {
  return message.message_key ? readMessage(message, message.content) : message.content
}
