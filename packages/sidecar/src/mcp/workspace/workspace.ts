import type { FolderWorkspace } from '@cv/core/types/workspace'
import {
  applyEdits,
  createUnifiedDiff,
  detectLineEnding,
  isUnchangedWrite,
  normalizeToLf,
  restoreLineEndings,
  stripBom,
} from '@cv/core/workspace/edit'
import { assertPersonalScope } from '@cv/core/workspace/personal'
import type { FileImageOutput } from '@cv/core/workspace/read-image'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { workspaceRoots } from '../../checkpoints/group'
import { checkpoints } from '../../checkpoints/manager'
import { readImagePreview } from '../../files/read-image'
import { readOptionalEditSnapshot } from '../../files/read-snapshot'
import { readTextPage } from '../../files/read-text'
import { resolveShellDirectory } from '../../shell/directory'
import { prepareAuxiliaryShell } from '../../shell/sandbox/auxiliary'
import { assertCheckpointTarget, resolveToolPath } from './access'
import { runCommand } from './command'
import { withFilesystemOperation, workspaceContextSchema } from './context'
import { resolveFileToolPath, selectFileToolScope } from './file-path'
import { requireWorkspace } from './resolve-workspace'
import { checkScopedPaths } from './scoped-checks'

export { requireWorkspace } from './resolve-workspace'

export const previewDiffSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  workspace: workspaceContextSchema,
  filePath: z.string(),
  allowedPaths: z.array(z.string()).optional(),
  content: z.string().optional(),
  edits: z
    .array(z.object({ oldText: z.string(), newText: z.string() }))
    .optional(),
})

type WorkspaceRead =
  | ({ path: string } & Awaited<ReturnType<typeof readTextPage>>)
  | (FileImageOutput & { content?: never })

async function readWorkspaceFileImpl(input: {
  sessionId: string
  workspaceId: string
  workspace?: FolderWorkspace
  filePath: string
  allowedPaths?: string[]
  allowOutsideWorkspace?: boolean
  offset?: number
  limit?: number
  byteOffset?: number
}): Promise<WorkspaceRead> {
  const workspace = await requireWorkspace(
    input.sessionId,
    input.workspaceId,
    input.workspace,
  )
  const target = await resolveExistingFile(
    workspace.root,
    input.filePath,
    input.allowedPaths,
    workspace.roots,
    workspace.grantRoot,
    input.allowOutsideWorkspace,
  )
  assertPersonalScope(input.workspace, target.absolutePath)

  const image = await readImagePreview(target.absolutePath, input)
  if (image) return { path: target.relativePath, ...image }

  return {
    path: target.relativePath,
    ...(await readTextPage(target.absolutePath, input)),
  }
}

async function writeWorkspaceFileImpl(input: {
  sessionId: string
  workspaceId: string
  workspace?: FolderWorkspace
  filePath: string
  allowedPaths?: string[]
  allowOutsideWorkspace?: boolean
  content: string
}) {
  const workspace = await requireWorkspace(
    input.sessionId,
    input.workspaceId,
    input.workspace,
  )
  const target = await resolveWritablePath(
    workspace.root,
    input.filePath,
    input.allowedPaths,
    workspace.roots,
    workspace.grantRoot,
    input.allowOutsideWorkspace,
  )

  return checkpoints().write(
    input.sessionId,
    [target.absolutePath],
    async (writer) => {
      assertPersonalScope(input.workspace, target.absolutePath)
      await assertCheckpointTarget(
        workspace.root,
        target.absolutePath,
        target.external,
      )
      await writer.trackFile(target.absolutePath, input.workspace)
      const previousContent = await readOptionalEditSnapshot(
        target.absolutePath,
      )

      // Reject empty diffs
      if (
        previousContent !== undefined &&
        isUnchangedWrite(previousContent, input.content)
      ) {
        throw new Error(
          `No changes made to ${target.relativePath}. The file already contains this content.`,
        )
      }

      await assertCheckpointTarget(
        workspace.root,
        target.absolutePath,
        target.external,
      )
      await mkdir(path.dirname(target.absolutePath), { recursive: true })
      await writeFile(target.absolutePath, input.content, 'utf-8')

      return {
        path: target.relativePath,
        bytes: Buffer.byteLength(input.content),
        diff: capDiff(
          createUnifiedDiff(
            target.relativePath,
            normalizeToLf(stripBom(previousContent ?? '').text),
            normalizeToLf(stripBom(input.content).text),
          ),
        ),
      }
    },
  )
}

