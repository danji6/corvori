import { MarkdownSnippet } from '@/components/markdown'
import { cn } from '@/lib/utils'
import type { ReplyQuote } from '@cv/convex/types'
import { toDisplayName } from '@cv/core/utils/names'
import { BotIcon, UserIcon } from 'lucide-react'
import { useCallback } from 'react'

import {
  highlightTargetForRow,
  useMessageHighlight,
  useMessageHighlightRef,
} from './message-highlight-context'
import { useMessageSeek } from './message-seek-context'

const CLAMP = { 1: 'line-clamp-1', 2: 'line-clamp-2' } as const

/** Flattens markdown blocks so an excerpt reads as a few plain lines. */
const EXCERPT_MARKDOWN = [
  '[&_*]:my-0',
  '[&_:is(h1,h2,h3,h4)]:border-0 [&_:is(h1,h2,h3,h4)]:p-0',
  '[&_:is(h1,h2,h3,h4)]:text-[length:inherit]',
  '[&_:is(img,video,table,hr)]:hidden',
].join(' ')

export type ReplyQuoteCardProps = {
  quote: ReplyQuote
  messageId: string
  className?: string
}

/** The message a reply responds to, shown above the reply's content. */
export function ReplyQuoteCard({
  quote,
  messageId,
  className,
}: ReplyQuoteCardProps) {
  const highlightRef = useMessageHighlightRef(messageId)
  const jump = useJumpToMessage(quote.target)
  const unavailable = !quote.target && !quote.text

  function handleClick(event: React.MouseEvent) {
    // Links inside the excerpt keep their own behavior
    if ((event.target as HTMLElement).closest('a')) return
    jump?.()
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    jump?.()
  }

  return (
    <div
      ref={highlightRef}
      data-slot="reply-quote"
      role={jump ? 'button' : undefined}
      tabIndex={jump ? 0 : undefined}
      title={jump ? 'Jump to message' : undefined}
      onClick={jump ? handleClick : undefined}
      onKeyDown={jump ? handleKeyDown : undefined}
      className={cn(
        'bg-m3-surface-container-low flex w-full min-w-0 overflow-hidden rounded-xl border text-left',
        jump &&
          'hover:bg-m3-surface-container focus-visible:ring-ring cursor-pointer outline-0 transition-colors focus-visible:ring-1',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'w-1 shrink-0',
          unavailable ? 'bg-border' : 'bg-m3-primary',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2">
        {!unavailable && <ReplyQuoteSender quote={quote} />}
        <ReplyQuoteExcerpt quote={quote} lines={2} />
      </div>
    </div>
  )
}

/** The quoted participant's role icon and name. */
export function ReplyQuoteSender({ quote }: { quote: ReplyQuote }) {
  const Icon = quote.sender.type === 'agent' ? BotIcon : UserIcon

  return (
    <span className="text-foreground/70 flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-wide">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{toDisplayName(quote.senderName)}</span>
    </span>
  )
}

export type ReplyQuoteExcerptProps = {
  quote: ReplyQuote
  /** Lines shown before the excerpt is elided. */
  lines: keyof typeof CLAMP
}

/** The quoted text as markdown, or a placeholder when there is none. */
export function ReplyQuoteExcerpt({ quote, lines }: ReplyQuoteExcerptProps) {
  if (!quote.text) {
    return (
      <span className="text-muted-foreground text-sm italic">
        {quote.target ? 'No quoted text' : 'Original message unavailable'}
      </span>
    )
  }

  return (
    <div
      data-slot="reply-quote-excerpt"
      className={cn(
        'text-muted-foreground text-sm wrap-anywhere',
        CLAMP[lines],
        EXCERPT_MARKDOWN,
      )}
      style={{ fontFamily: 'var(--chat-font-family)' }}
    >
      <MarkdownSnippet>{quote.text}</MarkdownSnippet>
    </div>
  )
}

/** Scrolls to and highlights a quoted message. */
function useJumpToMessage(target: ReplyQuote['target']) {
  const seek = useMessageSeek()
  const setHighlight = useMessageHighlight()?.setTarget

  const jump = useCallback(() => {
    if (!target || !seek) return

    seek({
      messageId: target.id,
      creationTime: target.creationTime,
      part: target.part,
      onLocated: (row) => setHighlight?.(highlightTargetForRow(target.id, row)),
    })
  }, [target, seek, setHighlight])

  return target && seek ? jump : undefined
}
