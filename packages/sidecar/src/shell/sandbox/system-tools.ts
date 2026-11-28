import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
let tools: ReturnType<typeof findSystemTools> | undefined

/** Locate a full Python installation on the sidecar's startup PATH. */
async function windowsPython(windows: string) {
  const system = join(windows, 'System32')
  const found = await execute(join(system, 'where.exe'), ['python.exe'], {
    cwd: system,
    timeout: 3000,
  }).catch(() => undefined)
  for (const candidate of found?.stdout.trim().split(/\r?\n/) ?? []) {
    if (!isAbsolute(candidate)) continue
    const root = dirname(candidate)
    if (
      await stat(join(root, 'Lib/os.py')).then(
        (file) => file.isFile(),
        () => false,
      )
    )
      return realpath(root)
  }
}

async function findSystemTools() {
  const fallback = {
    git: '/usr/bin/git',
    path: '/usr/bin:/bin',
    reads: [] as string[],
  }
  if (process.platform === 'win32') {
    const programs = process.env.ProgramFiles
    const windows = process.env.SystemRoot
    if (!programs || !windows) throw new Error('Missing Windows system paths')
    const gitHome = await realpath(join(programs, 'Git'))
    const git = await realpath(join(gitHome, 'cmd', 'git.exe'))
    const python = await windowsPython(windows)
    return {
      git,
      path: [dirname(git), python, join(windows, 'System32')]
        .filter(Boolean)
        .join(delimiter),
      reads: python ? [gitHome, python] : [gitHome],
    }
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
