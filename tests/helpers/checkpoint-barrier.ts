import { CheckpointStorage } from '@cv/sidecar/checkpoints/storage'

/** Pauses selected real blob writes until the test releases the scan. */
export class CheckpointBarrierStorage extends CheckpointStorage {
  private gate = Promise.withResolvers<void>()
  private arrivals = new Set<string>()
  private arrival = Promise.withResolvers<void>()

  constructor(
    root: string,
    private readonly pause: (text: string) => boolean,
  ) {
    super(root)
  }

  override async blob(bytes: Buffer) {
    const key = bytes.toString()
    if (this.pause(key)) {
      this.arrivals.add(key)
      this.arrival.resolve()
      this.arrival = Promise.withResolvers<void>()
      await this.gate.promise
    }
    return super.blob(bytes)
  }

  get count() {
    return this.arrivals.size
  }

  async until(count: number) {
    while (this.count < count) await this.arrival.promise
  }

  release() {
    this.gate.resolve()
  }
}

export function checkpointDeadline<T>(
  operation: Promise<T>,
  maxMs = 3_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Checkpoint operation timed out')),
      maxMs,
    )
  })
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}
