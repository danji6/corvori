import { MESSAGE_SPLIT_BUDGET_BYTES } from '@cv/core/const'
import {
  type MessagePlacement,
  messagePosition,
} from '@cv/core/message-position'
import { splitParts } from '@cv/core/utils/size'

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { error } from '../errors'
import type { TokenUsage } from '../types'
import { assertPartsCap, assertSegmentFits } from './caps'
import type { SenderIdentity } from './chat/identities'
import { senderIdentity } from './chat/identities'
import { removeForMessage as removeMcpOperations } from './mcpOperations'
import { isContextEligible, searchTextFromParts } from './messages'
import { advanceCompletedHistoryRevision } from './session/state'
import { removeDeliveriesForMessage } from './shellOutputDeliveries'
import { removeShellReferences } from './shellReferences'
import { collectToolOutputStorageIds } from './stream/toolOutput'

/** A message doc joined with its selected version's parts (concatenated segments). */
export type MessageWithParts = Doc<'messages'> & { parts: unknown[] }

type InsertMessageFields = {
  sessionId: Id<'sessions'>
  sender: Doc<'messages'>['sender']
  role: Doc<'messages'>['role']
  type?: Doc<'messages'>['type']
  status: Doc<'messages'>['status']
  metadata?: Doc<'messages'>['metadata']
  hidden?: boolean
  extra?: Doc<'messages'>['extra']
  replyTo?: Doc<'messages'>['replyTo']
  summaryBoundaryCreationTime?: number
} & SenderIdentity

/** Invalidates history if this document could be present in a completed snapshot. */
export async function invalidateCompletedHistory(
  ctx: MutationCtx,
  message: Pick<Doc<'messages'>, 'sessionId' | 'status' | 'contextEligible'>,
) {
  if (message.status === 'done' && message.contextEligible) {
    await advanceCompletedHistoryRevision(ctx, message.sessionId)
  }
}

/** Point read of a single segment row. */
export function getSegmentRow(
  ctx: QueryCtx,
  messageId: Id<'messages'>,
  version: number,
  segmentIndex: number,
) {
  return ctx.db
    .query('messageContents')
    .withIndex('by_messageId_version_segment', (q) =>
      q
        .eq('messageId', messageId)
        .eq('version', version)
        .eq('segmentIndex', segmentIndex),
    )
    .unique()
}

/** All segment rows of one version, in ascending segment order. */
export function listSegments(
  ctx: QueryCtx,
  messageId: Id<'messages'>,
  version: number,
) {
  return queryMessageSegments(ctx, messageId, version).collect()
}

export function queryMessageSegments(
  ctx: QueryCtx,
  messageId: Id<'messages'>,
  version: number,
) {
  return ctx.db
    .query('messageContents')
    .withIndex('by_messageId_version_segment', (q) =>
      q.eq('messageId', messageId).eq('version', version),
    )
}

export function listSelectedSegments(ctx: QueryCtx, message: Doc<'messages'>) {
  return listSegments(ctx, message._id, message.selectedVersion)
}

/** Stable rows before a processing message's mutable tail. */
export function listSegmentsBefore(
  ctx: QueryCtx,
  message: Doc<'messages'>,
  segmentIndex: number,
) {
  return ctx.db
    .query('messageContents')
    .withIndex('by_messageId_version_segment', (q) =>
      q
        .eq('messageId', message._id)
        .eq('version', message.selectedVersion)
        .lt('segmentIndex', segmentIndex),
    )
    .collect()
}

/** The last segment row of the selected version (the one a stream writes to). */
export function getActiveSegmentRow(ctx: QueryCtx, message: Doc<'messages'>) {
  return ctx.db
    .query('messageContents')
    .withIndex('by_messageId_version_segment', (q) =>
      q.eq('messageId', message._id).eq('version', message.selectedVersion),
    )
    .order('desc')
    .first()
}

/** Every content row of a message across all versions (for cleanup). */
export function listAllRows(ctx: QueryCtx, messageId: Id<'messages'>) {
  return ctx.db
    .query('messageContents')
    .withIndex('by_messageId_version_segment', (q) =>
      q.eq('messageId', messageId),
    )
    .collect()
}

