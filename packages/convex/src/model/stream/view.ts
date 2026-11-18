import type { Doc } from '../../_generated/dataModel'
import type { ActiveStream, YieldRequest } from '../../types'

/** Projects the fields used by chat controls and optimistic responses. */
export function activeStreamView(
  stream: Doc<'streams'> | null,
): ActiveStream | null {
  if (!stream) return null
  const { state } = stream
  if (state.phase === 'reserved') return null
  return {
    _id: stream._id,
    invokedBy: stream.invokedBy,
    status: state.phase,
    generation: stream.generation,
    attempt: stream.attempt,
    processingMessageId: state.processingMessageId,
    fireAt: state.phase === 'pending' ? state.fireAt : undefined,
    retryAt: state.phase === 'retrying' ? state.retryAt : undefined,
    retryError: state.phase === 'retrying' ? state.retryError : undefined,
    yield:
      state.phase === 'awaiting_input' ? yieldView(state.yield) : undefined,
  }
}

/** Hides the scheduler handle from clients. */
function yieldView(request: YieldRequest | undefined): ActiveStream['yield'] {
  if (!request) return undefined
  const { toolCallId, targetAgentId, fireAt } = request
  return { toolCallId, targetAgentId, fireAt }
}
