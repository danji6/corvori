import { joinWindowsCommandLine } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mxc-sandbox-utils.js'
import { run } from '@microsoft/mxc-sdk/v1'
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import process from 'node:process'

const root = await mkdtemp(join(tmpdir(), 'corvori-git-ro-'))
const cwd = join(root, 'repo')
const drive = parse(root).root
const git = join(process.env.ProgramFiles, 'Git/cmd/git.exe')
try {
  await mkdir(cwd)
  execFileSync(git, ['init', '-q'], { cwd })
  await writeFile(join(cwd, 'marker'), 'fixture')
  for (const [name, reads, enumerate] of [
    ['drive', [drive], []],
    ['parent', [drive, root], []],
    ['workspace', [drive, cwd], []],
    ['enumerate', [drive, cwd], [cwd]],
    ['enumerate-parents', [drive, cwd], [drive, dirname(root), root, cwd]],
  ]) {
    const request = {
      workingDirectory: cwd,
      containment: {
        type: 'processcontainer',
        config: { filesystem: { enumeratePaths: enumerate } },
      },
      filesystem: { readonlyPaths: reads, readwritePaths: [], deniedPaths: [] },
      environment: {
        SystemRoot: process.env.SystemRoot,
        LOCALAPPDATA: root,
        PATH: dirname(git),
        GIT_OPTIONAL_LOCKS: '0',
      },
      inheritDefaultEnvironment: false,
      ui: { disable: false, clipboard: 'none', allowInputInjection: false },
      network: {
        egress: { default: 'deny' },
        ingress: { default: 'deny', hostLoopback: 'deny' },
      },
      timeoutMs: 10000,
    }
    for (const [what, argv] of [
      ['git', [git, 'status', '--short']],
      [
        'git-symlinks-off',
        [git, '-c', 'core.symlinks=false', 'status', '--short'],
      ],
      ['chdir', [process.execPath, '-e', 'process.chdir(process.cwd())']],
    ]) {
      const result = await run({
        ...request,
        command: joinWindowsCommandLine(argv),
      })
      console.log(
        name,
        what,
        result.exitCode,
        result.stdout?.trim(),
        result.stderr?.trim(),
      )
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
