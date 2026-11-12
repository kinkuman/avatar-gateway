// 旧ブラウザ設定とサーバー既定値の間で、表示言語の優先順位を保つ回帰テストです。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fallbackUiSettings,
  mergeUiSettings,
  readUiSettings,
  readUiSettingsOverrides,
  saveUiSettingsOverrides,
  UI_SETTINGS_STORAGE_KEY,
} from '../src/lib/uiSettings.ts'

/** ブラウザを起動せず、実際と同じStorage操作で差分の保存・解除を確認します。 */
function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

test('ブラウザ選択を優先し、差分をリセットするとサーバーの表示言語へ戻る', () => {
  const storage = memoryStorage()
  const defaults = { ...fallbackUiSettings, language: 'en' }
  assert.equal(mergeUiSettings(defaults, readUiSettingsOverrides(storage)).language, 'en')
  saveUiSettingsOverrides(storage, { language: 'id' })
  assert.equal(mergeUiSettings(defaults, readUiSettingsOverrides(storage)).language, 'id')
  saveUiSettingsOverrides(storage, {})
  assert.equal(mergeUiSettings(defaults, readUiSettingsOverrides(storage)).language, 'en')
})

test('旧設定は日本語へ戻し、不正な言語コードはブラウザ差分へ取り込まない', () => {
  const legacy: Record<string, unknown> = { ...fallbackUiSettings }
  delete legacy.language
  assert.equal(readUiSettings(legacy)?.language, 'ja')
  const storage = memoryStorage()
  storage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify({ language: '../en', speech_volume: 0.5 }))
  assert.deepEqual(readUiSettingsOverrides(storage), { speech_volume: 0.5 })
})
