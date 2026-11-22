import type { MessageRow } from '@/lib/chat/rows'
import { DEFAULT_SETTINGS } from '@cv/convex/model/defaults'
import { parseShellCommand } from '@cv/core/shell/command'
import type { UIMessage } from 'ai'
import type { ConvexReactClient } from 'convex/react'
import { type FunctionReference, getFunctionName } from 'convex/server'

type NoteType =
  'skills' | 'mcp' | 'workspace' | 'command' | 'todo' | 'contextReset'

function message(id: string, time: number, type?: NoteType) {
  const text = noteText(id)
  const parts: UIMessage['parts'] =
    id === 'work'
      ? [
          {
            type: 'tool-read_file',
            toolCallId: 'read',
            state: 'output-available',
            input: { path: 'notes.md' },
            output: 'File contents',
          },
        ]
      : type === 'command' || type === 'contextReset'
        ? []
        : [{ type: 'text', text }]
  return {
    _id: id,
    _creationTime: time,
    sessionId: 'notes',
    role: id === 'work' ? 'assistant' : type ? 'system' : 'user',
    sender: { type: 'agent', id: 'agent' },
    status: 'done',
    selectedVersion: 1,
    versionCount: 1,
    hidden: !!type,
    type,
    extra: noteExtra(type),
    segments: [{ segmentIndex: 0, parts, sizeBytes: text.length }],
    sizeBytes: text.length,
    hasOlderSegments: false,
    hasNewerSegments: false,
  }
}

function noteText(id: string) {
  const text =
    id === 'workspace'
      ? '<system-reminder>\n\n**Workspace details**\n\n' +
        'long-path/'.repeat(50) +
        '\n\n</system-reminder>'
      : `Content for ${id}`
  return text
}

function noteExtra(type?: NoteType) {
  return type === 'workspace'
    ? { label: 'Reverse Engineering' }
    : type === 'command'
      ? {
          name: 'timeout',
          argument: '30',
          status: 'failed',
          error: 'Command failed',
        }
      : undefined
}

const params = new URLSearchParams(location.search)
let continuationActive = params.has('continuation')
let messages = initialMessages()
let planContent = 'Original plan'
let submittedShell: ReturnType<typeof message> | undefined

function initialMessages() {
  if (params.has('contextReset')) {
    return [
      {
        ...message('before-reset', 1),
        role: 'assistant',
        metadata: { duration: 8300 },
      },
    ]
  }
  if (params.has('thinkingWork')) return thinkingWorkMessages()
  if (continuationActive) {
    const [earlier, current] = groupedWorkMessages()
    return [
      earlier,
      message('prompt', 1),
      { ...current, _creationTime: 2, metadata: { duration: 4200 } },
      message('todo', 3, 'todo'),
      {
        ...message('continuation', 4),
        role: 'assistant',
        status: 'processing',
        segments: [],
        sizeBytes: 0,
      },
    ]
  }
  if (params.has('groupedReply')) return groupedReplyMessages()
  if (params.has('shellComposer') || params.has('composer')) {
    return Array.from({ length: 32 }, (_, index) =>
      message(`history${index}`, index),
    )
  }
  if (params.has('compaction')) return compactionMessages()
  if (params.has('fileChanges')) return fileChangeMessages()
  if (params.has('shellReports')) return shellMessages()
  if (params.has('tailWork')) return tailWorkMessages()
  if (params.has('groupedWork')) return groupedWorkMessages()
  return [
    ...Array.from({ length: 35 }, (_, i) => message(`before${i}`, i)),
    message('mcp', 40, 'mcp'),
    message('workspace', 41, 'workspace'),
    message('skills', 42, 'skills'),
    message('command', 43, 'command'),
    ...Array.from({ length: Number(params.get('extraNotes') ?? 0) }, (_, i) =>
      message(`note${i}`, 44 + i / 1000, 'skills'),
    ),
    ...Array.from({ length: 35 }, (_, i) => message(`after${i}`, 50 + i)),
  ]
}

function thinkingWorkMessages() {
  return [
    {
      ...message('work', 0),
      metadata: { duration: 146_000 },
      segments: [
        {
          segmentIndex: 0,
          parts: [
            {
              type: 'reasoning',
              text: 'First thinking block.',
              state: 'done',
              duration: 10_000,
            },
            ...(params.get('thinkingWork') === 'single'
              ? []
              : [
                  {
                    type: 'reasoning',
                    text: 'Second thinking block.',
                    state: 'done',
                    duration: 62_000,
                  },
                ]),
            ...(params.has('mixedThinking')
              ? message('work', 0).segments[0].parts
              : []),
            { type: 'text', text: 'Finished thinking.' },
          ] as UIMessage['parts'],
          sizeBytes: 100,
        },
      ],
    },
  ]
}

