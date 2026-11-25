import { useLayoutEffect, useState } from 'react'

export type KeyboardViewport = {
  bottomInset: number
  height?: number
}

/** Converts visual viewport geometry into dock positioning constraints. */
export function keyboardViewport(
  layoutHeight: number,
  viewport?: Pick<VisualViewport, 'height' | 'offsetTop'>,
): KeyboardViewport {
  if (!viewport) return { bottomInset: 0 }
  return {
    bottomInset: Math.max(
      0,
      layoutHeight - viewport.height - viewport.offsetTop,
    ),
    height: viewport.height,
  }
}

/** Tracks the visible height and layout bottom obscured by a virtual keyboard. */
export function useKeyboardViewport() {
  const [metrics, setMetrics] = useState<KeyboardViewport>({ bottomInset: 0 })

  useLayoutEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const next = keyboardViewport(window.innerHeight, vv)
      setMetrics((current) =>
        current.height === next.height &&
        current.bottomInset === next.bottomInset
          ? current
          : next,
      )
    }
    update()
    window.addEventListener('resize', update)
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return metrics
}

/** Height of the layout viewport hidden behind the virtual keyboard. */
export function useKeyboardInset() {
  return useKeyboardViewport().bottomInset
}
