import { joinWindowsCommandLine } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mxc-sandbox-utils.js'
import { probe, spawn } from '@microsoft/mxc-sdk/v1'
import assert from 'node:assert/strict'
import console from 'node:console'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { text } from 'node:stream/consumers'

// Qualify the exact workspace permissions before enabling automatic Windows jobs.
const root = await mkdtemp(join(tmpdir(), 'corvori-mxc-'))
const workspace = join(root, 'workspace')
const runtime = process.execPath
const dependency = join(workspace, 'node_modules')
const outside = join(root, 'sibling')
const ignored = join(workspace, 'ignored')
const server = createServer((_request, response) => response.end('fixture'))
function ancestors(path) {
  const directories = []
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    directories.push(parent)
    if (parent === dirname(parent)) return directories
  }
}
try {
  await mkdir(dependency, { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, 'sample'), 'fixture')
  await writeFile(join(dependency, 'sample'), 'fixture')
  await writeFile(ignored, 'fixture')
  await symlink(outside, join(workspace, 'linked'), 'junction')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const script = join(workspace, 'verify.cjs')
  await writeFile(
    script,
    [
      "const fs = require('node:fs')",
      'const [outside, port] = process.argv.slice(2)',
      "function accessible(fn) { try { fn(); return true } catch (e) { if (!['EACCES','EPERM','ENOENT'].includes(e.code)) throw e; return false } }",
      'const read = (p) => accessible(() => fs.readFileSync(p))',
      "const write = (p) => accessible(() => fs.writeFileSync(p, 'fixture'))",
      "const results = { ordinary: write('result'), dependencyRead: read('node_modules/sample'), dependencyWrite: write('node_modules/sample'), ignored: read('ignored'), outside: read(outside), listSibling: accessible(() => fs.readdirSync(require('node:path').dirname(outside))), linked: read('linked/sample') }",
      "fetch('http://127.0.0.1:' + port, {signal: AbortSignal.timeout(2500)}).then(r => r.text()).catch(() => '').then(body => console.log(JSON.stringify({...results, online: body === 'fixture'})))",
    ].join('\n'),
  )
  for (const online of [false, true]) {
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
              ...new Set([...ancestors(workspace), ...ancestors(runtime)]),
            ],
          },
        },
      },
      filesystem: {
        readonlyPaths: [runtime, dependency],
        readwritePaths: [workspace],
        deniedPaths: [ignored],
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
      console.log({ online, result })
      assert.deepEqual(result, {
        ordinary: true,
        dependencyRead: true,
        dependencyWrite: false,
        ignored: false,
        outside: false,
        listSibling: false,
        linked: false,
        online,
      })
    } finally {
      child.dispose()
    }
  }
} finally {
  server.close()
  await rm(root, { recursive: true, force: true })
}
