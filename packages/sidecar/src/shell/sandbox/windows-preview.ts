import { type ContainerRequest, spawn } from '@microsoft/mxc-sdk/v1'
import { readFile } from 'node:fs/promises'

const request: ContainerRequest = JSON.parse(
  await readFile(process.argv[2], 'utf8'),
)
const child = await spawn(request)
const stop = () => child.kill()
const input = child.standardInput
try {
  if (input)
    process.stdin.pipe(input).on('error', () => process.stdin.unpipe(input))
  child.standardOutput?.pipe(process.stdout)
  child.standardError?.pipe(process.stderr)
  process.on('SIGTERM', stop)
  process.exitCode = (await child.wait()).exitCode
} finally {
  if (input) process.stdin.unpipe(input)
  process.stdin.pause()
  process.off('SIGTERM', stop)
  child.dispose()
}
