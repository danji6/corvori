/// <reference types="bun-types" />
import { ContextMenu } from '@/components/ui/context-menu'
import { afterEach, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { setupReactDom } from '~/tests/setup/dom'

setupReactDom()

let container: HTMLElement | undefined
let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

function openMenu(trigger: Element, x = 40, shiftKey = false) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: x,
    clientY: 40,
    shiftKey,
  })
  act(() => {
    trigger.dispatchEvent(event)
  })
  return event.defaultPrevented
}

test('reopens on successive right clicks and lets Shift bypass the menu', () => {
  const openPoints: number[] = []
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  act(() => {
    root?.render(
      <ContextMenu onOpen={({ x }) => openPoints.push(x)}>
        <ContextMenu.Trigger>
          <span>Message</span>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item>Copy</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu>,
    )
  })
  const trigger = container.querySelector('span')!

  expect(openMenu(trigger)).toBe(true)
  expect(openMenu(trigger)).toBe(true)
  expect(openMenu(trigger, 60)).toBe(true)
  expect(menu()?.querySelector('button')?.textContent).toBe('Copy')
  expect(openPoints).toEqual([40, 40, 60])

  expect(openMenu(trigger, 60, true)).toBe(false)
  expect(menu()).toBeNull()
  expect(openPoints).toEqual([40, 40, 60])
})

function startTouch(trigger: Element, x: number) {
  const event = new Event('touchstart', { bubbles: true })
  Object.defineProperty(event, 'touches', {
    value: [{ clientX: x, clientY: 40 }],
  })
  act(() => {
    trigger.dispatchEvent(event)
  })
}

function menu() {
  return document.querySelector('[role="menu"]')
}

test.each(['mouse', 'touch'] as const)(
  'leaves the native menu available when there are no app items (%s)',
  (input) => {
    const openChanges: boolean[] = []

    function Items({ available }: { available: boolean }) {
      return available ? <ContextMenu.Item>Copy</ContextMenu.Item> : null
    }

    function Menu() {
      const [available, setAvailable] = useState(false)
      return (
        <ContextMenu
          onOpen={({ x }) => setAvailable(x >= 40)}
          onOpenChange={(open) => openChanges.push(open)}
        >
          <ContextMenu.Trigger>
            <span>Message</span>
          </ContextMenu.Trigger>
          <ContextMenu.Content>
            <ContextMenu.Separator />
            <Items available={available} />
          </ContextMenu.Content>
        </ContextMenu>
      )
    }

    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    act(() => root?.render(<Menu />))
    const trigger = container.querySelector('span')!

    if (input === 'touch') startTouch(trigger, 20)
    expect(openMenu(trigger, 20)).toBe(false)
    expect(menu()).toBeNull()
    expect(openChanges).toEqual([false])

    if (input === 'touch') startTouch(trigger, 40)
    expect(openMenu(trigger)).toBe(true)
    const item = menu()?.querySelector('button')
    expect(item?.textContent).toBe('Copy')
    expect(openChanges).toEqual([false, true])
    if (input === 'touch') expect(openMenu(trigger)).toBe(true)
    act(() => item?.click())
    expect(menu()).toBeNull()
    expect(openChanges).toEqual([false, true, false])
  },
)

test('discards an empty submenu and keeps its parent open', () => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  act(() => {
    root?.render(
      <ContextMenu>
        <ContextMenu.Trigger>
          <span>Message</span>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger>More</ContextMenu.SubTrigger>
            <ContextMenu.SubContent>{null}</ContextMenu.SubContent>
          </ContextMenu.Sub>
        </ContextMenu.Content>
      </ContextMenu>,
    )
  })

  openMenu(container.querySelector('span')!)
  const trigger = menu()?.querySelector('button')
  expect(trigger?.textContent).toBe('More')
  act(() => trigger?.click())
  expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
})

test('closes an open menu if its last item disappears', async () => {
  function Items() {
    const [available, setAvailable] = useState(true)
    return (
      <div>
        {available && <ContextMenu.Item>Copy</ContextMenu.Item>}
        <button onClick={() => setAvailable(false)}>Remove item</button>
      </div>
    )
  }

  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  act(() => {
    root?.render(
      <ContextMenu>
        <ContextMenu.Trigger>
          <span>Message</span>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <Items />
        </ContextMenu.Content>
      </ContextMenu>,
    )
  })

  openMenu(container.querySelector('span')!)
  const popup = menu()!
  const itemsChanged = new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect()
      resolve()
    })
    observer.observe(popup, { childList: true, subtree: true })
  })

  act(() =>
    popup.querySelector<HTMLButtonElement>('button:last-child')?.click(),
  )
  await act(async () => itemsChanged)
  expect(menu()).toBeNull()
})
