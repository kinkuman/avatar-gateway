/** 視線の反応は会話履歴と同じように続けて表示します。 */
export function appendGazeTranscript(current: string, text: string, beatIndex: number): string {
  const line = text.trim()
  if (!line) return current
  if (!current.trim()) return line
  return `${current}\n\n${line}`
}
