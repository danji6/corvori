import {
  type LinuxSandboxParams,
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

// Run native preparation in the job's cwd with its clean environment. The sidecar owns the policy file.
const policy: LinuxSandboxParams = JSON.parse(
  await readFile(process.argv[2]!, 'utf8'),
)
let child: ChildProcess | undefined
let cancelled = false
function cancel(signal: NodeJS.Signals) {
  cancelled = true
  child?.kill(signal)
}
process.on('SIGINT', cancel)
process.on('SIGTERM', cancel)
try {
  const command = await wrapCommandWithSandboxLinux(policy)
  if (cancelled) {
    process.exitCode = 1
  } else {
    child = spawn('/bin/sh', ['-c', `exec ${command}`], { stdio: 'inherit' })
    const launched = child
    process.exitCode = await new Promise<number>((resolve, reject) => {
      launched.once('error', reject)
      launched.once('close', (code) => resolve(code ?? 1))
    })
  }
} finally {
  cleanupBwrapMountPoints()
  process.off('SIGTERM', cancel)
  process.off('SIGINT', cancel)
}
