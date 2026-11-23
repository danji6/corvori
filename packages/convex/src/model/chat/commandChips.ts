import type { MessageIdentity } from '@cv/core/message-position'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import type { CommandStatus } from '../../validators/commands'
import { insertMessage } from '../messageContents'
import type { MessageExtra } from './types'

type CommandInvocation = Pick<
  MessageExtra['command'],
  'name' | 'argument' | 'source'
>

/** Inserts the hidden message representing a command. */
export async function insertCommandChip(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
  invokedBy: Id<'users'>,
  command: CommandInvocation,
  status: CommandStatus,
  summary?: MessageIdentity,
) {
  const placement = summary
    ? { anchor: summary, kind: 'compactionChip' as const }
    : undefined
  const { messageId } = await insertMessage(
    ctx,
    {
      sessionId,
      sender: { type: 'user', id: invokedBy },
      role: 'user',
      status: 'done',
      type: 'command',
      hidden: true,
      extra: {
        name: command.name,
        argument: command.argument,
        ...(command.source && { source: command.source }),
        status,
      } satisfies MessageExtra['command'],
    },
    [],
    placement,
  )

  return messageId
}

/** Updates a command chip. */
export async function markCommandChip(
  ctx: MutationCtx,
  messageId: Id<'messages'>,
  status: CommandStatus,
  detail?: string,
) {
  const message = await ctx.db.get(messageId)
  const extra = message?.extra as MessageExtra['command'] | undefined
  if (!extra) return

  await ctx.db.patch(messageId, {
    extra: {
      name: extra.name,
      ...(extra.argument !== undefined ? { argument: extra.argument } : {}),
      ...(extra.source && { source: extra.source }),
      status,
      ...(status === 'failed' && detail ? { error: detail } : {}),
      ...(status === 'cancelled' && detail ? { reason: detail } : {}),
    },
  })
}
