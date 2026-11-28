import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Creates a fixture root with the canonical spelling stored by the sidecar. */
export async function createTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix))
}
