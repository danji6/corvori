import { extractTextFromMessage, isEditableMessage } from '@/lib/chat'
import type { MessageRecord } from '@/lib/chat'
import {
  type PartAddress,
  fromAddressForGroup,
  groupPartAddresses,
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

export function countGroups(slices: SegmentGroups[]): number {
  return slices.reduce((sum, slice) => sum + slice.groups.length, 0)
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

  const slice = scope
    ? slices.find((candidate) => candidate.segmentIndex === scope.segmentIndex)
    : undefined

  const group = scope && slice ? slice.groups[scope.groupIndex] : undefined
  const blockPart = group?.type === 'single' ? group.part : undefined
  const blockText = getCopyableBlockText(blockPart)
  const hasBlockLevelStructure = hasBlockLevelParts(message.parts)
  const multiGroup = countGroups(slices) > 1
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

  const isReasoningBlock = Boolean(blockPart && isReasoningUIPart(blockPart))

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
        multiGroup &&
        (hasBlockLevelStructure || isReasoningBlock) &&
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
