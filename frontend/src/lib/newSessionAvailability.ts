export type NewSessionAvailability = {
  hermesSessionId: string | null
  gazeTranscript: string
  speaking: boolean
  isBusy: boolean
  sessionResetting: boolean
  sessionSwitching: boolean
  sessionHistoryOpen: boolean
  agentResourcesOpen: boolean
  settingsOpen: boolean
}

/** Hermesの会話か、発話後に残った視線ログがあれば新しいセッションを押せる。 */
export function isNewSessionDisabled(state: NewSessionAvailability): boolean {
  const hasClearableLog = Boolean(state.hermesSessionId) || state.gazeTranscript.trim().length > 0
  return !hasClearableLog
    || state.speaking
    || state.isBusy
    || state.sessionResetting
    || state.sessionSwitching
    || state.sessionHistoryOpen
    || state.agentResourcesOpen
    || state.settingsOpen
}
