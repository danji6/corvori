import {
  initializeBackend,
  workspaceProbePolicy,
} from '@cv/sidecar/shell/sandbox/backend'
import { prepareProbeCommand } from '@cv/sidecar/shell/sandbox/diagnostic-command'
import { delimiter, dirname, resolve } from 'node:path'
import process from 'node:process'

// Both programs start in this fixture package before changing to the disposable repo.
const vendor = resolve(process.cwd(), '../../../../packages/sidecar/vendor')
process.env.PATH = dirname(process.execPath) + delimiter + process.env.PATH
export const offlinePolicy = (workspace) =>
  workspaceProbePolicy(workspace, vendor)
export { initializeBackend, prepareProbeCommand }
