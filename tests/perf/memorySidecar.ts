import type { ChangePublication } from '@cv/core/types/changes'
import { strict as assert } from 'node:assert'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectRoot } from '~/scripts/runner/config'
import { resolveNodeBinary, sidecarBuildEntry } from '~/scripts/sidecar'

import type { SessionId } from './clients'
import type { Deployment } from './deployment'

const filesPerWorkspace = 100
const bytesPerFile = 1024

export async function withMemorySidecar<T>(
  deployment: Deployment,
  execute: (sidecar: MemorySidecar) => Promise<T>,
) {
  const build = Bun.spawn(
    [process.execPath, '--no-env-file', 'scripts/sidecar.ts', '--build-only'],
    {
      cwd: projectRoot,
      env: { ...deployment.env, CHAT_DATA_DIR: deployment.dir },
      stderr: 'inherit',
      signal: AbortSignal.timeout(60_000),
    },
  )
  assert.equal(await build.exited, 0, 'Sidecar build failed')
  const binding = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  })
  const port = binding.port!
  await binding.stop(true)
  const url = `http://127.0.0.1:${port}`
  const secret = crypto.randomUUID()
  const sidecar = Bun.spawn(
    [resolveNodeBinary(), sidecarBuildEntry(deployment.dir)],
    {
      cwd: deployment.dir,
      env: {
        ...deployment.env,
        CHAT_SIDECAR_DATA_DIR: join(deployment.dir, 'sidecar'),
        MCP_PORT: String(port),
        SIDECAR_SECRET: secret,
      },
      stdout: 'ignore',
      stderr: 'inherit',
    },
  )
  try {
    await waitForSidecar(url, sidecar)
    return await execute({ url, secret, pid: sidecar.pid })
  } finally {
    sidecar.kill()
    const timer = setTimeout(() => sidecar.kill('SIGKILL'), 3_000)
    try {
      await sidecar.exited
    } finally {
      clearTimeout(timer)
    }
  }
}

type MemorySidecar = { url: string; secret: string; pid: number }

async function waitForSidecar(
  url: string,
  sidecar: { exitCode: number | null },
) {
  const deadline = performance.now() + 10_000
  while (sidecar.exitCode === null && performance.now() < deadline) {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => null)
    if (response?.ok) return
    await Bun.sleep(50)
  }
  throw new Error('Disposable sidecar did not become ready')
}

export async function createMemoryWorkspaces(dir: string, count: number) {
  const root = await realpath(dir)
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const id = `memory-workspace-${index}`
      const path = join(root, id)
      await mkdir(path)
      await Promise.all(
        Array.from({ length: filesPerWorkspace }, (_, file) =>
          writeFile(
            join(path, `${file}.txt`),
            `${id}:${file}`.padEnd(bytesPerFile, 'x'),
          ),
        ),
      )
      return {
        workspaceId: id,
        path,
        label: id,
        sources: [{ id, path, label: id }],
      }
    }),
  )
}

export const memoryWorkspaceSize = { filesPerWorkspace, bytesPerFile }

type Workspace = Awaited<ReturnType<typeof createMemoryWorkspaces>>[number]

export function checkpointWorkload(sidecar: MemorySidecar) {
  async function post<T>(path: string, payload: object) {
    const response = await fetch(`${sidecar.url}/checkpoints/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecar.secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok)
      throw new Error(`Checkpoint ${path} failed: ${await response.text()}`)
    return (await response.json()) as T
  }

  return async (sessionId: SessionId, workspace: Workspace) => {
    const identity = {
      groupId: sessionId,
      participantId: sessionId,
      root: true,
    }
    const opened = await post<{ queued: boolean }>('begin', {
      ...identity,
      sessionId,
      workspace,
    })
    assert.equal(opened.queued, false, 'Disjoint memory fixture queued capture')
    await writeFile(join(workspace.path, '0.txt'), `Edited by ${sessionId}\n`)
    return async () => {
      const result = await post<{
        released: boolean
        publication?: ChangePublication
      }>('finish', { ...identity, checkpointId: sessionId })
      assert.equal(result.released, true)
      assert.equal(result.publication?.files.length, 1)
    }
  }
}
