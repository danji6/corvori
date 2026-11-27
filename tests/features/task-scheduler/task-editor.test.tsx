import type { Doc } from '@cv/convex/_generated/dataModel'
import { expect, spyOn, test } from 'bun:test'
import * as convex from 'convex/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { setupReactDom } from '~/tests/setup/dom'

setupReactDom()

test('editing restores the assigned agent when query results arrive after mounting', async () => {
  const { TaskEditor } = await import('@/components/chat/tasks/task-editor')
  const rootElement = document.createElement('div')
  const root = createRoot(rootElement)
  const query = spyOn(convex, 'useQuery').mockReturnValue(undefined)
  const client = new convex.ConvexReactClient('http://localhost:3210')
  const task = {
    agentId: 'mailbox',
    schedule: {
      startDate: '2026-01-01',
      time: '09:00',
      zone: 'UTC',
      repeat: { kind: 'daily', every: 1 },
    },
  } as Doc<'scheduledTasks'>
  const render = () =>
    act(async () =>
      root.render(
        <convex.ConvexProvider client={client}>
          <TaskEditor task={task} />
        </convex.ConvexProvider>,
      ),
    )
  try {
    await render()
    const select = rootElement.querySelector<HTMLSelectElement>(
      'select[name="agent"]',
    )!
    query.mockReturnValue([{ _id: 'mailbox', name: 'Mailbox' }])
    await render()
    expect(select.value).toBe('mailbox')
  } finally {
    act(() => root.unmount())
    query.mockRestore()
    await client.close()
  }
})
