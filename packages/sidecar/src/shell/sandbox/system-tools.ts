import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
let tools: ReturnType<typeof findSystemTools> | undefined

async function findSystemTools() {
  const fallback = {
    git: '/usr/bin/git',
    path: '/usr/bin:/bin',
    reads: [] as string[],
  }
  if (process.platform !== 'darwin') return fallback
  const selected = await execute('/usr/bin/xcode-select', ['-p'], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 3000,
  }).catch(() => undefined)
  const developer = selected?.stdout.trim()
  if (!developer || !isAbsolute(developer)) return fallback
  const bin = join(developer, 'usr/bin')
  const git = await realpath(join(bin, 'git'))
  const python = await realpath(join(bin, 'python3')).catch(() => undefined)
  const reads = [git]
  if (python)
    reads.push(python, join(developer, 'Library/Frameworks/Python3.framework'))
  return {
    git,
    path: [python && dirname(python), dirname(git), fallback.path]
      .filter(Boolean)
      .join(':'),
    reads,
  }
}

/** Locate the system Git and Python runtimes without importing the user's shell environment. */
export function systemTools() {
  return (tools ??= findSystemTools())
}
