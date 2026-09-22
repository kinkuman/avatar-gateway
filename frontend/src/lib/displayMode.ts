// 端末ごとの画面モードを検証して保存し、共有設定へ端末の向きを持ち込みません。

import type { DisplayMode } from '../types'

export const DISPLAY_MODE_STORAGE_KEY = 'avatar-gateway.display-mode'

/** 保存済みの明示選択を優先し、初回だけ縦長の小画面を会話モードにします。 */
export function readDisplayMode(storage: Storage, portraitSmallScreen: boolean): DisplayMode {
  const stored = storage.getItem(DISPLAY_MODE_STORAGE_KEY)
  if (stored === 'standard' || stored === 'conversation') return stored
  return portraitSmallScreen ? 'conversation' : 'standard'
}

/** 利用者が選んだモードを、このブラウザだけの表示設定として保存します。 */
export function saveDisplayMode(storage: Storage, mode: DisplayMode): void {
  storage.setItem(DISPLAY_MODE_STORAGE_KEY, mode)
}
