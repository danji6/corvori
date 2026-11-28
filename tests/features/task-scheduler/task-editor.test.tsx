import type { TaskEditor as TaskEditorComponent } from '@/components/chat/tasks/task-editor'
import { AccountScope } from '@/hooks/account-scope'
import { draftRestoreFor } from '@/lib/chat/draft-restore'
import {
  clearEditorDraft,
  getEditorDraft,
  taskDraftKey,
} from '@/lib/chat/editor-draft-store'
import type { Doc } from '@cv/convex/_generated/dataModel'
import { MAX_TASK_PROMPT_CHARS } from '@cv/core/limits'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { ConvexQueryCacheProvider } from 'convex-helpers/react/cache'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import type { createRoot as ReactCreateRoot } from 'react-dom/client'
import { setupReactDom } from '~/tests/setup/dom'

setupReactDom()

let TaskEditor: typeof TaskEditorComponent
let createRoot: typeof ReactCreateRoot

beforeAll(async () => {
  // React detects native input events when the renderer first loads.
  ;({ createRoot } = await import('react-dom/client'))
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]))
  try {
    ;({ TaskEditor } = await import('@/components/chat/tasks/task-editor'))
  } finally {
    fetch.mockRestore()
  }
})

const models = { models: [{ id: 'model', label: 'Mail model' }] }
const agent = { _id: 'mailbox', name: 'Mailbox' }
const accountId = 'task-editor-test'
const restoreQueue = draftRestoreFor(accountId)
const task = {
  _id: 'task-id',
  agentId: 'mailbox',
  modelId: 'model',
  reasoningEffort: 'high',
  prompt: 'Check my mailbox',
  schedule: {
    startDate: '2026-01-01',
    time: '09:00',
    zone: 'UTC',
    repeat: { kind: 'daily', every: 1 },
  },
} as Doc<'scheduledTasks'>

afterEach(() => {
  clearEditorDraft(accountId, taskDraftKey(task._id))
  clearEditorDraft(accountId, taskDraftKey())
  const pending = restoreQueue.peek()
  if (pending) restoreQueue.dismiss(pending)
})

function editorFixture() {
  const container = document.createElement('div')
  const root = createRoot(container)
  const client = new ConvexReactClient('http://localhost:3210')
  const results: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  const mutation = spyOn(client, 'mutation').mockResolvedValue('task-id')
  const watch = spyOn(client, 'watchQuery').mockImplementation(
    (ref, ..._args) =>
      ({
        onUpdate(callback: () => void) {
          listeners.add(callback)
          return () => listeners.delete(callback)
        },
        localQueryResult: () => results[getFunctionName(ref)],
        localQueryLogs: () => undefined,
        journal: () => undefined,
      }) as never,
  )
  const render = (definition?: Doc<'scheduledTasks'> | null) =>
    act(async () =>
      root.render(
        <ConvexProvider client={client}>
          <ConvexQueryCacheProvider>
            <AccountScope userId={accountId}>
              {definition !== null && (
                <TaskEditor key={definition?._id} task={definition} />
              )}
            </AccountScope>
          </ConvexQueryCacheProvider>
        </ConvexProvider>,
      ),
    )
  const update = (values: Record<string, unknown>) =>
    act(async () => {
      Object.assign(results, values)
      for (const listener of [...listeners]) listener()
    })
  const close = async () => {
    act(() => root.unmount())
    mutation.mockRestore()
    watch.mockRestore()
    await client.close()
  }
  return { container, render, update, mutation, close }
}

function taskPrompt(container: HTMLElement) {
  return container.querySelector<HTMLElement & { editor: Editor }>(
    '[role="textbox"][contenteditable="true"]',
  )!
}

