import { ToolError } from '../../errors'
import type { WorkspaceToolContext } from './context'
import type { FilesystemCall } from './executionApprovals'

/** Rechecks automatic task authorization immediately before contacting the sidecar. */
export async function approvalsForFilesystemCall(
  context: WorkspaceToolContext,
  call: FilesystemCall,
  needsApproval: (current: WorkspaceToolContext) => Promise<boolean>,
) {
  if (!context.taskApprovals) return context.approvals?.()

  const before = await context.taskApprovals(call)
  if (before.manuallyApproved) return before.approvals

  const stillNeedsApproval = await needsApproval({
    ...context,
    approvals: async () => before.approvals,
  })
  const after = await context.taskApprovals()

  if (
    stillNeedsApproval ||
    before.taskApprovalRevision !== after.taskApprovalRevision
  ) {
    throw new ToolError(
      'This tool still needs approval. Review the task approvals and try again.',
    )
  }

  return before.approvals
}