/** The first segment row of each version (for switcher previews). */
export async function listVersionHeads(
  ctx: QueryCtx,
  message: Doc<'messages'>,
) {
  const heads = await Promise.all(
    Array.from({ length: message.versionCount }, (_, index) =>
      ctx.db
        .query('messageContents')
        .withIndex('by_messageId_version_segment', (q) =>
          q.eq('messageId', message._id).eq('version', index + 1),
        )
        .first(),
    ),
  )
  return heads.filter((row) => row !== null)
}

/** The segment row a stream is writing to (falls back to the active one). */
export async function getProcessingSegmentRow(
  ctx: QueryCtx,
  stream: Doc<'streams'>,
) {
  if (stream.state.processingContentId)
    return ctx.db.get(stream.state.processingContentId)
  if (!stream.state.processingMessageId) return null
  const message = await ctx.db.get(stream.state.processingMessageId)
  return message ? getActiveSegmentRow(ctx, message) : null
}

export async function withParts(
  ctx: QueryCtx,
  message: Doc<'messages'>,
): Promise<MessageWithParts> {
  const segments = await listSelectedSegments(ctx, message)
  return { ...message, parts: segments.flatMap((segment) => segment.parts) }
}

export function withPartsMany(
  ctx: QueryCtx,
  messages: Doc<'messages'>[],
): Promise<MessageWithParts[]> {
  return Promise.all(messages.map((message) => withParts(ctx, message)))
}

/** Parts from every version of a message (for cleanup). */
export async function allVersionParts(
  ctx: QueryCtx,
  messageId: Id<'messages'>,
): Promise<unknown[]> {
  const rows = await listAllRows(ctx, messageId)
  return rows.flatMap((row) => row.parts)
}

/**
 * Inserts a message doc plus the content rows for version 1. Messages that grow
 * too large get split into segments.
 *
 * The returned `contentId` is the last segment, which is where streaming continues.
 */
export async function insertMessage(
  ctx: MutationCtx,
  fields: InsertMessageFields,
  parts: unknown[],
  placement?: MessagePlacement,
) {
  assertPartsCap(parts)
  const segments = splitParts(parts, MESSAGE_SPLIT_BUDGET_BYTES)

  // Convex assigns both inputs to the position key on insert, in this transaction.
  const messageId = await ctx.db.insert('messages', {
    ...fields,
    position: '',
    selectedVersion: 1,
    versionCount: 1,
    ...(fields.status === 'processing' && {
      activeSegmentIndex: segments.length - 1,
    }),
    contextEligible: isContextEligible(parts),
  })
  const message = await ctx.db.get(messageId)
  if (!message) error('Message missing after insertion', 500)
  await ctx.db.patch(messageId, {
    position: messagePosition(message, placement),
  })

  let contentId = await insertSegment(ctx, messageId, fields, segments[0], 0)
  for (const [index, segmentParts] of segments.slice(1).entries()) {
    contentId = await insertSegment(
      ctx,
      messageId,
      fields,
      segmentParts,
      index + 1,
    )
  }

  await invalidateCompletedHistory(ctx, message)

  return { messageId, contentId, segments }
}

function insertSegment(
  ctx: MutationCtx,
  messageId: Id<'messages'>,
  fields: InsertMessageFields,
  parts: unknown[],
  segmentIndex: number,
) {
  return ctx.db.insert('messageContents', {
    messageId,
    sessionId: fields.sessionId,
    version: 1,
    segmentIndex,
    parts,
    metadata: segmentIndex === 0 ? fields.metadata : undefined,
    ...senderIdentity(fields),
    // Hidden messages must not surface in message search
    searchText: fields.hidden ? undefined : searchTextFromParts(parts),
  })
}

type AddVersionArgs = {
  message: Doc<'messages'>
  parts?: unknown[]
  identity?: SenderIdentity
}