test('editing restores the late-loaded agent and saves the edited time at minute precision', async () => {
  const { container, render, update, mutation, close } = editorFixture()
  const repeat = { kind: 'hours', every: 2 } as const
  const prompt = 'Prompt:\n\n1. Check my mailbox\n   thoroughly'
  try {
    await render({ ...task, prompt, schedule: { ...task.schedule, repeat } })
    const form = container.querySelector('form')!
    const picker = form.querySelector<HTMLButtonElement>('[role="combobox"]')!
    const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(picker.textContent).toContain('Select agent')
    expect(save.disabled).toBe(true)

    await update({
      'agents:list': [agent],
      'models:list': models,
      'settings:get': {
        recentModel: 'different-model',
        recentReasoning: 'low',
      },
    })
    expect(picker.textContent).toContain('Mailbox')
    expect(save.disabled).toBe(false)
    expect(
      form.querySelector('[aria-label="Reasoning effort"]')?.textContent,
    ).toContain('High')
    const interval = form.querySelector<HTMLInputElement>('input[type=number]')!
    expect(interval.closest('label')?.textContent).toContain('Interval (hours)')
    expect(interval.value).toBe('2')

    const minute = form.querySelector<HTMLElement>('[data-type="minute"]')!
    await act(async () => {
      minute.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          bubbles: true,
          cancelable: true,
        }),
      )
    })

    await act(async () => form.requestSubmit(save))
    expect(mutation.mock.calls[0]?.[1]).toMatchObject({
      taskId: 'task-id',
      definition: {
        agentId: 'mailbox',
        modelId: 'model',
        reasoningEffort: 'high',
        prompt,
        schedule: {
          startDate: '2026-01-01',
          time: '09:01',
          zone: 'UTC',
          repeat,
        },
      },
    })
  } finally {
    await close()
  }
})

test('new tasks show the composer selections only when they exist', async () => {
  const { container, render, update, close } = editorFixture()
  try {
    await update({
      'agents:list': [],
      'models:list': models,
      'settings:get': {},
    })
    await render()
    const model = container.querySelectorAll('[role="combobox"]')[1]
    const effort = container.querySelector('[aria-label="Reasoning effort"]')
    expect(model.textContent).toContain('Select model')
    expect(effort?.textContent).toContain('Select effort')

    await update({ 'settings:get': { recentModel: 'model' } })
    expect(model.textContent).toContain('Mail model')
    expect(effort?.textContent).toContain('Select effort')

    await update({
      'settings:get': { recentModel: 'model', recentReasoning: 'medium' },
    })
    expect(effort?.textContent).toContain('Medium')
  } finally {
    await close()
  }
})

test('weekly repeats preserve saved days and select every day by default', async () => {
  const { container, render, close } = editorFixture()
  const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: new EventTarget(),
  })
  document.body.append(container)

  const days = () => [
    ...container.querySelectorAll<HTMLElement>('fieldset [role="checkbox"]'),
  ]
  const checkedDays = () =>
    days()
      .filter((day) => day.getAttribute('aria-checked') === 'true')
      .map((day) => day.closest('label')?.textContent)

  try {
    await render({
      ...task,
      schedule: {
        ...task.schedule,
        repeat: { kind: 'weekly', every: 1, weekdays: [1, 2, 3, 4, 5] },
      },
    })
    expect(checkedDays()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

    const repeatLabel = [...container.querySelectorAll('label')].find(
      (label) => label.textContent === 'Repeat',
    )!
    const trigger = document.getElementById(repeatLabel.htmlFor)!
    for (const label of ['Daily', 'Weekly']) {
      await act(async () => trigger.click())
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((item) => item.textContent === label)!
      await act(async () => option.click())
    }
    expect(days()).toHaveLength(7)
    expect(checkedDays()).toHaveLength(7)
    const sunday = days()[6].closest('label')!.querySelector('input')!
    await act(async () => sunday.click())
    expect(checkedDays()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  } finally {
    await close()
    container.remove()
    if (fonts) Object.defineProperty(document, 'fonts', fonts)
    else Reflect.deleteProperty(document, 'fonts')
  }
})

test('reopens saved grants and requires confirmation of a changed workspace', async () => {
  const { container, render, update, mutation, close } = editorFixture()
  const workspace = { workspaceId: 'folder', revision: 2, path: '/new' }
  const folder = { _id: 'folder', name: 'Project', workspace }
  try {
    await update({
      'agents:list': [agent],
      'models:list': models,
      'users:getProfile': { role: 'admin' },
      'sessionFolders:get': folder,
      'sessionFolders:picker': {
        page: [folder],
        isDone: true,
        continueCursor: '',
      },
    })
    await render({
      ...task,
      folderId: 'folder' as Doc<'scheduledTasks'>['folderId'],
      approvals: { shell: ['git checkout'], paths: ['reports'] },
      approvalWorkspaceKey: '["folder",1,["/old"]]',
    })
    const form = container.querySelector('form')!
    const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(
      form.querySelector('[aria-label="Remove git checkout"]'),
    ).not.toBeNull()
    expect(form.querySelector('[aria-label="Remove reports"]')).not.toBeNull()
    expect(form.querySelector('[role="status"]')?.textContent).toContain(
      'sources changed',
    )
    expect(save.disabled).toBe(true)
    const confirm = [...form.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Confirm grants'),
    )
    await act(async () => confirm?.click())
    expect(save.disabled).toBe(false)
    await act(async () => form.requestSubmit(save))
    expect(mutation.mock.calls[0]?.[1]).toMatchObject({
      reviewedWorkspaceKey: '["folder",2,["/new"]]',
      definition: {
        folderId: 'folder',
        approvals: { shell: ['git checkout'], paths: ['reports'] },
      },
    })
  } finally {
    await close()
  }
})

