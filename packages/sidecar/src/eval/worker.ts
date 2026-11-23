import {
  type EvaluationReply,
  type EvaluationRequest,
  evaluateRequest,
} from '@cv/core/interpreter/request'
import { parentPort, workerData } from 'node:worker_threads'

import { createFileExistsHelper, createFileHelper } from './file-helper'
import { requestShell } from './shell-bridge'

const request = workerData as EvaluationRequest & {
  shellEnabled?: boolean
  authorizedAgentDir?: string
  authorizedWorkDir?: string
  authorizedWorkDirs?: string[]
}
try {
  const result = await evaluateRequest(request, {
    shell: request.shellEnabled ? requestShell : undefined,
    readFile: createFileHelper(
      request.authorizedWorkDir,
      request.authorizedWorkDirs,
      request.authorizedAgentDir,
    ),
    fileExists: createFileExistsHelper(
      request.authorizedWorkDir,
      request.authorizedWorkDirs,
      request.authorizedAgentDir,
    ),
  })
  parentPort?.postMessage({ ok: true, result } satisfies EvaluationReply)
} catch {
  parentPort?.postMessage({
    ok: false,
    error: 'Dynamic JavaScript failed or exceeded its resource limit',
  } satisfies EvaluationReply)
}
