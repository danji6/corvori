import { managedHomePath } from '@cv/core/skills/home-path'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

import { expandHome } from '../mcp/workspace/paths'
import { inspectHome } from './home-state'
import {
  assertPlainPath,
  dataRoot,
  inside,
  managedHome,
  storePath,
} from './storage'

/** Resolves a selection before the backend reserves its canonical home identity. */
export async function resolveDestination(input: {
  ownerId: string
  agentId: string
  originAgentId?: string
  path?: string
}) {
  const origin = input.originAgentId ?? input.agentId
  const managed = managedHome(input.ownerId, origin)
  const selectsManaged =
    !input.path ||
    input.path === managedHomePath(input.ownerId, origin) ||
    path.resolve(expandHome(input.path)) === managed
  const target =
    !selectsManaged && input.path
      ? await realpath(path.resolve(expandHome(input.path)))
      : (await inspectHome({ ...input, originAgentId: origin, revision: 0 }))
          .path
  await assertPlainPath(target)
  const insideData = inside(dataRoot(), target)
  if (!insideData && inside(target, managed))
    throw new Error('Custom homes cannot overlap server storage')

  return {
    path: storePath(target),
    insideData,
  }
}
