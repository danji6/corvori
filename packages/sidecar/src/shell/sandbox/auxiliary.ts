import type { StartShellJobInput } from '../job-protocol'
import { preparePreview } from './preview'
import { sandboxReady } from './readiness'

/** Apply the job policy before either auxiliary shell transport starts a child. */
export async function prepareAuxiliaryShell(
  input: StartShellJobInput,
  roots: string[],
  directArgv?: string[],
) {
  if (!(await sandboxReady())) return
  return preparePreview(input, [...new Set(roots)], undefined, directArgv)
}
