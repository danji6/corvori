import type {
  CheckedPath,
  PathCheckResult,
} from '@cv/core/workspace/path-policy'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { glob } from 'tinyglobby'

import {
  firstSymlink,
  inspectPath,
  isOutside,
  resolvePathGrants,
} from './access'
import { expandFileLoopGlob } from './file-loop-glob'

const MAX_GLOB_MATCHES = 256
const GLOB_CHARS = /[*?[\]{}]/
const SAFE_DEVICE_PATHS = new Set([
  '/dev/null',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
])

/** Resolve paths against allowlist grants and identify sensitive paths that still need approval. */
export async function checkPaths(
  root: string,
  input: PathCheckInput,
  roots: string[] = [root],
  grantRoot = root,
): Promise<PathCheckResult> {
  const grants = await resolvePathGrants(grantRoot, input.allowedPaths ?? [])

  const result: PathCheckResult = {
    uncovered: [],
    resolved: [],
    complete: true,
  }

  for (const candidate of input.paths) {
    try {
      const shellExpansion = !input.literal && !input.quoted
      if (shellExpansion && (/^~/.test(candidate) || /\$/.test(candidate)))
        throw new Error('Dynamic path')
      const candidates = await expandCandidate(root, candidate, input)
      for (const value of candidates) {
        // These special devices retain their existing shell exemption
        if (shellExpansion && SAFE_DEVICE_PATHS.has(path.resolve(root, value)))
          continue
        result.resolved.push(await inspectPath(root, value, grants, roots))
      }
    } catch {
      result.complete = false
      result.uncovered.push(candidate)
    }
  }
  await collectUncoveredPaths(root, roots, result, Boolean(input.literal))
  result.uncovered = [...new Set(result.uncovered)]
  return result
}

type PathCheckInput = {
  paths: string[]
  allowedPaths?: string[]
  literal?: boolean
  quoted?: true
  fileLoop?: true
}

async function collectUncoveredPaths(
  cwd: string,
  roots: string[],
  result: PathCheckResult,
  literal: boolean,
) {
  const ignored = new Set<string>()

  if (!literal) {
    for (const root of roots) {
      const matches = await gitIgnoredPaths(root, cwd, result.resolved).catch(
        () => null,
      )
      if (matches === null) result.complete = false
      else for (const match of matches) ignored.add(match)
    }
  }

  for (const item of result.resolved) {
    const sensitive = item.outside || item.forbidden || ignored.has(item.path)
    if (sensitive && !item.allowed) {
      result.uncovered.push(item.path)
    }
  }
}

async function gitIgnoredPaths(
  root: string,
  cwd: string,
  items: CheckedPath[],
): Promise<string[] | null> {
  const checks: { target: string; gitPaths: string[] }[] = []
  for (const item of items) {
    if (isOutside(root, item.absolutePath)) continue
    const gitPaths = await gitPathsForItem(root, cwd, item)
    checks.push({ target: item.path, gitPaths })
  }

  const paths = [...new Set(checks.flatMap((check) => check.gitPaths))]
  const matches = await gitCheckIgnore(root, paths)
  if (matches === null) return null
  return checks
    .filter(({ gitPaths }) =>
      gitPaths.some((candidate) => matches.has(candidate)),
    )
    .map(({ target }) => target)
}

async function gitPathsForItem(root: string, cwd: string, item: CheckedPath) {
  const paths = [gitRelativePath(root, item.absolutePath)]
  const input = path.resolve(cwd, item.inputPath)
  if (input === item.absolutePath || isOutside(root, input)) return paths

  // Git can check the link itself, but rejects pathspecs below it.
  const alias = await firstSymlink(root, path.relative(root, input))
  paths.push(gitRelativePath(root, alias ?? input))
  return paths
}

/** Represent the root as a valid Git pathspec, including during result matching. */
function gitRelativePath(root: string, target: string): string {
  return path.relative(root, target) || '.'
}

async function expandCandidate(
  root: string,
  candidate: string,
  { literal, quoted, fileLoop }: PathCheckInput,
): Promise<string[]> {
  if (literal || quoted || !GLOB_CHARS.test(candidate)) return [candidate]

  const matches = fileLoop
    ? await expandFileLoopGlob(root, candidate)
    : await glob(candidate, {
        cwd: root,
        absolute: true,
        dot: true,
        onlyFiles: false,
        followSymbolicLinks: false,
      })
  if (matches.length > MAX_GLOB_MATCHES)
    throw new Error('Too many glob matches')

  // An unmatched pattern is still a possible literal operand
  return matches.length ? matches : [candidate]
}

function gitCheckIgnore(
  root: string,
  paths: string[],
): Promise<Set<string> | null> {
  if (!paths.length) return Promise.resolve(new Set())
  return new Promise((resolve) => {
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.stdin.on('error', () => {})
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code === 0 || code === 1)
        resolve(new Set(stdout.split('\0').filter(Boolean)))
      else if (stderr.includes('not a git repository')) resolve(new Set())
      else resolve(null)
    })
    child.stdin.end(paths.join('\0') + '\0')
  })
}