/** Appends a fresh version and selects it (used by Retry). */
export async function addVersion(
  ctx: MutationCtx,
  { message, parts = [], identity }: AddVersionArgs,
) {
  assertSegmentFits(parts)
  const version = message.versionCount + 1

  const contentId = await ctx.db.insert('messageContents', {
    messageId: message._id,
    sessionId: message.sessionId,
    version,
    segmentIndex: 0,
    parts,
    ...senderIdentity(identity ?? message),
    searchText: searchTextFromParts(parts),
  })

  const contextEligible = isContextEligible(parts)
  await ctx.db.patch(message._id, {
    selectedVersion: version,
    versionCount: version,
    ...senderIdentity(identity ?? message),
    contextEligible,
    metadata: undefined,
  })

  await invalidatePartsChange(ctx, message, contextEligible)

  return { contentId, version }
}

/** Appends an empty segment after the active one (used by the byte-cap split). */
export async function appendSegment(
  ctx: MutationCtx,
  activeRow: Doc<'messageContents'>,
) {
  const segmentIndex = activeRow.segmentIndex + 1
  const contentId = await ctx.db.insert('messageContents', {
    messageId: activeRow.messageId,
    sessionId: activeRow.sessionId,
    version: activeRow.version,
    segmentIndex,
    parts: [],
  })
  await ctx.db.patch(activeRow.messageId, { activeSegmentIndex: segmentIndex })
  return contentId
}

/** Streams a segment row's parts, re-deriving the doc's eligibility cheaply. */
export async function patchSegmentParts(
  ctx: MutationCtx,
  messageId: Id<'messages'>,
  row: Doc<'messageContents'>,
  parts: unknown[],
) {
  await ctx.db.patch(row._id, { parts })
  const contextEligible = row.segmentIndex > 0 || isContextEligible(parts)
  const message = await ctx.db.get(messageId)
  if (!message) return
  if (message.contextEligible !== contextEligible) {
    await ctx.db.patch(messageId, { contextEligible })
  }
  if (message.status !== 'done') return
  if (
    row.version === message.selectedVersion ||
    message.contextEligible !== contextEligible
  ) {
    await invalidatePartsChange(ctx, message, contextEligible)
  }
}

async function invalidatePartsChange(
  ctx: MutationCtx,
  message: Doc<'messages'>,
  contextEligible: boolean,
) {
  await invalidateCompletedHistory(ctx, {
    ...message,
    contextEligible: message.contextEligible || contextEligible,
  })
}

/** Writes a processing segment's final parts, search text and metadata slice. */
export async function sealSegment(
  ctx: MutationCtx,
  row: Doc<'messageContents'>,
  parts: unknown[],
  metadata?: Doc<'messages'>['metadata'],
) {
  await ctx.db.patch(row._id, {
    parts,
    searchText: searchTextFromParts(parts),
    metadata,
  })
}

type FinalizeTurnArgs = {
  message: Doc<'messages'>
  row: Doc<'messageContents'>
  parts: unknown[]
  metadata?: Doc<'messages'>['metadata']
}

/** Seals the active segment and finalizes the turn's message doc. */
export async function finalizeTurn(
  ctx: MutationCtx,
  { message, row, parts, metadata }: FinalizeTurnArgs,
) {
  await sealSegment(ctx, row, parts, metadata)

  const segments = await listSelectedSegments(ctx, message)
  const contextEligible = segments.some((segment) => segment.parts.length > 0)
  await ctx.db.patch(message._id, {
    status: 'done',
    contextEligible,
    metadata: mergeSegmentMetadata(segments),
  })
  await invalidateCompletedHistory(ctx, {
    ...message,
    status: 'done',
    contextEligible,
  })
}

/** Writes provider metadata to a segment row and the doc's turn accumulation. */
export async function saveSegmentMeta(
  ctx: MutationCtx,
  {
    row,
    messageId,
    rowMetadata,
    docMetadata,
  }: {
    row: Doc<'messageContents'>
    messageId: Id<'messages'>
    rowMetadata: Doc<'messages'>['metadata']
    docMetadata: Doc<'messages'>['metadata']
  },
) {
  await ctx.db.patch(row._id, { metadata: rowMetadata })
  await ctx.db.patch(messageId, { metadata: docMetadata })
}

