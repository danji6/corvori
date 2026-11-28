import { shellLabel } from '@cv/core/shell/name'
import {
  SHELL_PAGE_CHARS,
  SHELL_TERM_TAIL_CHARS,
} from '@cv/core/shell/output-page'
import { shellRetryAccess } from '@cv/core/shell/retry'
import type { Context, Handler } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ZodError, z } from 'zod'

import { withAgentFiles } from '../agent-files/access'
import { workspaceRoots } from '../checkpoints/group'
import { checkpoints } from '../checkpoints/manager'
import { resolvePathGrants } from '../mcp/workspace/access'
import {
  withWorkspaceOperation,
  workspaceContextSchema,
} from '../mcp/workspace/context'
import { resolveShellDirectory } from './directory'
import {
  type ShellJobStream,
  backgroundShellJob,
  checkShellRetry,
  killSessionShellJobs,
  killShellJob,
  listShellJobs,
  pollShellJob,
  resizeShellJob,
  shellJobPid,
  startShellJob,
  subscribeShellJob,
  writeStdin,
} from './registry'
import { previewAvailable } from './sandbox/preview-platform'
import { sandboxReady } from './sandbox/readiness'
import { pumpShellJobStream } from './stream'
import { canBindSessionDir, shellPath } from './system-shell'

const jobFields = {
  sessionId: z.string(),
  jobId: z.string(),
}

const startSchema = z.strictObject({
  sessionId: z.string(),
  owner: z.string().optional(),
  messageId: z.string().optional(),
  messageCreatedAt: z.number().optional(),
  toolCallId: z.string().optional(),
  workspaceId: z.string(),
  workspace: workspaceContextSchema,
  command: z.string().min(1),
  sandbox: z.literal(true).optional(),
  scopedGrants: z.literal(true).optional(),
  githubQuery: z.literal(true).optional(),
  readOnlyWorkspace: z.literal(true).optional(),
  retry: z
    .strictObject({
      jobId: z.string().min(1),
      access: z.enum(shellRetryAccess),
    })
    .optional(),
  bindSessionDir: z.literal(true).optional(),
  cwd: z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
  background: z.boolean().optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(300).optional(),
  shell: z.string().optional(),
  allowInteractiveShells: z.boolean().optional(),
})

const pollSchema = z.object({
  ...jobFields,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().max(SHELL_PAGE_CHARS).optional(),
  tailChars: z
    .number()
    .int()
    .nonnegative()
    .max(SHELL_TERM_TAIL_CHARS)
    .optional(),
})

const streamSchema = z.object({
  ...jobFields,
  offset: z.coerce.number().min(0).default(0),
  // Ends the SSE response once this many payload bytes have been sent
  maxBytes: z.coerce.number().min(0).optional(),
})

const stdinSchema = z.object({
  ...jobFields,
  data: z.string(),
})

const killSchema = z.object(jobFields)

const resizeSchema = z.object({
  ...jobFields,
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(300),
})

const sessionSchema = z.object({ sessionId: z.string() })

const killSessionSchema = z.object({
  sessionId: z.string(),
  owner: z.string().optional(),
  includeBackground: z.boolean().optional(),
})