async function editWorkspaceFileImpl(input: {
  sessionId: string
  workspaceId: string
  workspace?: FolderWorkspace
  filePath: string
  allowedPaths?: string[]
  allowOutsideWorkspace?: boolean
  edits: Array<{ oldText: string; newText: string }>
}) {
  const workspace = await requireWorkspace(
    input.sessionId,
    input.workspaceId,
    input.workspace,
  )
  const target = await resolveExistingFile(
    workspace.root,
    input.filePath,
    input.allowedPaths,
    workspace.roots,
    workspace.grantRoot,
    input.allowOutsideWorkspace,
  )

  return checkpoints().write(
    input.sessionId,
    [target.absolutePath],
    async (writer) => {
      assertPersonalScope(input.workspace, target.absolutePath)
      await assertCheckpointTarget(
        workspace.root,
        target.absolutePath,
        target.external,
      )
      await writer.trackFile(target.absolutePath, input.workspace)
      const previousContent = await readOptionalEditSnapshot(
        target.absolutePath,
      )
      const { bom, text } = stripBom(previousContent ?? '')
      const ending = detectLineEnding(text)
      const baseContent = normalizeToLf(text)
      const newContent = applyEdits(
        baseContent,
        input.edits,
        target.relativePath,
      )

      await assertCheckpointTarget(
        workspace.root,
        target.absolutePath,
        target.external,
      )
      await writeFile(
        target.absolutePath,
        bom + restoreLineEndings(newContent, ending),
        'utf-8',
      )

      return {
        path: target.relativePath,
        edits: input.edits.length,
        diff: capDiff(
          createUnifiedDiff(target.relativePath, baseContent, newContent),
        ),
      }
    },
  )
}

/** Simulate a unified diff for the given input. */
async function previewWorkspaceDiffImpl(
  input: z.infer<typeof previewDiffSchema>,
): Promise<{ diff: string; path?: string }> {
  const workspace = await requireWorkspace(
    input.sessionId,
    input.workspaceId,
    input.workspace,
  )

  try {
    if (input.edits?.length) {
      const target = await resolveExistingFile(
        workspace.root,
        input.filePath,
        input.allowedPaths,
        workspace.roots,
        workspace.grantRoot,
      )
      assertPersonalScope(input.workspace, target.absolutePath)
      const previousContent = await readOptionalEditSnapshot(
        target.absolutePath,
      )
      const baseContent = normalizeToLf(stripBom(previousContent ?? '').text)
      const newContent = applyEdits(
        baseContent,
        input.edits,
        target.relativePath,
      )

      return {
        path: target.relativePath,
        diff: capDiff(
          createUnifiedDiff(target.relativePath, baseContent, newContent),
        ),
      }
    }

    if (input.content !== undefined) {
      const target = await resolveWritablePath(
        workspace.root,
        input.filePath,
        input.allowedPaths,
        workspace.roots,
        workspace.grantRoot,
      )
      assertPersonalScope(input.workspace, target.absolutePath)
      const previousContent = await readOptionalEditSnapshot(
        target.absolutePath,
      )
      const baseContent = normalizeToLf(stripBom(previousContent ?? '').text)
      const newContent = normalizeToLf(stripBom(input.content).text)

      return {
        path: target.relativePath,
        diff: capDiff(
          createUnifiedDiff(target.relativePath, baseContent, newContent),
        ),
      }
    }
  } catch {
    // No-op, client will use a fallback
  }

  return { diff: '' }
}

