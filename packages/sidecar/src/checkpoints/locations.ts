import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { isMissing, restorePath } from '../agent-files/storage'
import { sessionDirectory } from '../session-files/storage'
import type { Checkpoint, RestoreInput } from './types'

export const checkpointLocationsSchema = z.object({
  project: z.array(z.string()),
  homes: z.array(z.string()),
  sessionFiles: z.boolean(),
})

type Locations = z.infer<typeof checkpointLocationsSchema>

/** Checks each captured directory that contributed files to the checkpoint. */
export async function checkpointLocationChanged(
  checkpoint: Checkpoint,
  locations: Locations,
) {
  if (checkpoint.stale) return true

  const roots = new Set(checkpoint.roots)
  const used = new Set<string>()
  for (const file of checkpoint.files) {
    const root = containingRoot(roots, file.target)
    if (root) used.add(root)
  }
  if (!used.size) return false

  const current = new Set([
    ...locations.project,
    ...locations.homes.map(restorePath),
    ...(locations.sessionFiles ? [sessionDirectory(checkpoint.sessionId)] : []),
  ])
  for (const root of used) {
    if (!current.has(root) || !(await isOriginalDirectory(root))) return true
  }
  return false
}

function containingRoot(roots: Set<string>, target: string) {
  // Explicitly tracked external files can be roots for write coordination.
  // Start at the parent so the file itself is not treated as a directory.
  let directory = path.dirname(target)
  while (true) {
    if (roots.has(directory)) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

async function isOriginalDirectory(root: string) {
  try {
    return (await realpath(root)) === root && (await stat(root)).isDirectory()
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
      return false
    throw error
  }
}

/** Uses the resolved authority for clients that supply full restore workspaces. */
export function restoreLocations(input: RestoreInput): Locations {
  const all = [input.workspace, ...(input.workspaces ?? [])]
  return {
    project: all.flatMap((workspace) =>
      workspace.agentOnly
        ? []
        : (workspace.sources ?? []).map(({ path }) => path),
    ),
    homes: all.flatMap(({ agentHome }) => (agentHome ? [agentHome.path] : [])),
    sessionFiles: input.workspace.sessionFiles ?? false,
  }
}
