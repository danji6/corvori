import { releaseName } from '@cv/core/update/source'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { projectRoot } from './runner/config'
import { output } from './runner/processes'

/** Builds the source archives for a release. */
async function main() {
  const version = await readVersion()
  const name = releaseName(version)
  const outDir = join(projectRoot, '.data/release')
  const staging = join(outDir, name)

  await rm(outDir, { force: true, recursive: true })
  await mkdir(staging, { recursive: true })

  await exportTree(staging)
  await includeSandboxHelpers(staging)
  await assertNoSymlinks(staging)
  await writeReleaseFile(staging, version)

  await output(['tar', '-czf', `${name}.tar.gz`, name], { cwd: outDir })
  await writeZip(outDir, name)
  await rm(staging, { force: true, recursive: true })

  await writeChecksums(outDir, [`${name}.tar.gz`, `${name}.zip`])
  console.log(`Packaged ${name} into ${outDir}`)
}

/** Add the native helper sets built by the release workflow. */
async function includeSandboxHelpers(staging: string) {
  for (const arch of ['x64', 'arm64']) {
    const name = `linux-${arch}`
    const archive = join(projectRoot, '.data/sandbox-helpers', name + '.tar.gz')
    const destination = join(staging, 'packages/sidecar/vendor', name)
    await mkdir(destination, { recursive: true })
    await output(['tar', '-xzf', archive, '-C', destination], { cwd: staging })
    // Nix store directories ship read-only. Let the owner replace them on update.
    await chmod(destination, 0o755)
    await chmod(join(destination, 'sources'), 0o755)
    const manifest = await readFile(join(destination, 'SHA256SUMS'), 'utf8')
    for (const file of ['bwrap', 'socat', 'rg']) {
      const hash = new Bun.CryptoHasher('sha256')
        .update(await readFile(join(destination, file)))
        .digest('hex')
      if (!manifest.split('\n').includes(`${hash}  ${file}`)) {
        throw new Error(`Invalid sandbox helper checksum for ${name}/${file}`)
      }
    }
  }
}

async function readVersion() {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, 'package.json'), 'utf8'),
  ) as { version?: string }

  if (!manifest.version) throw new Error('package.json has no version')
  return manifest.version
}

async function exportTree(staging: string) {
  const archive = join(staging, '..', 'source.tar')
  await output(
    [
      'git',
      'archive',
      '--worktree-attributes',
      '--format=tar',
      '--output',
      archive,
      'HEAD',
    ],
    { cwd: projectRoot },
  )
  await output(['tar', '-xf', archive, '-C', staging], { cwd: projectRoot })
  await rm(archive, { force: true })
}

async function writeZip(outDir: string, name: string) {
  const zip = `${name}.zip`

  for (const cmd of [
    ['zip', '-qr', zip, name],
    ['bsdtar', '-a', '-cf', zip, name],
  ]) {
    try {
      await output(cmd, { cwd: outDir })
      return
    } catch {
      continue
    }
  }

  throw new Error('Packaging a zip needs either `zip` or `bsdtar` installed')
}

async function assertNoSymlinks(staging: string) {
  const found = await output(['find', staging, '-type', 'l'], {
    cwd: projectRoot,
  })
  if (found) {
    throw new Error(
      `Release archives must not contain symlinks, found:\n${found}\n` +
        'Add an `export-ignore` attribute for them in .gitattributes.',
    )
  }
}

async function writeReleaseFile(staging: string, version: string) {
  const commit = await output(['git', 'rev-parse', 'HEAD'], {
    cwd: projectRoot,
  })

  await writeFile(
    join(staging, 'release.json'),
    `${JSON.stringify({ commit, publishedAt: new Date().toISOString(), version }, null, 2)}\n`,
  )
}

async function writeChecksums(outDir: string, files: string[]) {
  const lines = await Promise.all(
    files.map(async (file) => {
      const digest = new Bun.CryptoHasher('sha256')
        .update(await readFile(join(outDir, file)))
        .digest('hex')
      return `${digest}  ${file}`
    }),
  )

  await writeFile(join(outDir, 'checksums.txt'), `${lines.join('\n')}\n`)
}

await main()