function compactionMessages() {
  const command = {
    ...message('command', 0, 'command'),
    extra: { name: 'compact', argument: '', status: 'done' },
  }
  const summary = {
    ...message('summary', 1),
    role: 'assistant',
    type: 'summary' as const,
    segments: [
      {
        segmentIndex: 0,
        parts: [
          {
            type: 'reasoning' as const,
            text: 'Checking completed task status.',
          },
          {
            type: 'text' as const,
            text: 'Summary of the completed work.\n\n'.repeat(24),
          },
        ],
        sizeBytes: 100,
      },
    ],
  }
  const history = Array.from({ length: 16 }, (_, index) =>
    message(`before${index}`, index - 16),
  )
  return [...history, command, summary]
}

function fileChangeMessages(waitingForInput = false, extraOutput = '') {
  const longShell = params.has('longShell')
  const work = message('work', 0)
  work.segments[0].parts = [
    {
      type: 'tool-edit_file',
      toolCallId: 'edit',
      state: 'output-available',
      input: { path: 'first.ts' },
      output: { path: 'first.ts', diff: '-oldFirst\n+newFirst' },
    },
    { type: 'step-start' },
    {
      type: 'tool-write_file',
      toolCallId: 'write',
      state: 'output-available',
      input: { path: 'second.ts', content: 'newSecond' },
      output: { path: 'second.ts', diff: '+newSecond' },
    },
    {
      type: 'tool-edit_file',
      toolCallId: 'failed',
      state: 'output-error',
      input: { path: 'first.ts' },
      errorText: 'Original text was not found',
    },
    {
      type: 'tool-shell',
      toolCallId: 'verify',
      state: 'output-available',
      input: { command: 'bun test', description: 'Verify file changes.' },
      output: {
        jobId: 'verify-job',
        status: waitingForInput ? 'running' : 'done',
        exitCode: waitingForInput ? null : 0,
        waiting: waitingForInput,
        term: 'All checks passed.\r\n'.repeat(longShell ? 30 : 1) + extraOutput,
        termOffset: 0,
      },
    },
    { type: 'text', text: 'File changes finished.' },
  ]
  if (!longShell) return [work]
  const history = Array.from({ length: 16 }, (_, index) =>
    message(`before${index}`, index - 16),
  )
  return [...history, work]
}

function tailWorkMessages() {
  const work = message('work', 45)
  work.segments[0].parts = Array.from({ length: 8 }, (_, index) => [
    {
      type: 'tool-read_file' as const,
      toolCallId: `read${index}`,
      state: 'output-available' as const,
      input: { path: `file${index}.ts` },
      output: 'File contents',
    },
    { type: 'reasoning' as const, text: 'Checking the implementation.' },
  ]).flat()
  if (params.has('singleEdit')) {
    work.segments[0].parts = [
      {
        type: 'tool-edit_file',
        toolCallId: 'edit',
        state: 'output-available',
        input: { path: 'file.ts' },
        output: { path: 'file.ts', diff: '-old\n+new' },
      },
      {
        type: 'reasoning',
        text: 'Checking the edit.',
        state: 'done',
      },
    ]
  }
  work.segments[0].parts.push({
    type: 'text',
    text: 'Regression checks passed.\n\n'.repeat(10),
  })
  return [
    ...Array.from({ length: 35 }, (_, index) =>
      message(`before${index}`, index),
    ),
    work,
  ]
}

function groupedWorkMessages() {
  return ['first', 'second'].map((id, index) => ({
    ...message('work', index),
    _id: id,
    metadata: { duration: 8300 },
  }))
}

function groupedReplyMessages() {
  const followup = { ...message('work', 1), _id: 'followup' }
  followup.segments[0].parts.push({
    type: 'reasoning',
    text: 'Checking the implementation.',
    state: 'done',
  })
  return [
    message('work', 0),
    followup,
    { ...message('answer', 2), role: 'assistant' },
    message('next', 3),
  ]
}

