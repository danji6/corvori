import { directGitHubQuery } from '@cv/core/shell/direct-command'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

import { isOutside } from '../../mcp/workspace/access'

const execute = promisify(execFile)

/** Resolve only a host-installed CLI, independently of the job's cwd and PATH. */
export async function githubInvocation(command: string, roots: string[]) {
  const words = directGitHubQuery(command)
  if (!words) throw new Error('This command cannot use the GitHub CLI grant')
  const configured = process.env.CORVORI_GH_BINARY
  const candidates = configured
    ? [configured]
    : ['/usr/bin/gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
  for (const path of candidates) {
    if (!isAbsolute(path))
      throw new Error('Configure an absolute GitHub CLI path')
    const file = await realpath(path).catch(() => undefined)
    if (!file) continue
    if (roots.some((root) => !isOutside(root, file) || !isOutside(root, path)))
      throw new Error('The granted GitHub CLI must be outside the workspace')
    return { file, args: words.slice(1) }
  }
  throw new Error('Install the GitHub CLI to use the saved gh grant')
}

/** Resolve the github.com credential without exposing the personal config directory to the job. */
export async function githubEnvironment(
  file: string,
  scratch: string,
  roots: string[],
) {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    const config = resolve(
      process.env.GH_CONFIG_DIR ||
        resolve(
          process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'),
          'gh',
        ),
    )
    const trusted = await realpath(config).catch(() => undefined)
    if (trusted && roots.every((root) => isOutside(root, trusted))) {
      const result = await execute(
        file,
        ['auth', 'token', '--hostname', 'github.com'],
        {
          cwd: scratch,
          env: {
            HOME: homedir(),
            PATH: '/usr/bin:/bin',
            GH_CONFIG_DIR: trusted,
            GH_PROMPT_DISABLED: '1',
          },
          timeout: 5000,
        },
      ).catch(() => undefined)
      token = result?.stdout.trim()
    }
  }
  return {
    GH_TOKEN: token,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_TELEMETRY: '0',
    GH_PAGER: 'cat',
    GH_BROWSER: '/usr/bin/false',
  }
}