/** Collapses the selected version to a single segment-0 row (message edit). */
export async function replaceSelectedContent(
  ctx: MutationCtx,
  message: Doc<'messages'>,
  parts: unknown[],
) {
  // The whole edit has to fit the collapsed segments
  assertSegmentFits(parts)

  const segments = await listSelectedSegments(ctx, message)
  const head = segments[0]
  if (!head) error('Version not found', 404)

  await removeDeliveriesForMessage(ctx, message._id, message.selectedVersion)

  await ctx.db.patch(head._id, {
    segmentIndex: 0,
    parts,
    searchText: searchTextFromParts(parts),
  })
  for (const row of segments.slice(1)) {
    await ctx.db.delete(row._id)
  }

  const contextEligible = isContextEligible(parts)
  await ctx.db.patch(message._id, { contextEligible })
  await invalidatePartsChange(ctx, message, contextEligible)
}

/** Replaces one segment's parts, re-deriving the doc's eligibility. */
export async function setSegmentParts(
  ctx: MutationCtx,
  message: Doc<'messages'>,
  row: Doc<'messageContents'>,
  parts: unknown[],
) {
  assertSegmentFits(parts)
  await ctx.db.patch(row._id, {
    parts,
    searchText: searchTextFromParts(parts),
  })

  if (row.version !== message.selectedVersion) return
  const segments = await listSelectedSegments(ctx, message)
  const contextEligible = segments.some((segment) => segment.parts.length > 0)
  await ctx.db.patch(message._id, { contextEligible })
  await invalidatePartsChange(ctx, message, contextEligible)
}

/** Points the message at another version and updates the denormalized fields. */
export async function setSelectedVersion(
  ctx: MutationCtx,
  message: Doc<'messages'>,
  version: number,
) {
  const segments = await listSegments(ctx, message._id, version)
  const head = segments[0]
  if (!head) error('Version not found', 404)

  const contextEligible = segments.some((segment) => segment.parts.length > 0)
  await ctx.db.patch(message._id, {
    selectedVersion: version,
    contextEligible,
    metadata: mergeSegmentMetadata(segments),
    ...senderIdentity(head.senderName ? head : message),
  })
  await invalidatePartsChange(ctx, message, contextEligible)
}

/** Deletes every content row of a message, releasing its tool-output blobs. */
export async function deleteVersions(
  ctx: MutationCtx,
  messageId: Id<'messages'>,
) {
  await removeDeliveriesForMessage(ctx, messageId)
  await removeShellReferences(ctx, messageId)
  await removeMcpOperations(ctx, messageId)
  const rows = await listAllRows(ctx, messageId)
  for (const row of rows) {
    for (const storageId of collectToolOutputStorageIds(row.parts)) {
      await ctx.storage.delete(storageId).catch(() => {})
    }
    await ctx.db.delete(row._id)
  }
}

/** Merges segment metadata into a whole turn metadata. */
export function mergeSegmentMetadata(
  rows: { metadata?: Doc<'messages'>['metadata'] }[],
): Doc<'messages'>['metadata'] {
  let duration: number | undefined
  let toolErrors: string[] | undefined
  let warnings: string[] | undefined
  let usage: TokenUsage | undefined
  let errorMessage: string | undefined

  for (const { metadata } of rows) {
    if (!metadata) continue
    if (metadata.duration !== undefined) {
      duration = (duration ?? 0) + metadata.duration
    }
    if (metadata.toolErrors?.length) {
      toolErrors = [...new Set([...(toolErrors ?? []), ...metadata.toolErrors])]
    }
    if (metadata.warnings?.length) {
      warnings = [...new Set([...(warnings ?? []), ...metadata.warnings])]
    }
    if (metadata.usage !== undefined) usage = metadata.usage
    if (metadata.error !== undefined) errorMessage = metadata.error
  }

  const merged = { duration, toolErrors, warnings, usage, error: errorMessage }
  return Object.values(merged).some((value) => value !== undefined)
    ? merged
    : undefined
}
