import type { TaskEditor as TaskEditorComponent } from '@/components/chat/tasks/task-editor'
import type { Doc } from '@cv/convex/_generated/dataModel'
import { beforeAll, expect, spyOn, test } from 'bun:test'
import { ConvexQueryCacheProvider } from 'convex-helpers/react/cache'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { setupReactDom } from '~/tests/setup/dom'

setupReactDom()

let TaskEditor: typeof TaskEditorComponent

beforeAll(async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]))
  try {
    ;({ TaskEditor } = await import('@/components/chat/tasks/task-editor'))
  } finally {
    fetch.mockRestore()
  }
})

const models = { models: [{ id: 'model', label: 'Mail model' }] }
const agent = { _id: 'mailbox', name: 'Mailbox' }
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
  const render = (definition?: Doc<'scheduledTasks'>) =>
    act(async () =>
      root.render(
        <ConvexProvider client={client}>
          <ConvexQueryCacheProvider>
            <TaskEditor task={definition} />
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

test('editing restores the late-loaded agent and saves the edited time at minute precision', async () => {
  const { container, render, update, mutation, close } = editorFixture()
  const repeat = { kind: 'hours', every: 2 } as const
  try {
    await render({ ...task, schedule: { ...task.schedule, repeat } })
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
