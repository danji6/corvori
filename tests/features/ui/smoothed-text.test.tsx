import { useSmoothedText } from '@/hooks/chat/smoothed-text'
import { expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { setupReactDom } from '~/tests/setup/dom'

setupReactDom()

function Harness({ text }: { text: string }) {
  return <span>{useSmoothedText(text, true)}</span>
}

test('animates each batch and fully reveals a short update during silence', () => {
  let nextId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const request = spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
    (callback) => {
      frames.set(++nextId, callback)
      return nextId
    },
  )
  const cancel = spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(
    (id) => {
      frames.delete(id)
    },
  )
  const host = document.createElement('div')
  const root = createRoot(host)
  const render = (text: string) =>
    act(() => root.render(<Harness text={text} />))
  const advance = (ms: number) => {
    const pending = [...frames.values()]
    frames.clear()
    act(() => pending.forEach((frame) => frame(performance.now() + ms)))
  }

  try {
    render('')
    render('Hi')
    advance(16)
    expect(host.textContent).toBe('H')
    advance(60)
    expect(host.textContent).toBe('Hi')
    expect(frames.size).toBe(0)

    const text = 'Hi there, here is a longer batch.'
    render(text)
    advance(90)
    expect(host.textContent?.length).toBeGreaterThan(2)
    expect(host.textContent?.length).toBeLessThan(text.length)
    advance(200)
    expect(host.textContent).toBe(text)
    expect(frames.size).toBe(0)
  } finally {
    act(() => root.unmount())
    request.mockRestore()
    cancel.mockRestore()
  }
})
