import { joinWindowsCommandLine } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mxc-sandbox-utils.js'
import { probe, spawn } from '@microsoft/mxc-sdk/v1'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import process from 'node:process'
import { text } from 'node:stream/consumers'
import { URL } from 'node:url'

// Qualify the exact workspace permissions before enabling automatic Windows jobs.
const root = await mkdtemp(join(tmpdir(), 'corvori-mxc-'))
const workspace = join(root, 'workspace')
const runtime = process.execPath
const dependency = join(workspace, 'node_modules')
const outside = join(root, 'sibling')
const ignored = join(workspace, 'ignored')
const opensslConfig = join(root, 'openssl.cnf')
const server = createServer((_request, response) => response.end('fixture'))
try {
  await mkdir(dependency, { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, 'sample'), 'fixture')
  const shared = join(outside, 'shared')
  await writeFile(shared, 'fixture')
  execFileSync('icacls.exe', [shared, '/grant', '*S-1-15-2-1:(R)'], {
    stdio: 'pipe',
  })
  await writeFile(join(dependency, 'sample'), 'fixture')
  await writeFile(ignored, 'fixture')
  await writeFile(opensslConfig, '')
  await symlink(outside, join(workspace, 'linked'), 'junction')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const script = join(workspace, 'verify.cjs')
  await copyFile(
    new URL('./windows-workspace-child.cjs', import.meta.url),
    script,
  )
  const qualified = new Set()
  const libraries = []
  for (const name of ['System32', 'SysWOW64', 'WinSxS']) {
    const path = join(process.env.SystemRoot, name)
    if (
      await stat(path).then(
        (s) => s.isDirectory(),
        () => false,
      )
    )
      libraries.push(path)
  }
  for (const denyVolume of [false, true]) {
    for (const online of [false, true]) {
      try {
        const request = {
          command: joinWindowsCommandLine([
            runtime,
            script,
            join(outside, 'sample'),
            String(server.address().port),
          ]),
          workingDirectory: workspace,
          containment: {
            type: 'processcontainer',
            config: {
              filesystem: {
                enumeratePaths: [
                  ...new Set([parse(workspace).root, parse(runtime).root]),
                ],
              },
            },
          },
          filesystem: {
            readonlyPaths: [runtime, dependency, opensslConfig, ...libraries],
            readwritePaths: [workspace],
            deniedPaths: [
              ignored,
              ...(denyVolume ? [parse(workspace).root] : []),
            ],
          },
          network: {
            egress: { default: online ? 'allow' : 'deny' },
            ingress: {
              default: online ? 'allow' : 'deny',
              hostLoopback: online ? 'allow' : 'deny',
            },
          },
          ui: { disable: false, clipboard: 'none', allowInputInjection: false },
          environment: {
            SystemRoot: process.env.SystemRoot,
            LOCALAPPDATA: process.env.LOCALAPPDATA,
            PATH: dirname(runtime),
            OPENSSL_CONF: opensslConfig,
            NODE_OPTIONS: '--preserve-symlinks-main --preserve-symlinks',
          },
          inheritDefaultEnvironment: false,
          timeoutMs: 15000,
        }
        const facts = probe(request)
        assert.equal(facts.tier, 'base-container', JSON.stringify(facts))
        const child = await spawn(request)
        try {
          const [stdout, stderr, exit] = await Promise.all([
            text(child.standardOutput),
            text(child.standardError),
            child.wait(),
          ])
          assert.equal(exit.exitCode, 0, stderr)
          const result = JSON.parse(stdout.trim())
          console.log({ online, denyVolume, result })
          assert.deepEqual(result, {
            ordinary: true,
            dependencyRead: true,
            dependencyWrite: false,
            ignored: false,
            outside: false,
            listSibling: false,
            shared: false,
            linked: false,
            online,
          })
          qualified.add(String(denyVolume) + ':' + String(online))
        } finally {
          child.dispose()
        }
      } catch (error) {
        console.error({ online, denyVolume, failure: error.message })
      }
    }
  }
  assert.ok(
    [false, true].some(
      (mode) => qualified.has(mode + ':false') && qualified.has(mode + ':true'),
    ),
    'No Windows policy passed both network modes',
  )
} finally {
  server.close()
  await rm(root, { recursive: true, force: true })
}
