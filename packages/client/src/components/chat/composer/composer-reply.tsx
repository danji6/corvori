import type { ReplyTarget } from '@/lib/chat'
import { toDisplayName } from '@cv/core/utils/names'
import { ReplyIcon, XIcon } from 'lucide-react'

import { Button } from '../../ui'
import { ReplyQuoteExcerpt } from '../messages/reply-quote'

type ComposerReplyProps = {
  target: ReplyTarget
  onCancel: () => void
}

/** Shows which message the composer is replying to, with a way to cancel. */
export function ComposerReply({ target, onCancel }: ComposerReplyProps) {
  return (
    <div data-slot="composer-reply" className="order-first w-full px-2 pt-1">
      <div className="bg-m3-surface-container flex min-w-0 items-stretch overflow-hidden rounded-2xl">
        <span aria-hidden className="bg-m3-primary w-[3px] shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col px-3 py-1.5">
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <ReplyIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              Replying to{' '}
              <span className="text-foreground/70 font-semibold">
                {toDisplayName(target.senderName)}
              </span>
            </span>
          </span>
          <ReplyQuoteExcerpt quote={target} lines={1} />
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Cancel reply"
          className="text-muted-foreground mr-1 shrink-0 self-center"
          onClick={onCancel}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  )
}
