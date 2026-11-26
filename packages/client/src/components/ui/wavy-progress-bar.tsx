import { cn } from '@/lib/utils'
import { easeOut, useReducedMotion } from 'motion/react'
import { useEffectEvent, useLayoutEffect, useRef } from 'react'

const HEIGHT = 16
const MIDLINE = HEIGHT / 2
const STROKE = 4
const GAP = 4
const AMPLITUDE = 2
const WAVELENGTH = 20
const WAVE_PERIOD = 1000
const FILL_DURATION = 180
const SWEEP_DURATION = 1500
const SWEEP_PAUSE = 1500
const MIN_SWEEP = 0.12
const MAX_SWEEP = 0.52
const TWO_PI = 2 * Math.PI

type Segment = [from: number, to: number]

type WavyProgressBarProps = {
  /** Progress from 0 to 1. Omit when progress is unknown. */
  value?: number
  'aria-label'?: string
  'aria-valuetext'?: string
  className?: string
}

function WavyProgressBar({
  value,
  'aria-label': label = 'Loading',
  'aria-valuetext': valueText,
  className,
}: WavyProgressBarProps) {
  const svg = useRef<SVGSVGElement>(null)
  const fill = useRef<SVGPathElement>(null)
  const track = useRef<SVGPathElement>(null)
  const stop = useRef<SVGCircleElement>(null)
  const width = useRef(0)
  const waveStartedAt = useRef<number | undefined>(undefined)
  const reducedMotion = useReducedMotion()
  const progress =
    value !== undefined && Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 1)
      : undefined
  const displayed = useRef(progress)

  const draw = useEffectEvent((now: number) => {
    waveStartedAt.current ??= now
    const elapsed = reducedMotion ? 0 : Math.max(0, now - waveStartedAt.current)
    const end = width.current - STROKE / 2
    const paths = barPaths(end, displayed.current, elapsed)
    fill.current?.setAttribute('d', paths.fill)
    track.current?.setAttribute('d', paths.track)
    stop.current?.setAttribute('cx', `${end}`)
    stop.current?.setAttribute('visibility', paths.showStop ? 'visible' : 'hidden') // prettier-ignore
  })

  useLayoutEffect(() => {
    const element = svg.current
    if (!element) return
    width.current = element.clientWidth
    const observer = new ResizeObserver(([entry]) => {
      width.current = entry.contentRect.width
      draw(performance.now())
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const startedAt = performance.now()
    const from = displayed.current ?? 0
    let frame: number | undefined
    function tick(now: number) {
      const time = Math.min(Math.max(now - startedAt, 0) / FILL_DURATION, 1)
      const position =
        reducedMotion || progress === undefined || time === 1
          ? progress
          : from + (progress - from) * easeOut(time)
      displayed.current = position
      draw(now)

      const filling = position !== progress
      const waving = position !== 0 && position !== 1
      if (!reducedMotion && (filling || waving)) {
        frame = requestAnimationFrame(tick)
      }
    }
    tick(startedAt)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [progress, reducedMotion])

  return (
    <svg
      ref={svg}
      data-slot="wavy-progress-bar"
      className={cn('block w-full', className)}
      height={HEIGHT}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress === undefined ? undefined : progress * 100}
      aria-valuetext={valueText}
    >
      <g fill="none" strokeWidth={STROKE} strokeLinecap="round">
        <path ref={track} className="stroke-m3-secondary-container" />
        <path ref={fill} className="stroke-m3-primary" strokeLinejoin="round" />
      </g>
      <circle
        ref={stop}
        cy={MIDLINE}
        r={1}
        visibility="hidden"
        className="fill-m3-primary"
      />
    </svg>
  )
}

function barPaths(end: number, progress: number | undefined, elapsed: number) {
  const start = STROKE / 2
  if (end <= start) return { fill: '', track: '', showStop: false }

  const segments = fillSegments(start, end, progress, elapsed)
  const amplitude =
    progress === undefined
      ? AMPLITUDE
      : AMPLITUDE * Math.min(1, progress / 0.08, (1 - progress) / 0.04)
  const fill = segments
    .map(([from, to]) => wavePath(from, to, amplitude, elapsed))
    .join(' ')

  const clearance = STROKE + GAP
  let trackFrom = start
  let track = ''
  for (const [from, to] of segments) {
    track += flatPath(trackFrom, from - clearance)
    trackFrom = to + clearance
  }
  track += flatPath(trackFrom, end)
  return { fill, track, showStop: progress !== undefined && trackFrom <= end }
}

function fillSegments(
  start: number,
  end: number,
  progress: number | undefined,
  elapsed: number,
): Segment[] {
  const length = end - start
  if (progress !== undefined) {
    return progress > 0 ? [[start, start + length * progress]] : []
  }

  const sweepTime = 2 * SWEEP_DURATION
  const time = elapsed % (sweepTime + SWEEP_PAUSE)
  const sweep = (Math.min(time, sweepTime) / SWEEP_DURATION) % 1
  // Grow around the moving center so both rounded ends keep moving right.
  const expansion = (1 - Math.cos(sweep * TWO_PI)) / 2
  const growth = (MAX_SWEEP - MIN_SWEEP) * expansion
  const from = start + length * (sweep - growth / 2)
  const to = start + length * (sweep + MIN_SWEEP + growth / 2)
  return to > end
    ? [
        [start, start + to - end],
        [from, end],
      ]
    : [[from, to]]
}

function flatPath(from: number, to: number) {
  return to >= from ? `M ${from} ${MIDLINE} H ${to}` : ''
}

function wavePath(
  from: number,
  to: number,
  amplitude: number,
  elapsed: number,
) {
  if (!amplitude) return flatPath(from, to)

  // A rising phase moves each crest left independently of the segment edges.
  const phase = ((elapsed % WAVE_PERIOD) / WAVE_PERIOD) * TWO_PI
  const points: string[] = []
  for (let x = from; ; x += 2) {
    const position = Math.min(x, to)
    const y =
      MIDLINE + amplitude * Math.sin((position / WAVELENGTH) * TWO_PI + phase)
    points.push(`${position.toFixed(2)} ${y.toFixed(2)}`)
    if (position === to) break
  }
  return `M ${points.join(' L ')}`
}

export { WavyProgressBar }
export type { WavyProgressBarProps }
