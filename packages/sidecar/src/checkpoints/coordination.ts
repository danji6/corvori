import { overlaps } from './group'

type Claim = {
  roots?: string[]
  keys?: string[]
  exclusive?: boolean
}

type Request = {
  claim: () => Claim
  start: () => Promise<void>
  ready: boolean
}

function conflicts(a: Claim, b: Claim) {
  return (
    a.exclusive ||
    b.exclusive ||
    a.keys?.some((key) => b.keys?.includes(key)) ||
    overlaps(a.roots ?? [], b.roots ?? [])
  )
}

/** Claims every resource before starting work and lets disjoint requests pass. */
export class CheckpointOperations {
  private pending: Request[] = []
  private active = new Set<Claim>()

  run<T>(
    claim: () => Claim,
    operation: () => Promise<T>,
    prepare?: () => Promise<void>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const request: Request = {
        claim,
        ready: !prepare,
        start: async () => {
          try {
            resolve(await operation())
          } catch (error) {
            reject(error)
          }
        },
      }
      this.pending.push(request)
      if (prepare) {
        void prepare().then(
          () => {
            request.ready = true
            this.dispatch()
          },
          (error: unknown) => {
            this.pending = this.pending.filter((item) => item !== request)
            reject(error)
            this.dispatch()
          },
        )
      }
      this.dispatch()
    })
  }

  private dispatch() {
    const earlier: Claim[] = []
    this.pending = this.pending.filter((request) => {
      const claim = request.claim()
      const busy = [...this.active, ...earlier].some((other) =>
        conflicts(claim, other),
      )
      if (!request.ready || busy) {
        earlier.push(claim)
        return true
      }
      this.active.add(claim)
      void Promise.resolve()
        .then(request.start)
        .finally(() => {
          this.active.delete(claim)
          this.dispatch()
        })
      return false
    })
  }
}

export type SnapshotTiming = {
  phase: 'begin' | 'finish'
  waitMs: number
  scanMs: number
  concurrent: number
}

export type SnapshotOptions = {
  concurrency?: number
  onTiming?: (timing: SnapshotTiming) => void
}

/** Limits disk-intensive scans after the workspace claim has been acquired. */
export class CheckpointScans {
  private active = 0
  private pending: Array<() => void> = []
  private readonly limit: number

  constructor(private readonly options: SnapshotOptions) {
    this.limit = options.concurrency ?? 4
    if (!Number.isInteger(this.limit) || this.limit < 1)
      throw new Error('Checkpoint scan concurrency must be a positive integer')
  }

  async run<T>(phase: SnapshotTiming['phase'], scan: () => Promise<T>) {
    const requested = performance.now()
    await this.acquire()
    const started = performance.now()
    const concurrent = this.active
    try {
      return await scan()
    } finally {
      this.release()
      this.options.onTiming?.({
        phase,
        concurrent,
        waitMs: started - requested,
        scanMs: performance.now() - started,
      })
    }
  }

  private acquire() {
    if (this.active >= this.limit)
      return new Promise<void>((resolve) => this.pending.push(resolve))
    this.active++
    return Promise.resolve()
  }

  private release() {
    const next = this.pending.shift()
    if (next) next()
    else this.active--
  }
}

export const groupKey = (id: string) => `group:${id}`
export const sessionKey = (id: string) => `session:${id}`
export const checkpointKey = (id: string) => `checkpoint:${id}`
