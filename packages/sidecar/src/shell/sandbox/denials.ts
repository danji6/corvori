import type { ShellDenial } from '@cv/core/shell/retry'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Accept one complete unified-log event with both the native sender and the job tag. */
export function seatbeltDenial(record: {
  processID?: number
  processImagePath?: string
  eventMessage?: string
}) {
  if (
    record.processID !== 0 &&
    record.processImagePath !== '/usr/libexec/sandboxd'
  )
    return
  const message = record.eventMessage
  if (typeof message !== 'string' || message.length > 8192) return
  const match =
    /^Sandbox: [^\n]+? deny(?:\(\d+\))? (file-read-data|file-write-[\w-]+|network-outbound)(?: ([^\r\n]*))?\n(CMD64_[\w+/=]+_END_\w+_SBX)$/.exec(
      message.trim(),
    )
  if (!match) return
  const [, operation, target, tag] = match
  const access = operation === 'network-outbound' ? 'network' : 'filesystem'
  const denial: ShellDenial = {
    access,
    operation,
    ...(target && { target: target.slice(0, 512) }),
  }
  return { tag, denial }
}

export async function readSeatbeltDenials(
  tag: string,
  started: number,
): Promise<ShellDenial[]> {
  if (!/^CMD64_[\w+/=]+_END_\w+_SBX$/.test(tag)) return []
  const seconds = Math.ceil((Date.now() - started) / 1000) + 2
  const predicate =
    '(processID == 0 OR processImagePath == "/usr/libexec/sandboxd") AND eventMessage ENDSWITH "' +
    tag +
    '"'
  const result = await execute(
    '/usr/bin/log',
    [
      'show',
      '--last',
      seconds + 's',
      '--style',
      'ndjson',
      '--predicate',
      predicate,
    ],
    { timeout: 2500, maxBuffer: 256 * 1024 },
  ).catch(() => undefined)
  const denials: ShellDenial[] = []
  for (const line of result?.stdout.split('\n') ?? []) {
    if (!line.startsWith('{')) continue
    let event
    try {
      event = seatbeltDenial(JSON.parse(line))
    } catch {
      continue
    }
    if (!event || event.tag !== tag) continue
    const { denial } = event
    if (
      !denials.some(
        (d) => d.operation === denial.operation && d.target === denial.target,
      )
    )
      denials.push(denial)
    if (denials.length >= 4) break
  }
  return denials
}
