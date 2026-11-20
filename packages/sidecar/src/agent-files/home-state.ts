import type { AgentHome } from '@cv/core/skills/types'
import { realpath, stat } from 'node:fs/promises'

import {
  assertPlainPath,
  dataRoot,
  inside,
  isMissing,
  managedHome,
  requestedHome,
} from './storage'

export type HomeInput = Omit<AgentHome, 'path'> & { path?: string }

export function homePath(input: HomeInput) {
  return requestedHome(
    input.ownerId,
    input.originAgentId ?? input.agentId,
    input.path,
  )
}

/** Checks the authorized folder without creating it or following substitutions. */
export async function inspectHome(input: HomeInput) {
  const origin = input.originAgentId ?? input.agentId
  const managed = managedHome(input.ownerId, origin)
  const requested = homePath(input)
  if (inside(dataRoot(), requested) && requested !== managed)
    throw new Error('Custom homes cannot overlap server storage')
  await assertPlainPath(requested)

  try {
    const canonical = await realpath(requested)
    await assertPlainPath(canonical)
    if (inside(dataRoot(), canonical) && canonical !== managed)
      throw new Error('Custom homes cannot overlap server storage')
    if (!(await stat(canonical)).isDirectory())
      throw new Error('Personal home must be a directory')
    return { path: canonical, exists: true }
  } catch (error) {
    if (!isMissing(error)) throw error
    return { path: requested, exists: false }
  }
}
