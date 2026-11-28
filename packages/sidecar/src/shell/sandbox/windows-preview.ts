import {
  type ContainerRequest,
  probe,
  spawn,
  spawnWithPty,
} from '@microsoft/mxc-sdk/v1'
import { readFile } from 'node:fs/promises'

// The private policy is created by the sidecar and is outside the child's grants.
const request: ContainerRequest = JSON.parse(
  await readFile(process.argv[2], 'utf8'),
)
const facts = probe(request)
if (
  facts.error ||
  facts.tier !== 'base-container' ||
  facts.needsDaclAugmentation ||
  !facts.probes.baseContainerSupportsDenyPaths
)
  throw new Error(
    'Windows BaseContainer cannot enforce this workspace policy. Request the command again for approval.',
  )

const terminal = process.stdin.isTTY && process.stdout.isTTY
const size = () => ({
  rows: process.stdout.rows || 24,
  columns: process.stdout.columns || 80,
})
const pty = terminal ? await spawnWithPty(request, { size: size() }) : undefined
const child = pty ?? (await spawn(request))
const resize = () => pty?.resize(size())
const stop = () => child.kill()
try {
  const input = child.standardInput
  if (input)
    process.stdin.pipe(input).on('error', () => process.stdin.unpipe(input))
  child.standardOutput?.pipe(process.stdout)
  child.standardError?.pipe(process.stderr)
  if (pty) {
    process.stdin.setRawMode(true)
    process.stdout.on('resize', resize)
  }
  process.on('SIGTERM', stop)
  process.exitCode = (await child.wait()).exitCode
} finally {
  if (pty) process.stdin.setRawMode(false)
  process.stdin.pause()
  process.stdout.off('resize', resize)
  process.off('SIGTERM', stop)
  child.dispose()
}