function shellMessages() {
  const migrated = params.has('migratedShell')
  const jobId = 'shell-agent-job'
  const shell = (id: string) => ({
    type: 'tool-shell',
    toolCallId: id,
    state: 'output-available',
    input: { command: `printf ${id}` },
    output:
      id === 'user' && params.has('interactiveShell')
        ? {
            jobId: 'user-job',
            status: 'running',
            exitCode: null,
            waiting: false,
            term: 'Test input: ',
            termOffset: 0,
          }
        : id === 'agent2'
          ? {
              jobId,
              ...(!migrated && { jobNumber: 3 }),
              status: 'background',
              exitCode: null,
              text: '',
              term: '',
              termOffset: 0,
            }
          : `${id} output`,
  })
  const parts = [
    [shell('user')],
    [
      shell('agent1'),
      { type: 'step-start' },
      shell('agent2'),
      { type: 'text', text: 'Agent progress' },
    ],
    [
      {
        type: 'shell-report',
        jobId,
        command: 'bun lint',
        status: 'done',
        exitCode: 0,
        text: 'Lint passed',
      },
    ],
    [
      {
        type: 'tool-shell_output',
        toolCallId: 'poll',
        state: 'output-available',
        input: { jobId: migrated ? jobId : '3' },
        output: migrated
          ? 'Command output'
          : { jobId, jobNumber: 3, status: 'done', text: 'Command output' },
      },
      {
        type: 'tool-shell_output',
        toolCallId: 'poll-next',
        state: 'output-available',
        input: { jobId: '4' },
        output: {
          jobId: 'shell-deleted-command',
          jobNumber: 4,
          status: 'done',
          text: 'Next command output',
        },
      },
      { type: 'text', text: 'Finished' },
    ],
  ] as unknown as UIMessage['parts'][]

  return parts.map((parts, index) => ({
    ...message('work', index),
    _id: `shell${index}`,
    role: index === 0 || index === 2 ? 'user' : 'assistant',
    sender: {
      type: index === 0 ? 'user' : 'agent',
      id: index === 0 ? 'owner' : 'agent',
    },
    senderName: index === 0 ? 'User' : 'Code',
    metadata: { duration: index === 1 ? 109000 : index === 3 ? 37000 : 0 },
    segments: [{ segmentIndex: 0, parts, sizeBytes: 100 }],
  }))
}
const cache = new Map<string, unknown>()
const listeners = new Set<() => void>()

function query(name: string, args: Record<string, unknown>) {
  if (name === 'chat:getActiveStream' && continuationActive) {
    return {
      _id: 'stream',
      status: 'running',
      invokedBy: 'owner',
      processingMessageId: 'continuation',
    }
  }
  const readOnly = new URLSearchParams(location.search).has('readOnly')
  if (name === 'settings:get')
    return {
      ...DEFAULT_SETTINGS,
      ...(params.has('intoView') && { scrollMode: 'into-view' }),
      groupBySender: params.has('ungrouped')
        ? false
        : DEFAULT_SETTINGS.groupBySender,
    }
  if (name === 'users:getProfile')
    return {
      _id: readOnly ? 'viewer' : 'owner',
      role: params.has('shellComposer') ? 'admin' : 'user',
    }
  if (name === 'sessions:get')
    return {
      _id: 'notes',
      ownerId: 'owner',
      settings: { disabled: readOnly },
      ...(params.has('shellComposer') && {
        workspace: { workspaceId: 'workspace', folderId: 'folder' },
      }),
    }
  if (name === 'plans:get' && params.has('plan')) {
    return { status: 'draft', content: planContent }
  }
  if (
    name === 'tools:list' &&
    (params.has('longShell') ||
      params.has('interactiveShell') ||
      params.has('shellComposer'))
  )
    return [{ name: 'shell' }]
  if (
    name === 'shellJobs:reference' &&
    (args.jobId === '3' || args.jobId === 'shell-agent-job')
  ) {
    const source = messages.find((message) => message._id === 'shell1')
    if (!source) return null
    return {
      sessionId: 'notes',
      messageId: source._id,
      messageCreatedAt: source._creationTime,
      segmentIndex: 0,
      toolCallId: 'agent2',
      number: 3,
      terminal: {
        jobId: 'shell-agent-job',
        status: 'done',
        exitCode: 0,
        text: '',
        term: 'Saved terminal output\n',
        termOffset: 0,
      },
    }
  }
  if (name === 'chat:messagesWindow') {
    if (params.has('unloadedShell') && !args.anchor) {
      return {
        page: messages.filter((message) => message._id === 'shell3'),
        hasOlder: true,
        hasNewer: false,
        atTail: true,
      }
    }
    const unloaded =
      new URLSearchParams(location.search).has('unloaded') && !args.anchor
    return {
      page: unloaded ? messages.filter((m) => !m.hidden) : messages,
      hasOlder: unloaded,
      hasNewer: false,
      atTail: !args.anchor,
    }
  }
  if (name.endsWith(':list') || name === 'chat:processingMessageSegments')
    return []
  return null
}

export function stopContinuation() {
  continuationActive = false
  messages = messages.filter((message) => message._id !== 'continuation')
  refresh()
}

