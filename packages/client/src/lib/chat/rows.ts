import type { UIMessage } from 'ai'
import { dequal } from 'dequal'

import { messageExtra } from './messages'
import { groupNoteRows } from './note-rows'
import {
  type PartAddress,
  type PartGroup,
  groupHasToolCall,
  groupKey,
  groupPartIndices,
  groupPartsCached,
} from './parts'
import {
  isTranscriptDivider,
  messageSenderKey,
  senderGroupDurations,
} from './sender-groups'
import { groupShellReportRows } from './shell-work-reports'
import type { MessageRecord, PartMetadata } from './types'
import {
  type LayoutGroup,
  type ReasoningAddress,
  type ResolveWorkId,
  type WorkGroup,
  buildWorkLayout,
  latestReasoning,
} from './work-layout'

export type HiddenChipPlacement = 'standalone' | 'inline' | 'grouped'

type MessageRowKind =
  | {
      kind: 'header'
      key: string
      messageId: string
      reasoning?: ReasoningAddress
      grouped?: boolean
    }
  | {
      /** The quote card above a reply's content. */
      kind: 'reply'
      key: string
      messageId: string
      grouped?: boolean
    }
  | {
      kind: 'group'
      key: string
      messageId: string
      segmentIndex: number
      groupIndex: number
      workId?: string
      promotedToolCallIds?: string[]
      grouped?: boolean
    }
  | {
      kind: 'work'
      key: string
      messageId: string
      work: WorkGroup
      grouped?: boolean
    }
  | {
      kind: 'footer'
      key: string
      messageId: string
      duration?: number
      grouped?: boolean
    }
  | {
      kind: 'note-group'
      key: string
      messageId: string
      count: number
      grouped?: boolean
    }
  | {
      kind: 'context-reset' | 'presence'
      key: string
      messageId: string
      grouped?: boolean
    }
  | {
      kind: 'hidden'
      key: string
      messageId: string
      placement: HiddenChipPlacement
      noteGroupId?: string
      grouped?: boolean
    }

export type MessageRow = MessageRowKind & {
  /** The message ID of the shared sender header for a grouped message. */
  senderGroupId?: string
  /** This row belongs to a compaction summary. */
  summary?: boolean
}

/** Hides the edit draft's quote while keeping the following row's key stable. */
export function omitReplyRow(rows: MessageRow[], messageId: string) {
  const index = rows.findIndex(
    (row) => row.kind === 'reply' && row.messageId === messageId,
  )
  if (index < 0) return rows

  const next = rows.slice(index + 1)
  if (rows[index].grouped && next[0]?.messageId === messageId) {
    next[0] = { ...next[0], grouped: true }
  }
  return [...rows.slice(0, index), ...next]
}

/** One loaded segment's part slice with its cached part groups. */
export type SegmentGroups = {
  segmentIndex: number
  parts: UIMessage['parts']
  groups: PartGroup[]
}

const sliceCache = new WeakMap<
  UIMessage['parts'],
  { signature: string; slices: SegmentGroups[] }
>()

/**
 * Splits a message's flattened parts back into segment slices, cached
 * for stable lookups.
 */
export function segmentGroupsFor(
  message: UIMessage,
  record: MessageRecord | undefined,
): SegmentGroups[] {
  const segments = record?.segments ?? []
  const signature = segments
    .map((segment) => `${segment.index}:${segment.partCount}`)
    .join(',')

  const cached = sliceCache.get(message.parts)
  if (cached && cached.signature === signature) return cached.slices

  let slices: SegmentGroups[]
  if (segments.length <= 1) {
    slices = [
      {
        segmentIndex: segments[0]?.index ?? 0,
        parts: message.parts,
        groups: groupPartsCached(message.parts),
      },
    ]
  } else {
    slices = []
    let offset = 0
    for (const segment of segments) {
      const parts = message.parts.slice(offset, offset + segment.partCount)
      offset += segment.partCount
      slices.push({
        segmentIndex: segment.index,
        parts,
        groups: groupPartsCached(parts),
      })
    }
  }

  sliceCache.set(message.parts, { signature, slices })
  return slices
}

export type BuildRowsOptions = {
  /** Collapse consecutive messages by the same sender under one header. */
  groupBySender?: boolean
  resolveWorkId?: ResolveWorkId
}