/** What an unconfigured shell resolves to on this host. */
export const shellInfo: Handler = async (c) => {
  try {
    const shell = shellPath()
    return c.json({
      shell,
      label: shellLabel(shell),
      sandbox: {
        version: 2,
        retryPreview: await sandboxReady(),
        automaticShellExecution: await sandboxReady(),
      },
    })
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

type StartRequest = z.infer<typeof startSchema>

async function resolveLaunch(input: StartRequest, scopedGrants: boolean) {
  const directory = await resolveShellDirectory(input)
  const roots = [
    ...new Set([
      ...(await workspaceRoots(input.sessionId, input.workspace)),
      ...directory.roots,
      directory.cwd,
    ]),
  ]
  const grants = scopedGrants
    ? await resolvePathGrants(directory.grantRoot, input.allowedPaths ?? [])
    : []
  const launch = {
    grantedPaths: grants.map((grant) => grant.absolutePath),
    ...input,
    agentId: input.workspace.agentHome?.agentId,
    homeId: input.workspace.agentHome?.homeId,
    revision: input.workspace.revision,
    authority: JSON.stringify([
      input.workspace.folderId,
      input.workspace.agentHome?.revision,
      [...roots].sort(),
      [...(input.allowedPaths ?? [])]
        .filter((path) => path !== directory.cwd)
        .sort(),
      input.allowInteractiveShells ?? false,
      directory.environment,
    ]),
    cwd: directory.cwd,
    environment: directory.environment,
    boundSessionDir:
      input.bindSessionDir && canBindSessionDir(input.shell)
        ? directory.environment.SESSION_DIR
        : undefined,
  }
  return { launch, roots }
}

async function shellLaunch(
  c: Context,
  inspect: boolean,
  requireSandbox = false,
) {
  try {
    const input = startSchema.parse(await c.req.json())
    if (requireSandbox && !input.sandbox)
      throw new Error('A sandbox policy is required')
    const result = await withAgentFiles(
      input.workspace.agentHome?.homeId ?? input.workspace.agentHome?.agentId,
      () =>
        withWorkspaceOperation(input.sessionId, async () => {
          const { launch, roots } = await resolveLaunch(
            input,
            requireSandbox || (inspect && input.scopedGrants === true),
          )
          if (inspect) {
            if (!previewAvailable())
              throw new Error('Shell sandbox preview is unavailable')
            if (input.cwd !== launch.cwd)
              throw new Error(
                'Use the absolute working directory of the failed job',
              )
            checkShellRetry(launch).request(launch)
            return { cwd: launch.cwd }
          }
          return checkpoints().write(input.sessionId, roots, async (writer) => {
            const started = await startShellJob(launch, roots)
            try {
              await writer.trackJob(shellJobPid(started.jobId, input.sessionId))
            } catch (error) {
              killShellJob(started.jobId, input.sessionId)
              throw error
            }
            return started
          })
        }),
    )
    return c.json(result)
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

export const startShell: Handler = (c) => shellLaunch(c, false)
export const startSandboxShell: Handler = async (c) => {
  if (!(await sandboxReady()))
    return c.json(
      {
        error:
          'Shell sandbox unavailable. Request the command again for approval.',
      },
      409,
    )
  return shellLaunch(c, false, true)
}
export const inspectShellRetry: Handler = (c) => shellLaunch(c, true)

export const pollShell: Handler = async (c) => {
  try {
    const input = pollSchema.parse(await c.req.json())
    return c.json(
      pollShellJob(input.jobId, input.sessionId, input.offset, input),
    )
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

export const streamShell: Handler = (c) => {
  let stream: ShellJobStream
  let maxBytes: number | undefined
  try {
    const parsed = streamSchema.parse({
      sessionId: c.req.query('sessionId'),
      jobId: c.req.query('jobId'),
      offset: c.req.query('offset'),
      maxBytes: c.req.query('maxBytes'),
    })
    maxBytes = parsed.maxBytes
    stream = subscribeShellJob(parsed.jobId, parsed.sessionId, parsed.offset)
  } catch (err: unknown) {
    return jobError(c, err)
  }
  return streamSSE(c, (sse) => pumpShellJobStream(sse, stream, maxBytes))
}

export const shellStdin: Handler = async (c) => {
  try {
    const input = stdinSchema.parse(await c.req.json())
    writeStdin(input.jobId, input.sessionId, input.data)
    return c.json({ ok: true })
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

export const killShell: Handler = async (c) => {
  try {
    const input = killSchema.parse(await c.req.json())
    killShellJob(input.jobId, input.sessionId)
    return c.json({ ok: true })
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

export const backgroundShell: Handler = async (c) => {
  try {
    const input = killSchema.parse(await c.req.json())
    backgroundShellJob(input.jobId, input.sessionId)
    return c.json({ ok: true })
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

export const resizeShell: Handler = async (c) => {
  try {
    const input = resizeSchema.parse(await c.req.json())
    resizeShellJob(input.jobId, input.sessionId, input.cols, input.rows)
    return c.json({ ok: true })
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

export const listShell: Handler = async (c) => {
  try {
    const input = sessionSchema.parse(await c.req.json())
    return c.json({ jobs: listShellJobs(input.sessionId) })
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

export const killSessionShell: Handler = async (c) => {
  try {
    const input = killSessionSchema.parse(await c.req.json())
    const killed = killSessionShellJobs(
      input.sessionId,
      input.includeBackground ?? false,
      input.owner,
    )
    return c.json({ killed })
  } catch (err: unknown) {
    return jobError(c, err)
  }
}

function jobError(c: Context, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  const status =
    err instanceof ZodError ? 400 : message.includes('not found') ? 404 : 500
  return c.json({ error: message }, status)
}
