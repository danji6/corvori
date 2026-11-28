import { snapshotGitPaths } from '@cv/sidecar/shell/sandbox/ignore-snapshot'
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('each launch snapshots Git exclusions and preserves dependency reads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'corvori-ignore-')))
  const path = (name: string) => join(root, name)
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    await mkdir(path('nested'))
    await mkdir(path('node_modules'))
    await writeFile(path('node_modules/pkg.js'), 'fixture')
    await writeFile(path('.gitignore'), '*.private\nnode_modules/\n')
    await writeFile(path('nested/.gitignore'), '!public.private\n')
    await writeFile(path('nested/public.private'), '')
    await writeFile(path('nested/[a].private'), '')
    const first = await snapshotGitPaths(root)
    expect(first.hidden.sort()).toEqual([path('nested/[a].private')])
    expect(first.readOnly.sort()).toEqual(
      [
        path('.git'),
        path('.gitignore'),
        path('nested/.gitignore'),
        path('node_modules'),
      ].sort(),
    )
    await writeFile(path('nested/new.private'), '')
    expect(first.hidden).not.toContain(path('nested/new.private'))
    expect((await snapshotGitPaths(root)).hidden).toContain(
      path('nested/new.private'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('snapshots nested repositories and makes their linked metadata read-only', async () => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'corvori-linked-git-')),
  )
  const root = join(base, 'workspace')
  const nested = join(root, 'child')
  const metadata = join(base, 'child-metadata')
  try {
    execFileSync('git', ['init', '--quiet', root])
    execFileSync('git', [
      'init',
      '--quiet',
      '--separate-git-dir',
      metadata,
      nested,
    ])
    await writeFile(join(nested, '.gitignore'), '*.private\n')
    const privateFile = join(nested, 'implicit.private')
    await writeFile(privateFile, 'test fixture')
    const { hidden, readOnly } = await snapshotGitPaths(root)
    expect(hidden).toContain(privateFile)
    expect(readOnly).toContain(metadata)
    expect(readOnly).toContain(join(nested, '.git'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
