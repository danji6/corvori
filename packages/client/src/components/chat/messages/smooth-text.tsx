import {
  KatexMath,
  MarkdownContext,
  MarkdownRenderer,
  matchMathClass,
} from '@/components/markdown'
import { T } from '@/components/ui/typography'
import { useMathMode } from '@/hooks/chat/resolved-settings'
import { useSmoothedText } from '@/hooks/chat/smoothed-text'
import { useStreamingCursor } from '@/hooks/chat/streaming-cursor'
import type { MathMode } from '@/lib/chat'
import { autoCloseMarkdown, splitAtLastBlock } from '@/lib/markdown/helpers'
import { remarkStreamingCursor } from '@/lib/markdown/remark'
import { cn } from '@/lib/utils'
import type { ReasoningUIPart, TextUIPart } from 'ai'
import { memo, useMemo } from 'react'
import type { Components } from 'react-markdown'

import { StreamingCodeBlock } from './streaming-code-block'

type SmoothTextProps = {
  part: TextUIPart | ReasoningUIPart
}

function StreamingCursor() {
  return <span aria-hidden="true" className="streaming-cursor" />
}

// We memoize what's already been rendered
const CommittedMarkdown = memo(function CommittedMarkdown({
  text,
  components,
  mathMode,
}: {
  text: string
  components: Components
  mathMode: MathMode
}) {
  return (
    <MarkdownRenderer components={components} enableBreaks mathMode={mathMode}>
      {text}
    </MarkdownRenderer>
  )
})

function SmoothTextComponent({ part }: SmoothTextProps) {
  const text = part.text
  const isStreaming = part.state === 'streaming'
  const streamingCursor = useStreamingCursor(text, isStreaming)
  const mathMode = useMathMode()

  const displayedText = useSmoothedText(text, isStreaming)

  const [committed, tail] = useMemo(
    () => (isStreaming ? splitAtLastBlock(displayedText) : [displayedText, '']),
    [displayedText, isStreaming],
  )

  // autoCloseMarkdown only runs on the small streaming tail, not the full text
  const tailMd = useMemo(
    () => (isStreaming && tail ? autoCloseMarkdown(tail, committed) : tail),
    [tail, committed, isStreaming],
  )

  const components = useMemo<Components>(
    () => ({
      h1: (props) => <T.h1 className="mt-6" {...props} />,
      h2: (props) => <T.h2 className="mt-4" {...props} />,
      h3: (props) => <T.h3 className="mt-4" {...props} />,
      h4: (props) => <T.h4 className="mt-4" {...props} />,
      pre({ children }) {
        return <>{children}</>
      },
      table({ children, className, ...props }) {
        return (
          <div className="mt-4 overflow-x-auto">
            <T.table className={cn('my-0', className)} {...props}>
              {children}
            </T.table>
          </div>
        )
      },
      img({ src, alt, className, ...props }) {
        return (
          // biome-ignore lint/performance/noImgElement: N/A
          <img
            src={src}
            alt={alt}
            className={cn('w-full object-contain', className)}
            {...props}
          />
        )
      },
      code({ node, className, children, ...props }) {
        const display = matchMathClass(className)
        if (display !== null) {
          return <KatexMath latex={String(children)} display={display} />
        }
        const match = /language-(\w+)/.exec(className || '')
        const nodeProps = node?.properties as
          Record<string, unknown> | undefined
        const cursor = nodeProps?.dataStreamingCursor === 'true'
        const isInline =
          !match &&
          !(node?.data as { hProperties?: { language?: string } })?.hProperties
            ?.language

        if (isInline && typeof children === 'string') {
          const isMultiline = children.includes('\n')
          if (!isMultiline) {
            return (
              <T.inlineCode className={className} {...props}>
                {children}
              </T.inlineCode>
            )
          }
        }

        return (
          <StreamingCodeBlock className={className} cursor={cursor}>
            {children}
          </StreamingCodeBlock>
        )
      },
      'md-streaming-cursor': StreamingCursor,
    }),
    [],
  )

  return (
    <MarkdownContext.Provider value={{ isViewer: true }}>
      <div className={cn('chat-markdown', streamingCursor)}>
        {committed && (
          <CommittedMarkdown
            text={committed}
            components={components}
            mathMode={mathMode}
          />
        )}
        {tailMd && (
          <MarkdownRenderer
            components={components}
            enableBreaks
            mathMode={mathMode}
            remarkPlugins={[remarkStreamingCursor]}
          >
            {tailMd}
          </MarkdownRenderer>
        )}
      </div>
    </MarkdownContext.Provider>
  )
}

export type { SmoothTextProps }
export const SmoothText = memo(SmoothTextComponent)
