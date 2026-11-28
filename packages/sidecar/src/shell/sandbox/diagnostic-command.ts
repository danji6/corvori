import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { execFile } from 'node:child_process'
import { text } from 'node:stream/consumers'
import { promisify } from 'node:util'

const execute = promisify(execFile)
type ProbeInvocation = {
  command: string
  commandId: string
  cwd: string
  shell: string
  filesystem: SandboxRuntimeConfig['filesystem']
}

/** Prepare a bounded diagnostic invocation using the selected backend's native transport. */
export async function prepareProbeCommand(input: ProbeInvocation) {
  const { command, commandId, cwd, shell, filesystem } = input
  const backend = SandboxManager.getWindowsBackend?.()?.backend
  // srt-win grants are session ACLs. Its per-command API accepts additional denies only.
  const customConfig =
    backend === 'srt-win'
      ? {
          filesystem: {
            denyRead: filesystem.denyRead,
            denyWrite: filesystem.denyWrite,
            allowWrite: [],
          },
        }
      : { filesystem }
  const timeout = 30_000
  if (backend === 'mxc') {
    return async () => {
      const proc = await SandboxManager.spawnSandboxed!(command, {
        cwd,
        commandId,
        binShell: shell,
        customConfig,
        timeoutMs: timeout,
        env: { PATH: process.env.PATH || '' },
      })
      try {
        const [stdout, stderr, result] = await Promise.all([
          proc.stdout ? text(proc.stdout) : '',
          proc.stderr ? text(proc.stderr) : '',
          proc.wait(),
        ])
        if (result.timedOut) throw new Error('Native diagnostic timed out')
        return { stdout, stderr, status: result.exitCode }
      } finally {
        proc.dispose()
      }
    }
  }
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command,
    shell,
    customConfig,
    undefined,
    cwd,
    { commandId },
  )
  return async () => {
    try {
      const { stdout, stderr } = await execute(argv[0], argv.slice(1), {
        env,
        cwd,
        timeout,
        windowsHide: true,
      })
      return { stdout, stderr, status: 0 }
    } catch (error) {
      // The wrapper argv may contain transient proxy credentials.
      const failure = error as {
        code?: string | number
        stdout?: string
        stderr?: string
      }
      if (typeof failure.code !== 'number') {
        // eslint-disable-next-line preserve-caught-error -- execFile's error contains the proxy credentials in argv.
        throw new Error(
          `Native diagnostic failed to start or timed out (${failure.code ?? 'signal'})`,
        )
      }
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        status: failure.code,
      }
    }
  }
}
