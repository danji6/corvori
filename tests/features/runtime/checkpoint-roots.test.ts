import { managedHome } from '@cv/sidecar/agent-files/storage'
import { snapshot } from '@cv/sidecar/checkpoints/snapshot'
import { sessionDirectory } from '@cv/sidecar/session-files/storage'
import { afterEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { checkpointFixture } from '~/tests/helpers/turn-checkpoints'

const execute = promisify(execFile)
const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
const fixture = () => checkpointFixture(cleanup)

describe('checkpoint capture roots', () => {
  test.each(['session', 'agent'] as const)(
    'marks a checkpoint stale when its %s root moves with the data directory',
    async (scope) => {
      const f = await fixture()
      const before = path.join(f.base, 'before')
      const after = path.join(f.base, 'after')
      const previous = process.env.CHAT_SIDECAR_DATA_DIR
      const workspace = () => ({
        ...f.begin.workspace,
        ...(scope === 'session'
          ? { sessionFiles: true }
          : {
              agentHome: {
                ownerId: 'owner',
                agentId: 'agent',
                path: managedHome('owner', 'agent'),
                revision: 0,
              },
            }),
      })
      const root = () =>
        scope === 'session'
          ? sessionDirectory(f.begin.sessionId)
          : managedHome('owner', 'agent')
      try {
        process.env.CHAT_SIDECAR_DATA_DIR = path.join(
          before,
          '.data',
          'sidecar',
        )
        const target = path.join(root(), 'notes.txt')
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, 'before')
        await f.manager.begin({ ...f.begin, workspace: workspace() })
        await writeFile(target, 'after')
        await f.manager.finish(f.finish)

        await rename(before, after)
        process.env.CHAT_SIDECAR_DATA_DIR = path.join(after, '.data', 'sidecar')
        const result = await f.manager.restore({
          ...f.restore,
          workspace: workspace(),
        })
        expect(result.stale).toBe(true)
        expect(await readFile(path.join(root(), 'notes.txt'), 'utf8')).toBe(
          'after',
        )
      } finally {
        if (previous === undefined) delete process.env.CHAT_SIDECAR_DATA_DIR
        else process.env.CHAT_SIDECAR_DATA_DIR = previous
      }
    },
  )

  test('captures an agent home ignored by its enclosing project and preserves local ignores through undo/redo', async () => {
    const f = await fixture()
    await execute('git', ['init', '-q', f.root])
    await writeFile(path.join(f.root, '.gitignore'), '.data/\n')
    const home = path.join(
      f.root,
      '.data',
      'sidecar',
      'agents',
      'owner',
      'home',
    )
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, '.gitignore'), '*.log\n')
    const personal = path.join(home, 'notes.txt')
    const ignored = path.join(home, 'output.log')
    const project = path.join(f.root, 'style.css')
    await writeFile(personal, 'before home\n')
    await writeFile(ignored, 'before log\n')
    await writeFile(project, 'before project\n')
    const workspace = {
      ...f.begin.workspace,
      agentHome: {
        ownerId: 'owner',
        agentId: 'agent',
        path: home,
        revision: 0,
      },
    }
    await f.manager.begin({ ...f.begin, workspace })
    await writeFile(personal, 'after home\n')
    await writeFile(ignored, 'after log\n')
    await writeFile(project, 'after project\n')
    const result = await f.manager.finish(f.finish)
    expect(result.publication?.issues).toEqual([])
    expect(result.publication?.files.map((file) => file.path).sort()).toEqual([
      'agent://notes.txt',
      'style.css',
    ])
    await f.manager.restore({
      ...f.restore,
      workspace,
      workspaces: [workspace],
    })
    expect(await readFile(personal, 'utf8')).toBe('before home\n')
    expect(await readFile(project, 'utf8')).toBe('before project\n')
    expect(await readFile(ignored, 'utf8')).toBe('after log\n')
    await f.manager.restore({
      ...f.restore,
      workspace,
      workspaces: [workspace],
      revision: 1,
      direction: 'reapply',
      operationId: 'redo',
    })
    expect(await readFile(personal, 'utf8')).toBe('after home\n')
    expect(await readFile(project, 'utf8')).toBe('after project\n')
  })

  test('retains capture errors for a broken Git index instead of falling back to a partial filesystem scan', async () => {
    const f = await fixture()
    await execute('git', ['init', '-q', f.root])
    await writeFile(path.join(f.root, '.git', 'index'), 'broken index')
    await writeFile(path.join(f.root, 'file.txt'), 'content')
    const result = await snapshot(f.storage, [f.root])
    expect(result.issues).toHaveLength(1)
    expect(result.files).toEqual({})
  })
})
