import { ApprovalList } from '@/components/chat/entities/agent/approval-list'
import { RippleButton } from '@/components/ui/ripple-button'
import type { TaskApprovals } from '@cv/convex/validators/scheduledTasks'
import { MAX_APPROVAL_PATTERNS } from '@cv/core/limits'
import { taskApprovalPathsError } from '@cv/core/workspace/path-policy'

type Props = {
  value: TaskApprovals
  onChange: (value: TaskApprovals) => void
  hasWorkspace: boolean
  needsReview: boolean
  onReview: () => void
}

export function TaskApprovalFields({
  value,
  onChange,
  hasWorkspace,
  needsReview,
  onReview,
}: Props) {
  return (
    <fieldset className="border-border grid gap-3 rounded-xl border p-4">
      <legend className="px-1 text-sm font-medium">Automatic approvals</legend>
      <p className="text-muted-foreground text-sm">
        These grants apply during this task’s run.
      </p>
      {needsReview && (
        <div className="grid justify-items-start gap-2">
          <p role="status" className="text-sm">
            Workspace sources changed. Review the grants before saving the task.
          </p>
          <RippleButton type="button" variant="surface" onClick={onReview}>
            Confirm grants for this workspace
          </RippleButton>
        </div>
      )}
      <div className="grid gap-1">
        <span className="text-sm font-medium">Shell command prefixes</span>
        <ApprovalList
          values={value.shell}
          onChange={(shell) => onChange({ ...value, shell })}
          label="Command prefix"
          placeholder="e.g. git checkout"
          validate={(entries) =>
            entries.length > MAX_APPROVAL_PATTERNS
              ? `Enter at most ${MAX_APPROVAL_PATTERNS} shell command prefixes.`
              : null
          }
        />
      </div>
      <div className="grid gap-1">
        <span className="text-sm font-medium">Paths</span>
        <p className="text-muted-foreground text-xs">
          Grants cover reads and edits. Directory grants include their contents.
          {hasWorkspace
            ? ' Enter an absolute or workspace-relative path.'
            : ' Enter an absolute path.'}
        </p>
        <ApprovalList
          values={value.paths}
          onChange={(paths) => onChange({ ...value, paths })}
          label="Path"
          placeholder={
            hasWorkspace ? 'e.g. reports/' : 'e.g. /projects/reports/'
          }
          validate={(paths) => taskApprovalPathsError(paths, hasWorkspace)}
        />
      </div>
    </fieldset>
  )
}
