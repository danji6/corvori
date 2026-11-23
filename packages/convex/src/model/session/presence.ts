import { presenceText } from '@cv/core/presence'
import { systemNote } from '@cv/core/utils/blocks'
import { toDisplayName } from '@cv/core/utils/names'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import type { MessageExtra } from '../chat/types'
import { insertMessage } from '../messageContents'
import { resolveAuthor } from './authorProfiles'

type Participant = Exclude<Doc<'messages'>['sender'], { type: 'archived' }>

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
  const profile = await resolveAuthor(ctx, sessionId, participant)
  const name = toDisplayName(profile?.name)
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