export const notesClient = {
  watchQuery(
    reference: FunctionReference<'query'>,
    args: Record<string, unknown>,
  ) {
    const name = getFunctionName(reference)
    const key = `${name}:${JSON.stringify(args)}`
    return {
      onUpdate(callback: () => void) {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
      localQueryResult() {
        if (!cache.has(key)) cache.set(key, query(name, args))
        return cache.get(key)
      },
      localQueryLogs: () => [],
      journal: () => undefined,
    }
  },
  async action(reference: FunctionReference<'action'>, args: { data: string }) {
    const name = getFunctionName(reference)
    if (name === 'actions/terminals:list')
      return {
        jobs: terminalJobs(),
      }
    if (name === 'actions/terminals:write')
      document.body.dataset.terminalInput =
        (document.body.dataset.terminalInput ?? '') + args.data
  },
  async mutation(
    reference: FunctionReference<'mutation'>,
    args: { messageId?: string; content?: string },
  ) {
    const name = getFunctionName(reference)
    if (name === 'plans:update' && params.has('plan')) {
      planContent = args.content ?? ''
      refresh()
      return
    }
    if (name === 'chat:resetContext' && params.has('contextReset')) {
      messages = [
        ...messages,
        {
          ...message(
            `context-reset-${messages.length}`,
            Date.now(),
            'contextReset',
          ),
          sender: { type: 'user', id: 'owner' },
        },
      ]
      refresh()
      return { queued: false }
    }
    const canSend = params.has('composer') || params.has('contextReset')
    if (name === 'chat:sendMessage' && canSend) {
      const sent = {
        ...message(`sent-${messages.length}`, Date.now()),
        sender: { type: 'user', id: 'owner' },
      }
      sent.segments[0].parts = [{ type: 'text', text: args.content ?? '' }]
      messages = [...messages, sent]
      refresh()
      return sent._id
    }
    if (name === 'chat:sendMessage' && params.has('shellComposer')) {
      const command = parseShellCommand(args.content ?? '')
      if (!command) throw new Error('Expected a shell command')
      const shell = {
        ...message('submitted-shell', Date.now()),
        sender: { type: 'user', id: 'owner' },
        status: 'processing',
      }
      shell.segments[0].parts = [
        {
          type: 'tool-shell',
          toolCallId: 'submitted-shell',
          state: 'input-available',
          input: { command },
        },
      ]
      submittedShell = shell
      messages = [...messages, shell]
      refresh()
      return shell._id
    }
    const anchor = messages.find((m) => m._id === args.messageId)
    if (name === 'chat:deleteMessage')
      messages = messages.filter((m) => m._id !== args.messageId)
    if (name === 'chat:deleteMessagesFrom' && anchor)
      messages = messages.filter((m) => m._creationTime < anchor._creationTime)
    refresh()
  },
} as unknown as ConvexReactClient

const interactiveShellJob = {
  jobId: 'user-job',
  status: 'running',
  background: false,
  waiting: false,
  allowInteractiveShells: true,
  mode: 'script',
}

let verifyWaiting = false
let submittedShellWaiting = false

function terminalJobs() {
  if (params.has('interactiveShell')) return [interactiveShellJob]
  if (verifyWaiting)
    return [{ ...interactiveShellJob, jobId: 'verify-job', waiting: true }]
  if (submittedShellWaiting)
    return [{ ...interactiveShellJob, jobId: 'submitted-job', waiting: true }]
  return []
}

export function waitForShellInput() {
  verifyWaiting = true
  messages = fileChangeMessages(true)
  refresh()
}

export function appendWaitingShellOutput() {
  messages = fileChangeMessages(true, 'More output.\r\n')
  refresh()
}

export function publishSubmittedShellOutput(event: Event) {
  const shell = submittedShell
  const part = shell?.segments[0].parts[0]
  if (!shell || part?.type !== 'tool-shell') return
  const result = (event as CustomEvent<boolean | 'empty-exit'>).detail
  submittedShellWaiting = result === true
  const segments: typeof shell.segments = [
    {
      segmentIndex: 0,
      sizeBytes: 500,
      parts: [
        {
          type: part.type,
          toolCallId: part.toolCallId,
          input: part.input,
          state: 'output-available',
          output: {
            jobId: 'submitted-job',
            status: submittedShellWaiting ? 'running' : 'done',
            exitCode: submittedShellWaiting ? null : 0,
            waiting: submittedShellWaiting,
            term:
              result === 'empty-exit' ? '' : 'Command output\r\n'.repeat(30),
          },
        },
      ],
    },
  ]
  const status = submittedShellWaiting ? 'processing' : 'done'
  const updated = { ...shell, status, segments }
  submittedShell = updated
  messages = messages.map((entry) => (entry === shell ? updated : entry))
  refresh()
}

function refresh() {
  cache.clear()
  listeners.forEach((listener) => listener())
}

export function appendNote() {
  const index = messages.findIndex((m) => m._id === 'command')
  const extra = message('extra', 44)
  extra.hidden = true
  extra.segments[0].parts = []
  messages = [
    ...messages.slice(0, index + 1),
    extra,
    ...messages.slice(index + 1),
  ]
  cache.clear()
  listeners.forEach((listener) => listener())
}

export function isNoteRow(row: MessageRow) {
  return row.kind === 'hidden' || row.kind === 'note-group'
}
