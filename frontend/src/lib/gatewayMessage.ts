// 送信本文に付く別セッションのassistant記録を、画面ではassistant側の吹き出しへ分けます。

import type { Message } from '../types'

const GATEWAY_MESSAGE_PATTERN = /^\[avatar_gateway_message\]\r?\n\[別セッションでassistantが発したメッセージ\]\r?\n([\s\S]*?)\r?\n\[\/avatar_gateway_message\]\r?\n([\s\S]*)$/

export interface DisplayMessage extends Message {
  key: string
}

/** 利用者発言の先頭にある別セッション記録だけをassistant吹き出しへ分離します。 */
export function splitGatewayMessages(messages: Message[]): DisplayMessage[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user') {
      return [{ ...message, key: `${message.role}-${index}` }]
    }
    const match = GATEWAY_MESSAGE_PATTERN.exec(message.content)
    if (!match) return [{ ...message, key: `user-${index}` }]
    const assistantContent = match[1].trim()
    const userContent = match[2]
    const parts: DisplayMessage[] = []
    if (assistantContent) {
      parts.push({ role: 'assistant', content: assistantContent, key: `assistant-gateway-${index}` })
    }
    if (userContent.trim()) {
      parts.push({ role: 'user', content: userContent, key: `user-${index}` })
    }
    return parts
  })
}
