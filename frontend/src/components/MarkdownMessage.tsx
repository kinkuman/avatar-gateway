// Hermesの最終回答を、画像を含む読みやすいMarkdownとして表示します。
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownMessageProps {
  content: string
}

/** GFMの表・箇条書き・画像を描画し、生HTMLだけは本文として実行しないようにします。 */
export default function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
        }}
      >
        {content || '…'}
      </ReactMarkdown>
    </div>
  )
}
