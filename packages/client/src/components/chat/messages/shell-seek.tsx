import { useActiveSessionId } from '@/hooks/chat/session'
import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useSearch } from 'wouter'

import {
  highlightTargetForRow,
  useMessageHighlight,
} from './message-highlight-context'
import { useMessageSeek } from './message-seek-context'

type ShellOrigin = {
  sessionId?: string
  messageId: string
  messageCreatedAt?: number
  segmentIndex?: number
  toolCallId: string
}

export function useJumpToShell() {
  const sessionId = useActiveSessionId()
  const [, navigate] = useLocation()
  const seek = useMessageSeek()
  const highlight = useMessageHighlight()

  return useCallback(
    (origin: ShellOrigin) => {
      const { messageId, toolCallId, messageCreatedAt, segmentIndex } = origin
      if (origin.sessionId && origin.sessionId !== sessionId) {
        const params = new URLSearchParams({
          id: origin.sessionId,
          shellMessage: messageId,
          shellCall: toolCallId,
        })
        if (messageCreatedAt !== undefined)
          params.set('shellTime', String(messageCreatedAt))
        if (segmentIndex !== undefined)
          params.set('shellSegment', String(segmentIndex))
        navigate(`/?${params}`)
        return
      }

      seek?.({
        messageId,
        toolCallId,
        creationTime: messageCreatedAt,
        segmentIndex,
        onLocated: (row) =>
          highlight?.setTarget(highlightTargetForRow(messageId, row)),
      })
    },
    [sessionId, navigate, seek, highlight],
  )
}

/** Seeks after a link opens the transcript of another chat or child agent. */
export function ShellSeekFromUrl() {
  const sessionId = useActiveSessionId()
  const search = useSearch()
  const jump = useJumpToShell()
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (handled.current === search) return
    const params = new URLSearchParams(search)
    if (!sessionId || params.get('id') !== sessionId) return
    handled.current = search
    const messageId = params.get('shellMessage')
    const toolCallId = params.get('shellCall')
    if (!messageId || !toolCallId) return
    jump({
      messageId,
      toolCallId,
      messageCreatedAt: readNumber(params.get('shellTime')),
      segmentIndex: readNumber(params.get('shellSegment')),
    })
  }, [search, sessionId, jump])

  return null
}

function readNumber(value: string | null) {
  return value !== null && Number.isFinite(Number(value))
    ? Number(value)
    : undefined
}
