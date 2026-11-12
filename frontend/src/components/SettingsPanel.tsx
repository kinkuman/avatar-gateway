// ブラウザ固有のUI調整と、明示操作によるサーバー既定値保存を一画面にまとめます。
import { languages, resolveLanguage, t, useTranslation, translateMessage } from '../i18n'

import type {
  BackgroundAsset,
  UiCameraSettings,
  UiSettings,
  UiSettingsOverrides,
  VrmTouchRegion,
} from '../types'

// ふれあいの対象部位を翻訳キーへ対応付けます。
const touchRegionLabels: Record<VrmTouchRegion, string> = {
  head: 'touch.region.head',
  ear: 'touch.region.ear',
  tail: 'touch.region.tail',
  chest: 'touch.region.chest',
  hips: 'touch.region.hips',
  groin: 'touch.region.groin',
  thigh: 'touch.region.thigh',
  hand: 'touch.region.hand',
  foot: 'touch.region.foot',
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
  gazeEnabled: boolean
  gazeEnrolled: boolean
  gazeStatus: string
  gazePending: number | null
  gazeJobFound: boolean | null
  faceFollow: boolean
  faceFollowStatus: string
  detectEase: boolean
  gazeMessageSync: boolean
  onGazeEnabled: (enabled: boolean) => void
  onFaceFollow: (enabled: boolean) => void
  onDetectEase: (enabled: boolean) => void
  onGazeMessageSync: (enabled: boolean) => void
  onGazeEnroll: () => void
  onGazeClear: () => void
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
  gazeEnabled,
  gazeEnrolled,
  gazeStatus,
  gazePending,
  gazeJobFound,
  faceFollow,
  faceFollowStatus,
  detectEase,
  gazeMessageSync,
  onGazeEnabled,
  onFaceFollow,
  onDetectEase,
  onGazeMessageSync,
  onGazeEnroll,
  onGazeClear,
  onChange,
  onReloadBackgrounds,
  onResetBrowser,
  onSaveDefaults,
}: Props) {
  useTranslation()
  return (
    <section className="ui-settings" aria-label={t('settings.panelLabel')}>
      <header className="ui-settings-header">
        <div>
          <span>{t('settings.eyebrow')}</span>
          <h2>{t('settings.title')}</h2>
          <p>{t('settings.description')}</p>
        </div>
      </header>

      <div className="ui-settings-scroll">
        {/* 言語が分からない状態でも戻せるよう、見出しは常に日英を併記します。 */}
        <section className="ui-settings-section">
          <label className="settings-select">
            <span>{t('settings.language')}</span>
            <select aria-label={t('settings.language')} value={resolveLanguage(settings.language)}
              onChange={(event) => onChange({ language: event.target.value })}>
              {languages.map((language) => (
                <option key={language.code} value={language.code}>{language.name}</option>
              ))}
            </select>
          </label>
        </section>
        {/* 壁紙の選択と画面への収め方を設定します。 */}
        <section className="ui-settings-section">
          <h3>{t('settings.background.title')}</h3>
          <p>{t('settings.background.description')}</p>
          <label className="settings-select">
            <span>{t('settings.background.image')}</span>
            <select
              value={settings.background.file ?? ''}
              onChange={(event) => onChange({
                background: {
                  ...settings.background,
                  file: event.target.value || null,
                },
              })}
            >
              <option value="">{t('settings.background.none')}</option>
              {settings.background.file
                && !backgrounds.some((background) => background.file === settings.background.file)
                && <option value={settings.background.file}>{t('settings.background.missing', { file: settings.background.file })}</option>}
              {backgrounds.map((background) => (
                <option key={background.file} value={background.file}>{background.file}</option>
              ))}
            </select>
          </label>
          <label className="settings-select">
            <span>{t('settings.background.fit')}</span>
            <select
              value={settings.background.fit}
              onChange={(event) => onChange({
                background: {
                  ...settings.background,
                  fit: event.target.value === 'contain' ? 'contain' : 'cover',
                },
              })}
            >
              <option value="cover">{t('settings.background.cover')}</option>
              <option value="contain">{t('settings.background.contain')}</option>
            </select>
          </label>
          <div className="settings-row-actions">
            <button type="button" disabled={backgroundsLoading} onClick={onReloadBackgrounds}>
              {backgroundsLoading ? t('settings.background.loading') : t('settings.background.reload')}
            </button>
          </div>
          {backgroundsError && <p className="settings-error" role="alert">{translateMessage(backgroundsError)}</p>}
        </section>

        {/* 動作確認とカメラ案内の表示を設定します。 */}
        <section className="ui-settings-section">
          <h3>{t('settings.display.title')}</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.show_motion_controls}
              onChange={(event) => onChange({ show_motion_controls: event.target.checked })}
            />
            <span><strong>{t('settings.display.motionPreview')}</strong><small>{t('settings.display.motionPreviewDescription')}</small></span>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.show_camera_help}
              onChange={(event) => onChange({ show_camera_help: event.target.checked })}
            />
            <span><strong>{t('settings.display.cameraHelp')}</strong><small>{t('settings.display.cameraHelpDescription')}</small></span>
          </label>
        </section>

        {/* ふれあいの有効範囲と当たり判定を設定します。 */}
        <section className="ui-settings-section">
          <h3>{t('settings.touch.title')}</h3>
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
            <span><strong>{t('settings.touch.enabled')}</strong><small>{t('settings.touch.description')}</small></span>
          </label>
          <fieldset className="touch-region-settings" disabled={!settings.touch_interaction.enabled}>
            <legend>{t('settings.touch.regions')}</legend>
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
                    {t(label)}
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
            <span><strong>{t('settings.touch.showHitboxes')}</strong><small>{t('settings.touch.showHitboxesDescription')}</small></span>
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
            <span><strong>{t('settings.touch.editHitboxes')}</strong><small>{t('settings.touch.editHitboxesDescription')}</small></span>
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
            <span><strong>{t('settings.touch.testRecoil')}</strong><small>{t('settings.touch.testRecoilDescription')}</small></span>
          </label>
        </section>

        {/* 音量・承認時の発話・音声入力を設定します。 */}
        <section className="ui-settings-section">
          <h3>{t('settings.speech.title')}</h3>
          <label className="settings-range">
            <span><strong>{t('settings.speech.volume')}</strong><output>{Math.round(settings.speech_volume * 100)}%</output></span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.speech_volume}
              onChange={(event) => onChange({ speech_volume: Number(event.target.value) })}
            />
          </label>
          <label className="settings-text">
            <span>
              <strong>{t('settings.speech.approvalPrompt')}</strong>
              <small>{t('settings.speech.approvalPromptDescription')}</small>
            </span>
            <input
              type="text"
              maxLength={80}
              value={settings.approval_prompt}
              onChange={(event) => onChange({ approval_prompt: event.target.value })}
            />
          </label>
          <label className="settings-range voice-input-setting">
            <span>
              <strong>{t('settings.voiceInput.silence')}</strong>
              <output>{t('settings.voiceInput.silenceSeconds', { duration: (settings.voice_input.silence_ms / 1000).toFixed(1) })}</output>
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
              <strong>{t('settings.voiceInput.sensitivity')}</strong>
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
          <small>{t('settings.voiceInput.sensitivityDescription')}</small>
        </section>

        {/* 顔検出と視線を使う機能を設定します。 */}
        <section className="ui-settings-section">
          <h3>{t('settings.face.title')}</h3>
          <p>{t('settings.face.description')}</p>

          <div className="gaze-group">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={gazeEnabled}
                onChange={(event) => onGazeEnabled(event.target.checked)}
              />
              <span>
                <strong>{t('settings.gaze.enabled')}</strong>
                <small>{t('settings.gaze.description', { path: 'docs/gaze_speech_hermes.md' })}</small>
              </span>
            </label>
            <div className="settings-row-actions">
              <button type="button" className="primary" onClick={onGazeEnroll}>{t('settings.gaze.enroll')}</button>
              <button type="button" disabled={!gazeEnrolled} onClick={onGazeClear}>{t('settings.gaze.clearEnrollment')}</button>
            </div>
            <small className="gaze-setting-status">
              <span>
                {gazeEnrolled ? t('settings.gaze.enrolled') : t('settings.gaze.notEnrolled')}
                {gazePending === null ? '' : t('settings.gaze.unread', { count: gazePending })}
              </span>
              {gazeJobFound === false ? <span>{t('settings.gaze.jobMissing')}</span> : null}
              {gazeStatus ? <span>{t('settings.face.status', { status: translateMessage(gazeStatus) })}</span> : null}
              <span>{t('settings.gaze.resetNotice')}</span>
            </small>

            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={faceFollow}
                onChange={(event) => onFaceFollow(event.target.checked)}
              />
              <span>
                <strong>{t('settings.faceFollow.enabled')}</strong>
                <small>{t('settings.faceFollow.description')}</small>
              </span>
            </label>
            {faceFollow && <small className="gaze-setting-status">{t('settings.face.status', { status: translateMessage(faceFollowStatus) })}</small>}

            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={detectEase}
                onChange={(event) => onDetectEase(event.target.checked)}
              />
              <span>
                <strong>{t('settings.detectEase.enabled')}</strong>
                <small>{t('settings.detectEase.description')}</small>
              </span>
            </label>

            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={gazeMessageSync}
                onChange={(event) => onGazeMessageSync(event.target.checked)}
              />
              <span>
                <strong>{t('settings.gaze.syncMessages')}</strong>
                <small>{t('settings.gaze.syncMessagesDescription')}</small>
              </span>
            </label>
          </div>
        </section>

        {/* このブラウザのカメラ開始位置を保存します。 */}
        <section className="ui-settings-section">
          <h3>{t('settings.camera.title')}</h3>
          <p>{t('settings.camera.description')}</p>
          <div className="settings-row-actions">
            <button
              type="button"
              disabled={!currentCamera}
              onClick={() => currentCamera && onChange({ camera: currentCamera })}
            >
              {t('settings.camera.save')}</button>
            <button type="button" onClick={() => onChange({ camera: null })}>{t('settings.camera.reset')}</button>
          </div>
          <small>{settings.camera ? t('settings.camera.saved') : t('settings.camera.automatic')}</small>
        </section>

        {/* 全ブラウザ向けの初期値へ保存する操作をまとめます。 */}
        <section className="ui-settings-section server-defaults">
          <h3>{t('settings.defaults.title')}</h3>
          <p>{t('settings.defaults.description')}</p>
          <div className="settings-row-actions">
            <button type="button" onClick={onResetBrowser}>{t('settings.defaults.resetBrowser')}</button>
            <button
              type="button"
              className="primary"
              disabled={savingDefaults}
              onClick={onSaveDefaults}
            >
              {savingDefaults ? t('settings.defaults.saving') : t('settings.defaults.save')}
            </button>
          </div>
          {message && <p className="settings-message" role="status">{translateMessage(message)}</p>}
          {error && <p className="settings-error" role="alert">{translateMessage(error)}</p>}
        </section>
      </div>
    </section>
  )
}
