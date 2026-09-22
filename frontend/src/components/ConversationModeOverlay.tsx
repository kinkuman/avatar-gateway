// 会話モードで、全履歴の代わりに最新の質問と応答だけをアバター上へ表示します。

import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { AvatarState, Message } from '../types'
import MarkdownMessage from './MarkdownMessage'

interface Props {
  messages: Message[]
  avatarState: AvatarState
}

interface LatestTurn {
  question: string
  answer: string
}

interface ConversationImage {
  alt: string
  url: string
}

interface PresentedAnswer {
  text: string
  images: ConversationImage[]
}

const GENERATED_IMAGE_PATTERN = /!\[([^\]]*)\]\((?:<)?(\/api\/images\/[0-9a-f]{32}\.(?:gif|jpeg|jpg|png|webp))(?:>)?\)/gi

/** Avatar Gatewayが公開した生成画像だけを本文から分離し、外部Markdown画像は従来表示へ残します。 */
function presentConversationAnswer(answer: string): PresentedAnswer {
  const images: ConversationImage[] = []
  const seenUrls = new Set<string>()
  const text = answer.replace(GENERATED_IMAGE_PATTERN, (_match, rawAlt: string, url: string) => {
    if (!seenUrls.has(url)) {
      seenUrls.add(url)
      images.push({ alt: rawAlt.trim() || '生成画像', url })
    }
    return ''
  }).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim()
  return { text, images }
}

/** 最後の利用者入力を起点に、分割される場合がある応答本文を一つの表示へまとめます。 */
function findLatestTurn(messages: Message[]): LatestTurn | null {
  let questionIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      questionIndex = index
      break
    }
  }
  if (questionIndex < 0) return null
  return {
    question: messages[questionIndex].content,
    answer: messages
      .slice(questionIndex + 1)
      .filter((message) => message.role === 'assistant' && message.content.trim())
      .map((message) => message.content)
      .join('\n\n'),
  }
}

/** 最新ターンを読みやすい半透明カードで表示し、応答待ちも空欄に見せません。 */
export default function ConversationModeOverlay({ messages, avatarState }: Props) {
  const latestTurn = useMemo(() => findLatestTurn(messages), [messages])
  const presentedAnswer = useMemo(
    () => presentConversationAnswer(latestTurn?.answer ?? ''),
    [latestTurn?.answer],
  )
  const latestTurnRef = useRef<HTMLDivElement>(null)
  const [dismissedImageKey, setDismissedImageKey] = useState<string | null>(null)
  const waiting = avatarState === 'generating' || avatarState === 'synthesizing'
  const imageKey = latestTurn
    ? `${latestTurn.question}\n${latestTurn.answer}\n${presentedAnswer.images.map((image) => image.url).join('\n')}`
    : ''
  const imagesVisible = presentedAnswer.images.length > 0 && dismissedImageKey !== imageKey

  useLayoutEffect(() => {
    // 長い応答の生成中は、利用者が現在読み上げられている末尾を見失わないよう追従します。
    const turn = latestTurnRef.current
    if (turn) turn.scrollTop = turn.scrollHeight
  }, [presentedAnswer.text])

  if (!latestTurn) {
    return (
      <section className="conversation-mode-overlay" aria-live="polite">
        <div className="conversation-latest-turn conversation-latest-empty">
          マイクをONにして話しかけてください。
        </div>
      </section>
    )
  }

  return (
    <section className="conversation-mode-overlay" aria-live="polite">
      {imagesVisible && (
        <aside className="conversation-generated-images" aria-label="生成画像">
          <button
            className="conversation-generated-images-close"
            type="button"
            aria-label="生成画像を閉じる"
            onClick={() => setDismissedImageKey(imageKey)}
          >
            ×
          </button>
          <div className="conversation-generated-images-scroll">
            {presentedAnswer.images.map((image) => (
              <a
                className="conversation-generated-image-link"
                href={image.url}
                target="_blank"
                rel="noreferrer noopener"
                title="原寸画像を開く"
                key={image.url}
              >
                <img src={image.url} alt={image.alt} />
              </a>
            ))}
          </div>
        </aside>
      )}
      <div className="conversation-latest-turn" ref={latestTurnRef}>
        <article className="conversation-latest-question">
          <span>あなた</span>
          <p>{latestTurn.question}</p>
        </article>
        {(presentedAnswer.text || presentedAnswer.images.length === 0) && (
          <article className="conversation-latest-answer">
            <span>Avatar</span>
            {presentedAnswer.text ? (
              <MarkdownMessage content={presentedAnswer.text} />
            ) : (
              <p className="conversation-answer-pending">{waiting ? '応答を準備しています…' : '…'}</p>
            )}
          </article>
        )}
      </div>
    </section>
  )
}
