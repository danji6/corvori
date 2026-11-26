import { extractTextFromMessage, isEditableMessage } from '@/lib/chat'
import type { MessageRecord } from '@/lib/chat'
import {
  type PartAddress,
  fromAddressForGroup,
  groupPartAddresses,
  isRenderablePartGroup,
} from '@/lib/chat/parts'
import type { MessageRow, SegmentGroups } from '@/lib/chat/rows'
import {
  type UIMessage,
  isFileUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
} from 'ai'

/** Which group the menu acts on, or null for message-wide. */
export type GroupScope = { segmentIndex: number; groupIndex: number }

type TextBlock = {
  text: string
  address: PartAddress
}

export type MenuState = {
  edit: {
    block?: TextBlock
    messageText?: string
    submenu: boolean
  }
  copy: {
    blockText?: string
    messageText?: string
  }
  delete: {
    blockAddresses: PartAddress[]
    blockFrom?: PartAddress
    message: boolean
    submenu: boolean
  }
  retry: boolean
}

export function resolveHeaderScope(
  row: MessageRow,
  target: Element | null,
): GroupScope | null {
  if (row.kind !== 'header' || !row.reasoning) return null
  if (!target?.closest('[data-reasoning-address]')) return null

  const { segmentIndex, groupIndex } = row.reasoning
  return { segmentIndex, groupIndex }
}

/** Resolves the selected group and whether the menu can target a block. */
export function resolveMessageMenuScope(
  parts: UIMessage['parts'],
  slices: SegmentGroups[],
  scope: GroupScope | null,
) {
  const slice = scope
    ? slices.find((candidate) => candidate.segmentIndex === scope.segmentIndex)
    : undefined
  const group = scope && slice ? slice.groups[scope.groupIndex] : undefined
  const blockPart = group?.type === 'single' ? group.part : undefined
  const isReasoningBlock = Boolean(blockPart && isReasoningUIPart(blockPart))
  const hasBlockLevelStructure = hasBlockLevelParts(parts)
  const renderableGroupCount = slices.reduce(
    (sum, slice) => sum + slice.groups.filter(isRenderablePartGroup).length,
    0,
  )
  const multiGroup = renderableGroupCount > 1
  const hasDistinctBlock =
    multiGroup &&
    group !== undefined &&
    (hasBlockLevelStructure || isReasoningBlock)

  return {
    slice,
    group,
    blockPart,
    multiGroup,
    hasBlockLevelStructure,
    hasDistinctBlock,
  }
}

function isLastGroup(slices: SegmentGroups[], scope: GroupScope): boolean {
  const last = slices[slices.length - 1]
  return (
    last !== undefined &&
    last.segmentIndex === scope.segmentIndex &&
    scope.groupIndex === last.groups.length - 1
  )
}

export function getMessageContextMenuState(
  message: UIMessage,
  slices: SegmentGroups[],
  record: MessageRecord | undefined,
  scope: GroupScope | null,
  canMutate: boolean,
): MenuState {
  const messageText =
    record?.type === 'contextReset'
      ? '/new'
      : extractTextFromMessage(message) || undefined

  const {
    slice,
    group,
    blockPart,
    multiGroup,
    hasBlockLevelStructure,
    hasDistinctBlock,
  } = resolveMessageMenuScope(message.parts, slices, scope)

  const blockText = getCopyableBlockText(blockPart)
  // Skip "Copy Block" when it would copy exactly the same text as "Copy Message"
  const canCopyBlock =
    multiGroup && blockText !== undefined && blockText !== messageText

  const blockAddresses =
    scope && slice && group
      ? groupPartAddresses(scope.segmentIndex, slice.parts, group)
      : []

  const blockFrom =
    scope && group && (!isLastGroup(slices, scope) || record?.hasNewerSegments)
      ? fromAddressForGroup(scope.segmentIndex, group)
      : undefined

  const editBlock =
    hasBlockLevelStructure &&
    scope &&
    group?.type === 'single' &&
    blockPart &&
    isTextUIPart(blockPart)
      ? {
          text: blockPart.text,
          address: { segmentIndex: scope.segmentIndex, partIndex: group.index },
        }
      : undefined

  const availableEditBlock = canMutate ? editBlock : undefined
  const editMessageText = messageText && isEditableMessage(message) ? messageText : undefined // prettier-ignore
  const availableEditMessageText = canMutate ? editMessageText : undefined

  return {
    edit: {
      block: availableEditBlock,
      messageText: availableEditMessageText,
      submenu:
        multiGroup &&
        hasBlockLevelStructure &&
        Boolean(availableEditBlock || availableEditMessageText),
    },
    copy: {
      blockText: canCopyBlock ? blockText : undefined,
      messageText,
    },
    delete: {
      blockAddresses: canMutate ? blockAddresses : [],
      blockFrom: canMutate ? blockFrom : undefined,
      message: canMutate,
      submenu:
        canMutate &&
        group?.type !== 'files' &&
        hasDistinctBlock &&
        blockAddresses.length > 0,
    },
    retry: canMutate && message.role === 'assistant',
  }
}

function hasBlockLevelParts(parts: UIMessage['parts']): boolean {
  return parts.some(isStructuralPart) || parts.filter(isTextUIPart).length > 1
}

function isStructuralPart(part: UIMessage['parts'][number]): boolean {
  return isFileUIPart(part) || isToolUIPart(part)
}

function getCopyableBlockText(
  part: UIMessage['parts'][number] | undefined,
): string | undefined {
  return part && (isTextUIPart(part) || isReasoningUIPart(part))
    ? part.text
    : undefined
}
