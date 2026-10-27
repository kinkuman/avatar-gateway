import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isNewSessionDisabled,
  type NewSessionAvailability,
} from '../src/lib/newSessionAvailability.ts'

function state(overrides: Partial<NewSessionAvailability> = {}): NewSessionAvailability {
  return {
    hermesSessionId: null,
    gazeTranscript: '',
    speaking: false,
    isBusy: false,
    sessionResetting: false,
    sessionSwitching: false,
    sessionHistoryOpen: false,
    agentResourcesOpen: false,
    settingsOpen: false,
    ...overrides,
  }
}

test('会話も視線ログも無いときは押せない', () => {
  assert.equal(isNewSessionDisabled(state()), true)
})

test('視線のログが残っていて発話が終わっていれば押せる', () => {
  assert.equal(isNewSessionDisabled(state({ gazeTranscript: 'あなたを見ていた' })), false)
})

test('視線の発話中はログがあっても押せない', () => {
  assert.equal(isNewSessionDisabled(state({
    gazeTranscript: 'あなたを見ていた',
    speaking: true,
  })), true)
})

test('Hermesセッションがあれば押せる', () => {
  assert.equal(isNewSessionDisabled(state({ hermesSessionId: 'ses-1' })), false)
})

test('会話処理中と別画面では押せない', () => {
  assert.equal(isNewSessionDisabled(state({ hermesSessionId: 'ses-1', isBusy: true })), true)
  assert.equal(isNewSessionDisabled(state({ gazeTranscript: 'ログ', sessionHistoryOpen: true })), true)
  assert.equal(isNewSessionDisabled(state({ gazeTranscript: 'ログ', settingsOpen: true })), true)
})
