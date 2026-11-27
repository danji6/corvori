import {
  type LinuxSandboxParams,
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

// Run native preparation in the job's cwd with its clean environment. The sidecar owns the policy file.
const policy: LinuxSandboxParams = JSON.parse(
  await readFile(process.argv[2]!, 'utf8'),
)
const command = await wrapCommandWithSandboxLinux(policy)
try {
  const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit' })
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
} finally {
  cleanupBwrapMountPoints()
}
