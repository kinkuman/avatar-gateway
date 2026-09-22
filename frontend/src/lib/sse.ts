// fetchで受け取るSSEをイベント単位に分解し、Firefoxでも安定して逐次表示します。
export interface SseEvent {
  event: string
  data: Record<string, unknown>
}

/** 応答ストリームを空行で区切り、JSONイベントとして呼び出し元へ渡します。 */
export async function consumeSse(
  response: Response,
  onEvent: (event: SseEvent) => Promise<void> | void,
): Promise<void> {
  if (!response.ok || !response.body) {
    throw new Error(`会話APIエラー: ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false

  try {
    // ネットワークの分割位置とSSEのイベント境界が一致しないため、必ずバッファリングします。
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        const event = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
        const dataText = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (dataText) {
          await onEvent({ event, data: JSON.parse(dataText) as Record<string, unknown> })
        }
      }
      if (done) break
    }
    completed = true
  } finally {
    if (!completed) {
      // 表示側の例外でもHTTP接続を閉じ、バックエンドの生成・一時WAV後始末を開始させます。
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
}
