import { api } from '@cv/convex/_generated/api'
import { updateDisabledSkills } from '@cv/core/skills/names'
import type { OptimisticLocalStore } from 'convex/browser'
import type { FunctionArgs } from 'convex/server'

/** Projects skill changes into every cached toolkit list until Convex confirms them. */
export function optimisticallyUpdateToolkitSkills(
  store: OptimisticLocalStore,
  { toolkitId, skill, ...patch }: FunctionArgs<typeof api.toolkits.settings>,
) {
  for (const { args, value } of store.getAllQueries(api.toolkits.list)) {
    if (!value) continue
    const next = value.map((row) => {
      if (row._id !== toolkitId) return row
      return {
        ...row,
        ...patch,
        ...(skill && {
          disabledSkills: updateDisabledSkills(
            row.disabledSkills,
            skill.name,
            skill.enabled,
          ),
        }),
      }
    })
    store.setQuery(api.toolkits.list, args, next)
  }
}
