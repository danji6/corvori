import type { ShellRetryAccess } from '@cv/core/shell/retry'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { isOutside } from '../../mcp/workspace/access'
import type { StartShellJobInput } from '../job-protocol'
import { withBoundSessionDir } from '../system-shell'
import { snapshotGitPaths } from './ignore-snapshot'
import {
  linuxPaths,
  previewAvailable,
  runtimeReadPaths,
  wrapPreview,
} from './preview-platform'

const execute = promisify(execFile)

async function writableRoots(roots: string[], runtime: string) {
  const installation = await realpath(process.cwd())
  const trusted = [installation, runtime, await realpath(tmpdir())]
  const helpers = ['node_modules', 'packages', 'scripts', 'bin'].map((name) =>
    join(installation, name),
  )
  helpers.push(
    resolve(installation, process.env.CHAT_DATA_DIR || '.data', 'build'),
  )
  if (process.platform === 'linux') helpers.push(...Object.values(linuxPaths()))
  for (const root of roots) {
    if (
      trusted.some((path) => !isOutside(root, path)) ||
      helpers.some((path) => !isOutside(root, path) || !isOutside(path, root))
    )
      throw new Error(
        'A sandbox workspace overlaps the installation or private temporary directory',
      )
  }
  // A cwd below an existing grant must never reopen a protected child.
  return roots.filter(
    (root) => !roots.some((other) => other !== root && !isOutside(other, root)),
  )
}

async function filesystemPolicy(
  roots: string[],
  runtime: string,
  scratch: string,
) {
  const emptyRepo = join(dirname(scratch), 'empty.git')
  await execute('/usr/bin/git', ['init', '--bare', '--quiet', emptyRepo])
  const snapshots = await Promise.all(
    roots.map((root) => snapshotGitPaths(root, emptyRepo)),
  )
  const hidden = snapshots.flatMap((snapshot) => snapshot.hidden)
  // Pin rules in ancestors of protected entries, even where no nested rule exists at launch.
  const rules = new Set<string>()
  for (const entry of hidden) {
    for (
      let parent = dirname(entry);
      roots.some((root) => !isOutside(root, parent));
      parent = dirname(parent)
    ) {
      rules.add(join(parent, '.gitignore'))
    }
  }
  return {
    readConfig: {
      denyOnly: [],
      literalDenyOnly: ['/', ...hidden],
      literalAllowWithinDeny: [...runtimeReadPaths(runtime), scratch, ...roots],
    },
    writeConfig: {
      allowOnly: [],
      literalAllowOnly: ['/dev/null', scratch, ...roots],
      denyWithinAllow:
        process.platform === 'darwin'
          ? ['**/.gitignore', '**/.git', '**/node_modules', '**/.venv']
          : [],
      literalDenyWithinAllow: [
        ...hidden,
        ...rules,
        ...snapshots.flatMap((snapshot) => snapshot.readOnly),
      ],
    },
  }
}

/** Prepare one invocation with independent filesystem and network policy. */
export async function preparePreview(
  input: StartShellJobInput,
  roots: string[],
  access?: ShellRetryAccess,
) {
  if (!previewAvailable())
    throw new Error('Shell sandbox preview is unavailable')
  const runtime = await realpath(
    (process.versions.bun && process.env.NODE_BINARY) || process.execPath,
  )
  if (
    process.platform === 'linux' &&
    process.versions.bun &&
    !process.env.NODE_BINARY
  )
    throw new Error(
      'The Linux sandbox worker requires the packaged Node runtime',
    )
  const writable = await writableRoots(roots, runtime)
  const shell = input.shell || '/bin/bash'
  if (
    !['/bin/sh', '/bin/bash', '/bin/zsh', 'bash', 'zsh', 'sh'].includes(shell)
  )
    throw new Error('The sandbox preview requires a system shell')
  const binShell = shell.startsWith('/') ? shell : '/bin/' + shell
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'corvori-shell-')),
  )
  const cleanup = () => rm(temporary, { recursive: true, force: true })
  try {
    const scratch = join(temporary, 'tmp')
    await mkdir(scratch)
    const env = {
      ...input.environment,
      HOME: scratch,
      TMPDIR: scratch,
      TERM: 'xterm-256color',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:' + dirname(runtime),
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    }
    const command = input.boundSessionDir
      ? withBoundSessionDir(input.command, input.boundSessionDir)
      : input.command
    if (access === 'both')
      return {
        prepared: { file: binShell, args: ['-c', command], env },
        cleanup,
      }
    const policy = {
      // Override the library's default TMPDIR inside the sandbox.
      command: 'export TMPDIR="$HOME"\n' + command,
      commandId: randomUUID(),
      binShell,
      needsNetworkRestriction: access !== 'network',
      ...(access !== 'filesystem' &&
        (await filesystemPolicy(writable, runtime, scratch))),
    }
    return {
      prepared: await wrapPreview(policy, temporary, runtime, env),
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
