import type { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'

type CheckLibraryPage = typeof api.actions.skills.checkLibraryPage

type RemoveMissingSkills = typeof api.actions.skills.removeMissingSkills

type SkillVerificationPage = FunctionReturnType<CheckLibraryPage>

type CheckPage = (
  args: FunctionArgs<CheckLibraryPage>,
) => Promise<SkillVerificationPage>

type RemovePage = (
  args: FunctionArgs<RemoveMissingSkills>,
) => Promise<FunctionReturnType<RemoveMissingSkills>>

/** Visits every library page before returning any cleanup candidates. */
export async function checkInstalledSkills(
  checkPage: CheckPage,
  onProgress: (checked: number) => void,
) {
  let cursor: string | null = null
  let checked = 0
  let skipped = 0
  const missing: SkillVerificationPage['missing'] = []
  while (true) {
    const page = await checkPage({ paginationOpts: { cursor, numItems: 20 } })
    checked += page.checked
    skipped += page.skipped
    missing.push(...page.missing)
    onProgress(checked)
    if (page.isDone) return { checked, skipped, missing }
    cursor = page.continueCursor
  }
}

/** Sends only explicitly confirmed IDs in bounded cleanup batches. */
export async function removeConfirmedSkills(
  removePage: RemovePage,
  skillIds: Id<'skills'>[],
) {
  let removed = 0
  for (let offset = 0; offset < skillIds.length; offset += 20) {
    const result = await removePage({
      skillIds: skillIds.slice(offset, offset + 20),
    })
    removed += result.removed
  }
  return removed
}
