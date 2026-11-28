import type { ShellRetryAccess } from '@cv/core/shell/retry'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { isOutside } from '../../mcp/workspace/access'
import type { StartShellJobInput } from '../job-protocol'
import { shellWord } from '../launch'
import { withBoundSessionDir } from '../system-shell'
import { prepareGitQuery } from './git'
import { githubEnvironment, githubInvocation } from './github'
import { snapshotGitPaths } from './ignore-snapshot'
import {
  previewAvailable,
  runtimeReadPaths,
  wrapPreview,
} from './preview-platform'
import { sandboxRoots } from './roots'
import { systemTools } from './system-tools'

const execute = promisify(execFile)

async function filesystemPolicy(
  roots: string[],
  runtime: string,
  scratch: string,
  readOnly: boolean,
  binaries: string[],
  grants: string[],
  git?: Awaited<ReturnType<typeof prepareGitQuery>>,
) {
  const emptyRepo = join(dirname(scratch), 'empty.git')
  await execute('/usr/bin/git', ['init', '--bare', '--quiet', emptyRepo])
  const directories = await Promise.all(
    roots.map(async (root) =>
      (await stat(root)).isDirectory() ? root : undefined,
    ),
  )
  const snapshots = await Promise.all(
    directories
      .filter((root): root is string => !!root)
      .map((root) => snapshotGitPaths(root, emptyRepo)),
  )
  const metadata = new Set(snapshots.flatMap((snapshot) => snapshot.metadata))
  if (git && git.metadata.some((path) => !metadata.has(path)))
    throw new Error('Git metadata is outside the selected workspace authority')
  const granted = (path: string) =>
    grants.some((grant) => !isOutside(grant, path))
  const hidden = snapshots
    .flatMap((snapshot) => snapshot.hidden)
    .filter(
      (path) =>
        !git?.metadata.includes(path) && (metadata.has(path) || !granted(path)),
    )
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
      literalAllowWithinDeny: [
        ...runtimeReadPaths(runtime),
        ...binaries,
        ...(git ? [git.view, ...git.metadata] : []),
        scratch,
        ...roots,
      ],
    },
    writeConfig: {
      allowOnly: [],
      literalAllowOnly: ['/dev/null', scratch, ...(readOnly ? [] : roots)],
      denyWithinAllow:
        process.platform === 'darwin'
          ? ['**/.gitignore', '**/.git', '**/node_modules', '**/.venv']
          : [],
      literalDenyWithinAllow: [
        ...hidden,
        ...rules,
        ...snapshots
          .flatMap((snapshot) => snapshot.readOnly)
          .filter((path) => basename(path) === '.gitignore' || !granted(path)),
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
  const grants = input.grantedPaths ?? []
  const writable = await sandboxRoots([...new Set([...roots, ...grants])])
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
    const tools = await systemTools()
    const git = await prepareGitQuery(
      input.command,
      input.cwd,
      writable,
      temporary,
      tools.git,
    )
    const github = input.githubQuery
      ? await githubInvocation(input.command, writable)
      : undefined
    const env = {
      ...(github && (await githubEnvironment(github.file, scratch, writable))),
      ...input.environment,
      HOME: scratch,
      TMPDIR: scratch,
      TERM: 'xterm-256color',
      PATH: tools.path + ':/usr/sbin:/sbin:' + dirname(runtime),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    }
    const command =
      git?.command ??
      (github
        ? 'exec ' + [github.file, ...github.args].map(shellWord).join(' ')
        : input.boundSessionDir
          ? withBoundSessionDir(input.command, input.boundSessionDir)
          : input.command)
    if (access === 'both' || (github && access === 'filesystem'))
      return {
        prepared: { file: binShell, args: ['-c', command], env },
        cleanup,
      }
    const policy = {
      // Override the library's default TMPDIR inside the sandbox.
      command: 'export TMPDIR="$HOME"\n' + command,
      commandId: randomUUID(),
      binShell,
      needsNetworkRestriction: !github && access !== 'network',
      ...(access !== 'filesystem' &&
        (await filesystemPolicy(
          writable,
          runtime,
          scratch,
          !!input.readOnlyWorkspace || !!git,
          [...tools.reads, ...(github ? [github.file] : [])],
          grants,
          git,
        ))),
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
