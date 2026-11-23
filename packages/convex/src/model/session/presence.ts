import { presenceText } from '@cv/core/presence'
import { systemNote } from '@cv/core/utils/blocks'
import { toDisplayName } from '@cv/core/utils/names'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import type { MessageExtra } from '../chat/types'
import { insertMessage } from '../messageContents'
import { getByOwnerId as getSettings } from '../settings'

type Participant = Doc<'messages'>['sender']

type AnnounceArgs = {
  sessionId: Id<'sessions'>
  participant: Participant
  event: MessageExtra['presence']['event']
}

/**
 * Appends a join/leave notice to the transcript. Agents read it as a system
 * note; people see it as a divider row.
 */
export async function announcePresence(
  ctx: MutationCtx,
  { sessionId, participant, event }: AnnounceArgs,
) {
  const name = await participantName(ctx, participant)
  const extra: MessageExtra['presence'] = { event, participant, name }
  const parts = [{ type: 'text', text: systemNote(presenceText(name, event)) }]

  await insertMessage(
    ctx,
    {
      sessionId,
      sender: participant,
      role: 'system',
      status: 'done',
      type: 'presence',
      hidden: true,
      extra,
    },
    parts,
  )
}

/** Resolves a participant's current display name. */
async function participantName(ctx: MutationCtx, participant: Participant) {
  if (participant.type === 'agent') {
    const agent = await ctx.db.get(participant.id)
    return toDisplayName(agent?.name)
  }

  const settings = await getSettings(ctx, participant.id)
  return toDisplayName(settings?.displayName)
}