async function runWorkspaceCommandImpl(input: {
  sessionId: string
  workspaceId: string
  workspace?: FolderWorkspace
  command: string
  cwd?: string
  allowedPaths?: string[]
  timeout?: number
  signal?: AbortSignal
}) {
  const directory = await resolveShellDirectory(input)
  const roots = input.workspace
    ? await workspaceRoots(input.sessionId, input.workspace)
    : directory.roots
  return checkpoints().write(
    input.sessionId,
    [...roots, directory.cwd],
    async () => {
      const job = await prepareAuxiliaryShell(
        { ...input, cwd: directory.cwd, environment: directory.environment },
        roots,
      )
      try {
        return await runCommand(
          input.command,
          directory.cwd,
          input.timeout ?? 30,
          input.signal,
          directory.environment,
          job?.prepared,
        )
      } finally {
        await job?.cleanup()
      }
    },
  )
}

export async function resolveExistingFile(
  root: string,
  filePath: string,
  allowedPaths?: string[],
  roots?: string[],
  grantRoot?: string,
  allowOutsideWorkspace = false,
) {
  const target = await resolveFileToolPath(
    root,
    filePath,
    allowedPaths,
    roots,
    grantRoot,
    allowOutsideWorkspace,
  )
  const fileStat = await stat(target.absolutePath)
  if (!fileStat.isFile()) throw new Error('Path is not a file')
  return target
}

/** Browsing and mentions remain confined to the workspace. */
export async function resolveExistingPath(
  root: string,
  filePath: string,
  roots?: string[],
) {
  const target = await resolveToolPath(root, filePath, [], roots)
  const pathStat = await stat(target.absolutePath)
  return {
    ...target,
    isDirectory: pathStat.isDirectory(),
    isFile: pathStat.isFile(),
  }
}

async function resolveWritablePath(
  root: string,
  filePath: string,
  allowedPaths?: string[],
  roots?: string[],
  grantRoot?: string,
  allowOutsideWorkspace = false,
) {
  return resolveFileToolPath(
    root,
    filePath,
    allowedPaths,
    roots,
    grantRoot,
    allowOutsideWorkspace,
  )
}

const MAX_DIFF_BYTES = 50_000

function capDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_BYTES) return diff
  return `${diff.slice(0, MAX_DIFF_BYTES)}\n[diff truncated]`
}

export function readWorkspaceFile(
  input: Parameters<typeof readWorkspaceFileImpl>[0],
) {
  return withFilesystemOperation(input, () =>
    readWorkspaceFileImpl(selectFileToolScope(input)),
  )
}

export function writeWorkspaceFile(
  input: Parameters<typeof writeWorkspaceFileImpl>[0],
) {
  return withFilesystemOperation(input, () =>
    writeWorkspaceFileImpl(selectFileToolScope(input)),
  )
}

export function editWorkspaceFile(
  input: Parameters<typeof editWorkspaceFileImpl>[0],
) {
  return withFilesystemOperation(input, () =>
    editWorkspaceFileImpl(selectFileToolScope(input)),
  )
}

export function previewWorkspaceDiff(
  input: Parameters<typeof previewWorkspaceDiffImpl>[0],
) {
  return withFilesystemOperation(input, () =>
    previewWorkspaceDiffImpl(selectFileToolScope(input)),
  )
}

export function runWorkspaceCommand(
  input: Parameters<typeof runWorkspaceCommandImpl>[0],
) {
  return withFilesystemOperation(input, () => runWorkspaceCommandImpl(input))
}

export function checkFlaggedPaths(
  input: Parameters<typeof checkScopedPaths>[0],
) {
  return withFilesystemOperation(input, () => checkScopedPaths(input))
}
