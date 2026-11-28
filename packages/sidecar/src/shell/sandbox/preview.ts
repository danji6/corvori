import type { ShellRetryAccess } from '@cv/core/shell/retry'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, win32 } from 'node:path'
import { promisify } from 'node:util'

import { isOutside } from '../../mcp/workspace/access'
import type { StartShellJobInput } from '../job-protocol'
import { type PreparedShell, shellWord } from '../launch'
import { shellInvocation, withBoundSessionDir } from '../system-shell'
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
import { windowsRequest } from './windows-request'

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
  const { git: executable } = await systemTools()
  await execute(executable, ['init', '--bare', '--quiet', emptyRepo])
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
      literalDenyOnly: process.platform === 'win32' ? hidden : ['/', ...hidden],
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
      literalAllowOnly: [
        ...(process.platform === 'win32' ? [] : ['/dev/null']),
        scratch,
        ...(readOnly ? [] : roots),
      ],
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

function runtimeEnvironment(runtime: string, path: string, scratch: string) {
  if (process.platform !== 'win32')
    return { PATH: path + ':/usr/sbin:/sbin:' + dirname(runtime) }
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('Missing Windows system directory')
  return {
    PATH: [dirname(runtime), path, join(systemRoot, 'System32')].join(
      delimiter,
    ),
    SystemRoot: systemRoot,
    windir: systemRoot,
    SystemDrive: win32.parse(systemRoot).root.slice(0, -1),
    LOCALAPPDATA: scratch,
    APPDATA: scratch,
    ComSpec: join(systemRoot, 'System32/cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: scratch,
    TEMP: scratch,
    TMP: scratch,
  }
}

/** Prepare a sandboxed job or a single authorized replay with its selected access. */
export async function preparePreview(
  input: StartShellJobInput,
  roots: string[],
  access?: ShellRetryAccess,
  directArgv?: string[],
): Promise<{
  prepared: PreparedShell
  tag?: string
  cleanup: () => Promise<void>
}> {
  const outside = access === 'both'
  if (!outside && !previewAvailable())
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
  const authorizedRoots = [...new Set([...roots, ...grants])]
  const writable = outside
    ? authorizedRoots
    : await sandboxRoots(authorizedRoots)
  const windows = process.platform === 'win32'
  const shell = input.shell || '/bin/bash'
  if (
    !windows &&
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
    const github = input.githubQuery
      ? await githubInvocation(input.command, writable)
      : undefined
    const env = {
      ...(github && (await githubEnvironment(github.file, scratch, writable))),
      ...input.environment,
      HOME: scratch,
      TMPDIR: scratch,
      TERM: 'xterm-256color',
      ...runtimeEnvironment(runtime, tools.path, scratch),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    }
    const original = input.boundSessionDir
      ? withBoundSessionDir(input.command, input.boundSessionDir)
      : input.command
    if (outside) {
      const invocation = github
        ? { file: github.file, args: github.args }
        : windows
          ? shellInvocation(original, input.shell)
          : { file: binShell, args: ['-c', original] }
      return { prepared: { ...invocation, env }, cleanup }
    }
    const git = await prepareGitQuery(
      input.command,
      input.cwd,
      writable,
      temporary,
      tools.git,
    )
    const permissions = await filesystemPolicy(
      writable,
      runtime,
      scratch,
      !!input.readOnlyWorkspace || !!git,
      [...tools.reads, ...(github ? [github.file] : [])],
      grants,
      git,
    )
    if (windows) {
      const prepared = await windowsRequest({
        roots: writable,
        runtime,
        env,
        temporary,
        cwd: input.cwd,
        shell: input.shell,
        command: original,
        argv:
          git?.argv ?? (github && [github.file, ...github.args]) ?? directArgv,
        hidden: permissions.readConfig.literalDenyOnly,
        readonly: [
          ...permissions.readConfig.literalAllowWithinDeny,
          ...permissions.writeConfig.literalDenyWithinAllow,
        ],
        writable: permissions.writeConfig.literalAllowOnly,
        online: !!github || access === 'network',
      })
      return { prepared, cleanup }
    }
    const command =
      git?.command ??
      (github
        ? 'exec ' + [github.file, ...github.args].map(shellWord).join(' ')
        : original)
    const policy = {
      // Override the library's default TMPDIR inside the sandbox.
      command: 'export TMPDIR="$HOME"\n' + command,
      commandId: randomUUID(),
      binShell,
      needsNetworkRestriction: !github && access !== 'network',
      ...permissions,
    }
    const prepared = await wrapPreview(policy, temporary, runtime, env)
    const tag =
      process.platform === 'darwin'
        ? prepared.args
            .at(-1)
            ?.match(/; LogTag: (CMD64_[\w+/=]+_END_\w+_SBX)/)?.[1]
        : undefined
    const trustedTag = tag?.startsWith(
      'CMD64_' + Buffer.from(policy.commandId).toString('base64') + '_END_',
    )
      ? tag
      : undefined
    return {
      tag: trustedTag,
      prepared,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