test('restores the task draft with its formatted prompt and schedule, and keeps it if saving fails', async () => {
  const { container, render, update, mutation, close } = editorFixture()
  const readDraft = () => getEditorDraft(accountId, taskDraftKey(task._id))
  const title = () =>
    container.querySelector<HTMLInputElement>('input[name="title"]')!
  const minute = () =>
    container.querySelector<HTMLElement>('[data-type="minute"]')!
  const prompt = '# Inbox\n\nCheck **unread mail**.'
  const schedule = { ...task.schedule, time: '09:01' }
  try {
    await update({ 'agents:list': [agent], 'models:list': models })
    await render(task)
    expect(readDraft()).toBeUndefined()
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(title(), 'Mail review')
      title().dispatchEvent(new Event('input', { bubbles: true }))
      minute().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          bubbles: true,
          cancelable: true,
        }),
      )
      taskPrompt(container).editor.commands.setContent(prompt, {
        contentType: 'markdown',
      })
    })
    expect(readDraft()).toMatchObject({
      values: { title: 'Mail review', content: prompt, schedule },
    })

    await render(null)
    await render()
    expect(restoreQueue.peek()).toBeUndefined()
    expect(taskPrompt(container).textContent).toBe('')

    await render(task)
    expect(taskPrompt(container).textContent).toBe(task.prompt)
    const pending = restoreQueue.peek()!
    expect(pending.key).toBe(taskDraftKey(task._id))
    await act(async () => restoreQueue.restore(pending))
    expect(taskPrompt(container).querySelector('h1')?.textContent).toBe('Inbox')
    expect(taskPrompt(container).querySelector('p')?.textContent).toBe(
      'Check **unread mail**.',
    )
    expect(title().value).toBe('Mail review')

    const form = container.querySelector('form')!
    const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    mutation.mockRejectedValueOnce(new Error('Save failed'))
    await act(async () => form.requestSubmit(save))
    expect(form.querySelector('[role="alert"]')?.textContent).toContain(
      'Save failed',
    )
    expect(readDraft()).toBeDefined()

    await act(async () => form.requestSubmit(save))
    expect(mutation.mock.calls[1]?.[1]).toMatchObject({
      taskId: task._id,
      definition: { title: 'Mail review', prompt, schedule },
    })
    expect(readDraft()).toBeUndefined()
  } finally {
    await close()
  }
})

test('keeps an incomplete new task draft until the user discards it', async () => {
  const { container, render, close } = editorFixture()
  document.body.append(container)
  try {
    await render()
    const prompt = 'a'.repeat(MAX_TASK_PROMPT_CHARS + 1)
    await act(async () =>
      taskPrompt(container).editor.commands.insertContent(prompt),
    )
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      '16,000',
    )
    const readDraft = () => getEditorDraft(accountId, taskDraftKey())
    expect(readDraft()).toMatchObject({ values: { content: prompt } })

    await render(null)
    await render()
    const pending = restoreQueue.peek()!
    expect(pending.key).toBe(taskDraftKey())
    await act(async () => restoreQueue.discard(pending))
    expect(readDraft()).toBeUndefined()
    expect(taskPrompt(container).textContent).toBe('')

    await act(async () => {
      taskPrompt(container).editor.commands.insertContent('Check my mailbox')
    })
    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    )!
    await act(async () => cancel.click())
    expect(readDraft()).toBeDefined()
    const dialog = document.querySelector('[role="alertdialog"]')!
    const discard = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Discard',
    )!
    await act(async () => discard.click())
    expect(readDraft()).toBeUndefined()
  } finally {
    await close()
    container.remove()
  }
})
