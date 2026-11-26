import { formatDuration } from '@/lib/utils'
import type { ReasoningPart } from '@cv/convex/model/chat/types'
import {
  EDIT_FILE_TOOL_PART_TYPE,
  LIST_SKILLS_TOOL_PART_TYPE,
  READ_ATTACHMENT_TOOL_PART_TYPE,
  READ_FILE_TOOL_PART_TYPE,
  SHELL_OUTPUT_TOOL_PART_TYPE,
  SHELL_TOOL_PART_TYPE,
  WRITE_FILE_TOOL_PART_TYPE,
} from '@cv/core/const'
import type { ShellToolOutput } from '@cv/core/types/tools'
import { type ToolUIPart, isReasoningUIPart } from 'ai'

import { type PartGroup, getToolStatus } from './parts'
import type { SegmentGroups } from './rows'
import { parseOutputValue } from './tool-output'
import {
  type WorkGroup,
  type WorkShellReport,
  toolsInGroup,
} from './work-layout'

/** Summarizes the loaded activity; file categories count distinct paths. */
export function summarizeWork(
  work: WorkGroup,
  slices: SegmentGroups[],
  toolErrors?: string[],
) {
  const groups = work.groups.flatMap((address) => {
    const group = slices.find(
      (slice) => slice.segmentIndex === address.segmentIndex,
    )?.groups[address.groupIndex]
    return group ? [group] : []
  })
  const tools = [
    ...new Map(
      groups.flatMap(toolsInGroup).map((part) => [part.toolCallId, part]),
    ).values(),
  ]
  const { running, reportCommands } = summarizeToolActivity(
    tools,
    work.reports,
    toolErrors,
  )
  const activity =
    tools.length || reportCommands ? activityLabel(tools, reportCommands) : ''
  const label =
    [activity, thinkingLabel(groups)].filter(Boolean).join(', ') ||
    'Tool activity'

  return {
    label: label[0].toUpperCase() + label.slice(1),
    running: running || groups.some(isThinking),
  }
}

/** Adds the recorded duration of every thinking block in the work group. */
function thinkingLabel(groups: PartGroup[]): string {
  const parts = groups.flatMap((group) =>
    group.type === 'single' && isReasoningUIPart(group.part)
      ? [group.part as ReasoningPart]
      : [],
  )
  if (!parts.length) return ''
  if (parts.some((part) => part.state === 'streaming')) return 'thinking…'
  const duration = parts.reduce(
    (total, part) => total + Math.max(0, part.duration ?? 0),
    0,
  )
  return duration > 0 ? `thought for ${formatDuration(duration)}` : 'thought'
}

/** Counts commands whose reports have no loaded tool call and tracks active tools. */
function summarizeToolActivity(
  tools: ToolUIPart[],
  reports: WorkShellReport[] = [],
  toolErrors?: string[],
) {
  const reportedJobs = new Set(reports.map((report) => report.jobId))
  const matchedJobs = new Set<string>()
  let running = false

  for (const part of tools) {
    const jobId = shellJobId(part)
    if (jobId && reportedJobs.has(jobId)) {
      matchedJobs.add(jobId)
      continue
    }
    if (toolErrors?.includes(part.toolCallId)) continue

    const status = getToolStatus(part)
    running ||= status === 'running' || status === 'pending'
  }

  return { running, reportCommands: reportedJobs.size - matchedJobs.size }
}

function isThinking(group: PartGroup): boolean {
  return (
    group.type === 'single' &&
    isReasoningUIPart(group.part) &&
    group.part.state === 'streaming'
  )
}

function shellJobId(part: ToolUIPart): string | undefined {
  if (part.type !== SHELL_TOOL_PART_TYPE) return
  return parseOutputValue<ShellToolOutput>(part.output)?.jobId
}

function activityLabel(tools: ToolUIPart[], reportCommands: number): string {
  const reads = new Set<string>()
  const changes = new Set<string>()
  let attachmentCalls = 0
  let commands = reportCommands
  let listedSkills = false
  let other = 0

  for (const part of tools) {
    const path = toolPath(part)
    if (part.type === READ_FILE_TOOL_PART_TYPE && path) {
      reads.add(path)
    } else if (part.type === READ_ATTACHMENT_TOOL_PART_TYPE) {
      attachmentCalls++
    } else if (
      (part.type === WRITE_FILE_TOOL_PART_TYPE ||
        part.type === EDIT_FILE_TOOL_PART_TYPE) &&
      path
    ) {
      changes.add(path)
    } else if (part.type === SHELL_TOOL_PART_TYPE) {
      commands++
    } else if (part.type === LIST_SKILLS_TOOL_PART_TYPE) {
      listedSkills = true
    } else if (part.type !== SHELL_OUTPUT_TOOL_PART_TYPE) {
      other++
    }
  }

  return (
    [
      countLabel(reads.size, 'Read', 'file'),
      attachmentCalls === 1 ? 'read attachment' : '',
      attachmentCalls > 1 ? `read attachment ×${attachmentCalls}` : '',
      countLabel(changes.size, 'edited', 'file'),
      countLabel(commands, 'ran', 'command'),
      listedSkills ? 'listed skills' : '',
      other ? `${other} other tool ${other === 1 ? 'call' : 'calls'}` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'Tool activity'
  )
}

function countLabel(count: number, verb: string, noun: string): string {
  return count ? `${verb} ${count} ${noun}${count === 1 ? '' : 's'}` : ''
}

function toolPath(part: ToolUIPart): string | undefined {
  // Input paths stay stable when a result adds a canonical absolute path
  const input = parseOutputValue<{ path?: unknown }>(part.input)
  const output = parseOutputValue<{ path?: unknown }>(part.output)
  const path = input?.path ?? output?.path
  return typeof path === 'string' && path.trim() ? path : undefined
}