/** Whether a footer row would render anything. */
function hasFooterContent(
  message: UIMessage,
  meta: MessageRecord | undefined,
  duration: number | undefined,
): boolean {
  // A processing turn can surface the waiting indicator at any moment
  if ((message as { status?: string }).status === 'processing') return true
  if (meta?.hasChanges) return true
  if (meta?.metadata?.error) return true
  if ((meta?.versionCount ?? 1) > 1) return true
  return duration !== undefined
}

/** The full-width row for a context reset or a join/leave notice. */
function dividerRow(id: string, meta: MessageRecord | undefined): MessageRow {
  return meta?.type === 'presence'
    ? { kind: 'presence', key: `presence:${id}`, messageId: id }
    : { kind: 'context-reset', key: `reset:${id}`, messageId: id }
}

function lastTextGroup(
  groups: readonly LayoutGroup[],
): LayoutGroup | undefined {
  for (let index = groups.length - 1; index >= 0; index--) {
    const entry = groups[index]!
    const { group } = entry
    if (group.type === 'single' && group.part.type === 'text') return entry
  }
}

function groupAddress(
  entry: LayoutGroup,
  fileCounts: Map<number, number> | null,
) {
  const { group, segmentIndex } = entry
  if (!fileCounts || group.type !== 'files') {
    return `s${segmentIndex}:${groupKey(group)}`
  }

  // Server-added parts can shift file groups within their segment.
  const occurrence = fileCounts.get(segmentIndex) ?? 0
  fileCounts.set(segmentIndex, occurrence + 1)
  return `s${segmentIndex}:files:${occurrence}`
}

export function buildRows(
  ids: string[],
  getMessage: (id: string) => UIMessage | null,
  getMessageMetadata: (id: string) => MessageRecord | undefined,
  getPartMetadata: (id: string) => PartMetadata | undefined = () => undefined,
  { groupBySender = false, resolveWorkId }: BuildRowsOptions = {},
): MessageRow[] {
  const rows: MessageRow[] = []
  let previousSenderKey: string | null = null
  let senderHeader: Extract<MessageRow, { kind: 'header' }> | undefined
  const durations = senderGroupDurations({
    ids,
    getMessage,
    getMetadata: getMessageMetadata,
    getPartMetadata,
    groupBySender,
  })

  for (const id of ids) {
    const message = getMessage(id)
    if (!message) continue

    const meta = getMessageMetadata(id)
    if (isTranscriptDivider(meta)) {
      previousSenderKey = null
      senderHeader = undefined
      rows.push(dividerRow(id, meta))
      continue
    }

    const clientSendId = meta?.clientSendId
    const renderId = clientSendId === undefined ? id : `send:${clientSendId}`

    // Hidden messages render as a single compact chip (styled by type).
    if (meta?.hidden) {
      const grouped = groupBySender && previousSenderKey !== null
      rows.push({
        kind: 'hidden',
        key: `hid:${id}`,
        messageId: id,
        placement: 'standalone',
        ...(grouped && { grouped }),
      })
      continue
    }

    // Summaries and other typed messages never join a sender group
    const senderKey = messageSenderKey(message, meta)
    const grouped =
      groupBySender && senderKey !== null && senderKey === previousSenderKey
    previousSenderKey = senderKey

    const hasHeader = (!meta?.type || message.role === 'system') && !grouped
    const summary = meta?.type === 'summary' ? { summary: true } : undefined

    const slices = segmentGroupsFor(message, meta)
    const reasoning = !meta?.type ? latestReasoning(id, slices) : undefined
    const layout = buildWorkLayout(message, meta, slices, resolveWorkId)
    // The send's text can move to a new segment when other parts are inserted.
    const sentText =
      clientSendId === undefined || meta?.hasNewerSegments
        ? undefined
        : lastTextGroup(layout.groups)
    const summarizedWork = new Map(
      layout.work
        .filter((work) => work.groups.length > 1 || work.toolCallIds.length > 0)
        .map((work) => [work.id, work]),
    )
    if (!grouped) senderHeader = undefined
    if (grouped && senderHeader && reasoning) senderHeader.reasoning = reasoning
    const senderGroup =
      grouped && senderHeader
        ? { senderGroupId: senderHeader.messageId }
        : undefined

    // Preserve existing row keys for messages created without a client send ID.
    let first = true
    const firstKey = (key: string) =>
      clientSendId === undefined && first && grouped ? `${key}:grp` : key

    if (hasHeader) {
      senderHeader = {
        kind: 'header',
        key: `h:${renderId}`,
        messageId: id,
        reasoning,
        ...summary,
      }
      rows.push(senderHeader)
      first = false
    }

    if (meta?.replyTo) {
      rows.push({
        kind: 'reply',
        key: firstKey(`r:${renderId}`),
        messageId: id,
        ...senderGroup,
        ...summary,
        ...(first && grouped && { grouped }),
      })
      first = false
    }

    const emitted = new Set<string>()
    const fileCounts =
      clientSendId === undefined ? null : new Map<number, number>()
    for (const entry of layout.groups) {
      const work = entry.workId ? summarizedWork.get(entry.workId) : undefined
      if (work && !emitted.has(work.id)) {
        rows.push({
          kind: 'work',
          key: firstKey(`w:${work.id}`),
          messageId: id,
          work,
          ...senderGroup,
          ...summary,
          ...(first && grouped && { grouped }),
        })
        emitted.add(work.id)
        first = false
      }
      const blockKey =
        entry === sentText ? 'text' : groupAddress(entry, fileCounts)
      rows.push({
        kind: 'group',
        key: firstKey(`g:${renderId}:${blockKey}`),
        messageId: id,
        segmentIndex: entry.segmentIndex,
        groupIndex: entry.groupIndex,
        ...senderGroup,
        ...summary,
        ...(work && { workId: work.id }),
        ...(first && grouped && { grouped }),
      })
      first = false
    }

    // Keep an anchor for empty messages, including compactions before they stream.
    const duration = summary ? undefined : durations.get(id)
    if (first || (!summary && hasFooterContent(message, meta, duration))) {
      rows.push({
        kind: 'footer',
        key: firstKey(`f:${renderId}`),
        messageId: id,
        ...senderGroup,
        ...summary,
        ...(duration !== undefined && { duration }),
        ...(first && grouped && { grouped }),
      })
    }
  }

  return groupNoteRows(
    groupShellReportRows(rows, {
      getMessage,
      getMetadata: getMessageMetadata,
      getSegments: segmentGroupsFor,
      groupBySender,
      resolveWorkId,
    }),
    (id) =>
      messageExtra(getMessageMetadata(id), 'command')?.source ===
      'contextWindow',
  )
}

