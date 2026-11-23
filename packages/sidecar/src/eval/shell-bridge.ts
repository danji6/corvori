import {
  MAX_MESSAGE_PART_BYTES,
  MAX_PROMPT_CONTENT_CHARS,
} from '@cv/core/limits'
import { parentPort } from 'node:worker_threads'

export type ShellCall = {
  type: 'shell'
  args: string[]
  buffer: SharedArrayBuffer
}

const headerBytes = Int32Array.BYTES_PER_ELEMENT
const capacity =
  Math.max(MAX_MESSAGE_PART_BYTES, MAX_PROMPT_CONTENT_CHARS * 3) + 1024

/** Blocks only the guest worker while the parent supervises the command. */
export function requestShell(...args: string[]): string {
  const buffer = new SharedArrayBuffer(headerBytes + capacity)
  const header = new Int32Array(buffer, 0, 1)
  parentPort?.postMessage({ type: 'shell', args, buffer } satisfies ShellCall)
  Atomics.wait(header, 0, 0)
  return new TextDecoder().decode(
    new Uint8Array(buffer, headerBytes, header[0] - 1),
  )
}

export function respondToShell(call: ShellCall, result: string) {
  const header = new Int32Array(call.buffer, 0, 1)
  const bytes = new Uint8Array(call.buffer, headerBytes)
  const { written } = new TextEncoder().encodeInto(result, bytes)
  Atomics.store(header, 0, written + 1)
  Atomics.notify(header, 0)
}
