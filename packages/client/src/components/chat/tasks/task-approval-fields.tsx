import {
  PathApprovalList,
  ShellApprovalList,
} from '@/components/chat/entities/agent/approval-list'
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
      <legend className="px-1 text-sm font-medium">Auto approvals</legend>
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
      <ShellApprovalList
        className="p-0"
        values={value.shell}
        onChange={(shell) => onChange({ ...value, shell })}
        placeholder="e.g. git checkout"
        validate={(entries) =>
          entries.length > MAX_APPROVAL_PATTERNS
            ? `Enter at most ${MAX_APPROVAL_PATTERNS} shell command prefixes.`
            : null
        }
      />
      <PathApprovalList
        className="p-0"
        values={value.paths}
        onChange={(paths) => onChange({ ...value, paths })}
        placeholder={hasWorkspace ? 'e.g. reports/' : 'e.g. /projects/reports/'}
        absoluteOnly={!hasWorkspace}
        validate={(paths) => taskApprovalPathsError(paths, hasWorkspace)}
      />
    </fieldset>
  )
}