/**
 * The row rendering a tool call, for sub-message precision. Absent when the
 * segment holding the call isn't loaded.
 */
export function findToolRow(
  rows: MessageRow[],
  message: UIMessage,
  record: MessageRecord | undefined,
  toolCallId: string,
): MessageRow | undefined {
  for (const slice of segmentGroupsFor(message, record)) {
    const groupIndex = slice.groups.findIndex((group) =>
      groupHasToolCall(group, toolCallId),
    )
    if (groupIndex < 0) continue

    return (
      rows.find(
        (row) =>
          row.kind === 'group' &&
          row.messageId === message.id &&
          row.segmentIndex === slice.segmentIndex &&
          row.groupIndex === groupIndex,
      ) ??
      rows.find(
        (row) =>
          row.kind === 'work' &&
          row.messageId === message.id &&
          row.work.toolCallIds.includes(toolCallId),
      )
    )
  }
}

/** Finds the row rendering a stored part address once its segment is loaded. */
export function findPartRow(
  rows: MessageRow[],
  message: UIMessage,
  record: MessageRecord | undefined,
  address: PartAddress,
): MessageRow | undefined {
  const slice = segmentGroupsFor(message, record).find(
    (slice) => slice.segmentIndex === address.segmentIndex,
  )
  if (!slice) return undefined
  const groupIndex = slice.groups.findIndex((group) =>
    groupPartIndices(slice.parts, group).includes(address.partIndex),
  )
  return rows.find(
    (row) =>
      row.kind === 'group' &&
      row.messageId === message.id &&
      row.segmentIndex === address.segmentIndex &&
      row.groupIndex === groupIndex,
  )
}

export function rowKeysEqual(a: MessageRow[], b: MessageRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!dequal(a[i], b[i])) return false
  }
  return true
}
