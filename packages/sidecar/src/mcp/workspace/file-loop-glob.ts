import { splitShellFileGlob } from '@cv/core/shell/file-glob'
import { readdir } from 'node:fs/promises'

import { pathCandidate } from './access'

/** Enumerate a fixed directory without skipping symlink targets. */
export async function expandFileLoopGlob(root: string, candidate: string) {
  const glob = splitShellFileGlob(candidate)
  if (!glob) throw new Error('Unsupported file loop glob')
  const entries = await readNames(pathCandidate(root, glob.directory))
  const [prefix = '', suffix = ''] = glob.filename.toLowerCase().split('*')
  const matches = entries
    .map(decodeName)
    .filter((entry) => matchesName(entry, prefix, suffix))
  return matches.map((name) => glob.directory + name)
}

async function readNames(directory: string) {
  try {
    return await readdir(directory, { encoding: 'buffer' })
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

function decodeName(entry: Uint8Array): string {
  // Bun can return plain Uint8Array entries for the buffer encoding.
  const name = Buffer.from(entry).toString('utf8')
  if (!Buffer.from(name).equals(entry))
    throw new Error('Cannot represent a filename in this directory')
  return name
}

function matchesName(name: string, prefix: string, suffix: string) {
  // Include hidden and case-variant matches for shells with glob options enabled.
  if (/[^\u0020-\u007e]/.test(name)) return true // Case folding is locale-dependent
  const folded = name.toLowerCase()
  return (
    folded.length >= prefix.length + suffix.length &&
    folded.startsWith(prefix) &&
    folded.endsWith(suffix)
  )
}
