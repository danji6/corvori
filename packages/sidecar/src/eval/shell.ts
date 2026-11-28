import type { EvaluationRequest } from '@cv/core/interpreter/request'
import {
  MAX_MESSAGE_PART_BYTES,
  MAX_PROMPT_CONTENT_CHARS,
} from '@cv/core/limits'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { z } from 'zod'

import { withAgentFiles } from '../agent-files/access'
import { workspaceRoots } from '../checkpoints/group'
import { checkpoints, finishCheckpointJob } from '../checkpoints/manager'
import { withWorkspaceOperation } from '../mcp/workspace/context'
import { resolveShellDirectory } from '../shell/directory'
import { shellWord, spawnShellPipes } from '../shell/launch'
import { prepareAuxiliaryShell } from '../shell/sandbox/auxiliary'
import { killProcessTree } from '../shell/system-shell'
import type { evaluationShellSchema } from './schemas'

export type EvaluationShell = z.infer<typeof evaluationShellSchema>

export async function runEvaluationShell(
  input: EvaluationShell,
  args: string[],
  signal: AbortSignal,
  kind: EvaluationRequest['kind'],
): Promise<string> {
  try {
    const home = input.workspace.agentHome
    return await withAgentFiles(home?.homeId ?? home?.agentId, () =>
      withWorkspaceOperation(input.sessionId, async () => {
        const directory = await resolveShellDirectory(input)
        const roots = [
          ...(await workspaceRoots(input.sessionId, input.workspace)),
          ...directory.roots,
          directory.cwd,
        ]
        const command = await checkpoints().write(
          input.sessionId,
          roots,
          async (writer) => {
            const command = await launch(
              input,
              directory,
              roots,
              args,
              kind,
              signal,
            )
            try {
              await writer.trackJob(command.pid)
              return command
            } catch (error) {
              command.kill()
              await command.output
              throw error
            }
          },
        )
        try {
          return await command.output
        } finally {
          await finishCheckpointJob(input.sessionId, command.pid)
        }
      }),
    )
  } catch {
    return 'Error: could not run shell command'
  }
}

type ShellDirectory = Awaited<ReturnType<typeof resolveShellDirectory>>

async function launch(
  input: EvaluationShell,
  directory: ShellDirectory,
  roots: string[],
  args: string[],
  kind: EvaluationRequest['kind'],
  signal: AbortSignal,
) {
  signal.throwIfAborted()

  const command =
    args.length === 1 ? args[0] : { file: args[0], args: args.slice(1) }
  const job = input.unrestricted
    ? undefined
    : await prepareAuxiliaryShell(
        {
          ...input,
          cwd: directory.cwd,
          environment: directory.environment,
          command:
            typeof command === 'string'
              ? command
              : 'exec ' + args.map(shellWord).join(' '),
        },
        roots,
      )
  const start = () =>
    spawnShellPipes(
      {
        prepared: job?.prepared,
        command,
        cwd: directory.cwd,
        environment: directory.environment,
        shell: input.shell,
      },
      'ignore',
    )

  let child: ChildProcess
  try {
    signal.throwIfAborted()
    child = start()
  } catch (error) {
    await job?.cleanup()
    throw error
  }
  const kill = () => killProcessTree(child.pid, () => child.kill())

  signal.addEventListener('abort', kill, { once: true })
  const output = collectOutput(child, kill, kind).finally(async () => {
    signal.removeEventListener('abort', kill)
    await job?.cleanup()
  })

  return { pid: child.pid, kill, output }
}

function collectOutput(
  child: ChildProcess,
  kill: () => void,
  kind: EvaluationRequest['kind'],
) {
  return new Promise<string>((resolve) => {
    let output = ''
    let size = 0
    const limit = kind === 'message' ? MAX_MESSAGE_PART_BYTES : MAX_PROMPT_CONTENT_CHARS // prettier-ignore
    let oversized = false
    let failed = false

    const append = (text: string) => {
      if (oversized) return
      size += kind === 'message' ? Buffer.byteLength(text) : text.length
      if (size <= limit) {
        output += text
        return
      }
      oversized = true
      output = ''
      kill()
    }

    for (const pipe of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8')
      pipe?.on('data', (chunk: Buffer) => append(decoder.write(chunk)))
      pipe?.on('end', () => append(decoder.end()))
    }

    child.once('error', () => {
      failed = true
    })
    child.once('close', (code, signal) => {
      if (oversized) {
        resolve('Error: shell output exceeds the prompt size limit')
      } else if (failed) {
        resolve('Error: could not launch shell command')
      } else if (code === 0) {
        resolve(output)
      } else {
        const status = signal
          ? `terminated by ${signal}`
          : `exited with status ${code}`
        resolve(
          `${output}${output && !output.endsWith('\n') ? '\n' : ''}Error: shell command ${status}`,
        )
      }
    })
  })
}
