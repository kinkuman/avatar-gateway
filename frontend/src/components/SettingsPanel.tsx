// ブラウザ固有のUI調整と、明示操作によるサーバー既定値保存を一画面にまとめます。

import type {
  BackgroundAsset,
  UiCameraSettings,
  UiSettings,
  UiSettingsOverrides,
  VrmTouchRegion,
} from '../types'

const touchRegionLabels: Record<VrmTouchRegion, string> = {
  head: '頭',
  ear: '耳',
  tail: '尻尾',
  chest: '胸',
  hips: '尻',
  groin: '股間',
  thigh: '太もも',
  hand: '手',
  foot: '足',
}

interface Props {
  settings: UiSettings
  currentCamera: UiCameraSettings | null
  savingDefaults: boolean
  message: string
  error: string
  backgrounds: BackgroundAsset[]
  backgroundsLoading: boolean
  backgroundsError: string
  onChange: (changes: UiSettingsOverrides) => void
  onReloadBackgrounds: () => void
  onResetBrowser: () => void
  onSaveDefaults: () => void
}

/** 影響範囲の異なるブラウザ保存とサーバー保存を、誤操作しにくい形で提示します。 */
export default function SettingsPanel({
  settings,
  currentCamera,
  savingDefaults,
  message,
  error,
  backgrounds,
  backgroundsLoading,
  backgroundsError,
  onChange,
  onReloadBackgrounds,
  onResetBrowser,
  onSaveDefaults,
}: Props) {
  return (
    <section className="ui-settings" aria-label="表示と音声の設定">
      <header className="ui-settings-header">
        <div>
          <span>THIS BROWSER</span>
          <h2>設定</h2>
          <p>変更はこのブラウザへ自動保存されます。秘密情報やHermesの設定は扱いません。</p>
        </div>
      </header>

      <div className="ui-settings-scroll">
        <section className="ui-settings-section">
          <h3>壁紙</h3>
          <p>同梱画像と`local-assets/backgrounds/`へ追加したPNG、JPEG、WebPをアバターの背景に表示します。</p>
          <label className="settings-select">
            <span>画像</span>
            <select
              value={settings.background.file ?? ''}
              onChange={(event) => onChange({
                background: {
                  ...settings.background,
                  file: event.target.value || null,
                },
              })}
            >
              <option value="">壁紙なし</option>
              {settings.background.file
                && !backgrounds.some((background) => background.file === settings.background.file)
                && <option value={settings.background.file}>{settings.background.file}（見つかりません）</option>}
              {backgrounds.map((background) => (
                <option key={background.file} value={background.file}>{background.file}</option>
              ))}
            </select>
          </label>
          <label className="settings-select">
            <span>表示方法</span>
            <select
              value={settings.background.fit}
              onChange={(event) => onChange({
                background: {
                  ...settings.background,
                  fit: event.target.value === 'contain' ? 'contain' : 'cover',
                },
              })}
            >
              <option value="cover">画面全体を覆う</option>
              <option value="contain">画像全体を収める</option>
            </select>
          </label>
          <div className="settings-row-actions">
            <button type="button" disabled={backgroundsLoading} onClick={onReloadBackgrounds}>
              {backgroundsLoading ? '読込中…' : '画像一覧を再読込'}
            </button>
          </div>
          {backgroundsError && <p className="settings-error" role="alert">{backgroundsError}</p>}
        </section>

        <section className="ui-settings-section">
          <h3>表示</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.show_motion_controls}
              onChange={(event) => onChange({ show_motion_controls: event.target.checked })}
            />
            <span><strong>モーション確認ボタン</strong><small>VRMAを手動確認するときだけ表示します。</small></span>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.show_camera_help}
              onChange={(event) => onChange({ show_camera_help: event.target.checked })}
            />
            <span><strong>カメラ操作案内</strong><small>アバター上の操作説明とリセットボタンを表示します。</small></span>
          </label>
        </section>

        <section className="ui-settings-section">
          <h3>ふれあい</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.touch_interaction.enabled}
              onChange={(event) => {
                const enabled = event.target.checked
                onChange({
                  touch_interaction: {
                    ...settings.touch_interaction,
                    enabled,
                    // 親機能を切った後に、非表示の編集モードだけが残らないよう同時に解除します。
                    edit_hitboxes: enabled ? settings.touch_interaction.edit_hitboxes : false,
                  },
                })
              }}
            />
            <span><strong>ふれあい機能</strong><small>ボタンまたはSpace長押し中に、VRMの部位へ触れられます。</small></span>
          </label>
          <fieldset className="touch-region-settings" disabled={!settings.touch_interaction.enabled}>
            <legend>反応する部位</legend>
            <div>
              {(Object.entries(touchRegionLabels) as [VrmTouchRegion, string][])
                .filter(([region]) => (
                  settings.touch_interaction.extended_regions_enabled
                  || region === 'head'
                  || region === 'ear'
                  || region === 'tail'
                  || region === 'hand'
                ))
                .map(([region, label]) => (
                  <label key={region}>
                    <input
                      type="checkbox"
                      checked={settings.touch_interaction.regions[region]}
                      onChange={(event) => onChange({
                        touch_interaction: {
                          ...settings.touch_interaction,
                          regions: {
                            ...settings.touch_interaction.regions,
                            [region]: event.target.checked,
                          },
                        },
                      })}
                    />
                    {label}
                  </label>
                ))}
            </div>
          </fieldset>
          <label className="settings-toggle touch-debug-toggle">
            <input
              type="checkbox"
              checked={settings.touch_interaction.debug_hitboxes}
              disabled={!settings.touch_interaction.enabled}
              onChange={(event) => onChange({
                touch_interaction: {
                  ...settings.touch_interaction,
                  debug_hitboxes: event.target.checked,
                },
              })}
            />
            <span><strong>当たり判定を表示</strong><small>位置調整用です。通常利用ではOFFにします。</small></span>
          </label>
          <label className="settings-toggle touch-debug-toggle">
            <input
              type="checkbox"
              checked={settings.touch_interaction.edit_hitboxes}
              disabled={!settings.touch_interaction.enabled}
              onChange={(event) => onChange({
                touch_interaction: {
                  ...settings.touch_interaction,
                  edit_hitboxes: event.target.checked,
                },
              })}
            />
            <span><strong>当たり判定を編集</strong><small>アバター画面で判定を選び、移動・拡縮します。調整値はVRM別に保存されます。</small></span>
          </label>
          <label className="settings-toggle touch-debug-toggle">
            <input
              type="checkbox"
              checked={settings.touch_interaction.recoil_test_enabled}
              disabled={!settings.touch_interaction.enabled}
              onChange={(event) => onChange({
                touch_interaction: {
                  ...settings.touch_interaction,
                  recoil_test_enabled: event.target.checked,
                },
              })}
            />
            <span><strong>反動だけテスト</strong><small>VRMの反動だけを確認し、Hermesへ接触を送信しません。</small></span>
          </label>
        </section>

        <section className="ui-settings-section">
          <h3>音声</h3>
          <label className="settings-range">
            <span><strong>読み上げ音量</strong><output>{Math.round(settings.speech_volume * 100)}%</output></span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.speech_volume}
              onChange={(event) => onChange({ speech_volume: Number(event.target.value) })}
            />
          </label>
          <label className="settings-range voice-input-setting">
            <span>
              <strong>話し終わりの無音時間</strong>
              <output>{(settings.voice_input.silence_ms / 1000).toFixed(1)}秒</output>
            </span>
            <input
              type="range"
              min="600"
              max="2000"
              step="100"
              value={settings.voice_input.silence_ms}
              onChange={(event) => onChange({
                voice_input: {
                  ...settings.voice_input,
                  silence_ms: Number(event.target.value),
                },
              })}
            />
          </label>
          <label className="settings-range voice-input-setting">
            <span>
              <strong>発話検知の感度</strong>
              <output>{settings.voice_input.speech_threshold.toFixed(3)}</output>
            </span>
            <input
              type="range"
              min="0.005"
              max="0.1"
              step="0.005"
              value={settings.voice_input.speech_threshold}
              onChange={(event) => onChange({
                voice_input: {
                  ...settings.voice_input,
                  speech_threshold: Number(event.target.value),
                },
              })}
            />
          </label>
          <small>周囲の音で反応する場合は感度の数値を上げ、声を拾わない場合は下げます。</small>
        </section>

        <section className="ui-settings-section">
          <h3>カメラ</h3>
          <p>左側のアバターを移動・回転・ズームした結果を、このブラウザの開始位置にできます。</p>
          <div className="settings-row-actions">
            <button
              type="button"
              disabled={!currentCamera}
              onClick={() => currentCamera && onChange({ camera: currentCamera })}
            >
              現在位置を保存
            </button>
            <button type="button" onClick={() => onChange({ camera: null })}>自動調整へ戻す</button>
          </div>
          <small>{settings.camera ? '保存したカメラ位置を使用します。' : 'VRMと画面サイズから自動調整します。'}</small>
        </section>

        <section className="ui-settings-section server-defaults">
          <h3>サーバー既定値</h3>
          <p>現在値を`config/ui.json`へ保存すると、新しいブラウザの初期値になります。既存ブラウザの上書き値は自動変更されません。</p>
          <div className="settings-row-actions">
            <button type="button" onClick={onResetBrowser}>ブラウザ設定をリセット</button>
            <button
              type="button"
              className="primary"
              disabled={savingDefaults}
              onClick={onSaveDefaults}
            >
              {savingDefaults ? '保存中…' : '現在値をサーバー既定値にする'}
            </button>
          </div>
          {message && <p className="settings-message" role="status">{message}</p>}
          {error && <p className="settings-error" role="alert">{error}</p>}
        </section>
      </div>
    </section>
  )
}
