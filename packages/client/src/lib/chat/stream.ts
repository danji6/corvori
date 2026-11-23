import type { api } from '@cv/convex/_generated/api'
import type { ChatStatus } from 'ai'
import type { FunctionReturnType } from 'convex/server'

export type ActiveStream = NonNullable<
  FunctionReturnType<typeof api.chat.getActiveStream>
>

export function isOngoingStream(status: ChatStatus): boolean {
  return status !== 'ready' && status !== 'error'
}

export function normalizeStatus(stream: ActiveStream | null | undefined) {
  if (!stream) return 'ready'
  return stream.status === 'pending' ? 'submitted' : 'streaming'
}
