import { MAX_APPROVAL_PATTERNS } from '@cv/core/limits'
import { stableStringify } from '@cv/core/stable-json'
import {
  foldPaths,
  taskApprovalPathsError,
} from '@cv/core/workspace/path-policy'

import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import { type AuthMutationCtx, requireRole } from '../../functions'
import type {
  ScheduledTaskDefinition,
  TaskApprovals,
} from '../../validators/scheduledTasks'
import { requireFolder, workspaceKey } from '../session/folderContext'

export async function requireTaskWorkspace(
  ctx: QueryCtx,
  ownerId: Id<'users'>,
  folderId?: Id<'sessionFolders'>,
) {
  if (!folderId) return
  const { workspace } = await requireFolder(ctx, folderId, ownerId)
  if (!workspace) error('Choose a folder with a project workspace.')
  return workspace
}

function normalizeApprovals(
  value: TaskApprovals | undefined,
  hasWorkspace: boolean,
) {
  if (!value || (!value.shell.length && !value.paths.length)) return
  const shell = [...new Set(value.shell.map((entry) => entry.trim()))]
  const paths = value.paths.map((path) => path.trim())
  if (shell.length > MAX_APPROVAL_PATTERNS) {
    error(`Enter at most ${MAX_APPROVAL_PATTERNS} shell command prefixes.`)
  }
  if (shell.some((entry) => !entry || /\p{Cc}/u.test(entry))) {
    error('Enter non-empty shell command prefixes without control characters.')
  }
  const issue = taskApprovalPathsError(paths, hasWorkspace)
  if (issue) error(issue)
  return { shell: shell.sort(), paths: foldPaths(paths).sort() }
}

export async function saveApprovalPolicy(
  ctx: AuthMutationCtx,
  definition: ScheduledTaskDefinition,
  task: Doc<'scheduledTasks'> | null,
  reviewedWorkspaceKey?: string,
) {
  const { folderId, agentId } = definition
  const workspace = await requireTaskWorkspace(ctx, ctx.userId, folderId)
  const approvals = normalizeApprovals(definition.approvals, !!workspace)
  const approvalWorkspaceKey = approvals ? workspaceKey(workspace) : undefined
  if (approvals) {
    requireRole(ctx.role, 'admin')
    if (workspace && reviewedWorkspaceKey !== approvalWorkspaceKey) {
      error('Review the automatic approvals for the current workspace.')
    }
  }

  const version = task?.approvalRevision
  const changed =
    (approvals || task?.approvals) &&
    (stableStringify(task?.approvals ?? null) !==
      stableStringify(approvals ?? null) ||
      task?.agentId !== agentId ||
      task?.folderId !== folderId ||
      task?.approvalWorkspaceKey !== approvalWorkspaceKey)
  return {
    approvals,
    approvalWorkspaceKey,
    approvalRevision: changed ? (version ?? 0) + 1 : version,
  }
}
