import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSidecar, resolveNodeBinary } from '~/scripts/sidecar'
import { createTempDirectory } from '~/tests/helpers/temp-directory'

let child: ReturnType<typeof Bun.spawn>
let root: string
let base: string
let port: number
let entry: string
const secret = 'isolated-sidecar-fixture'

beforeAll(async () => {
  root = await createTempDirectory('corvori-eval-')
  await writeFile(join(root, 'fixture.txt'), 'workspace fixture')
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  port = probe.port!
  probe.stop(true)
  base = `http://127.0.0.1:${port}`
  entry = await buildSidecar()
  await startFixtureSidecar()
}, 15_000)

async function startFixtureSidecar() {
  child = Bun.spawn([resolveNodeBinary(), entry], {
    env: {
      PATH: process.env.PATH,
      SIDECAR_SECRET: secret,
      MCP_PORT: String(port),
      CHAT_SIDECAR_DATA_DIR: root,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await fetch(`${base}/health`)
        .then((response) => response.ok)
        .catch(() => false)
    )
      return
    await Bun.sleep(50)
  }
  throw new Error('Fixture sidecar failed to start')
}

afterAll(async () => {
  child?.kill()
  if (child) await child.exited
  if (root) await rm(root, { recursive: true, force: true })
})

function evaluate(texts: string[], extra: Record<string, unknown> = {}) {
  return fetch(`${base}/eval/message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parts: texts.map((text) => ({ type: 'text', text })),
      context: {},
      environment: {},
      ...extra,
    }),
  })
}

describe('packaged Node evaluation workers', () => {
  test('preserves model context through message route validation', async () => {
    const response = await evaluate(['{{ modelName }} ({{ modelId }})'], {
      context: { modelId: 'model-a', modelName: 'Model A' },
    })
    expect(response.status).toBe(200)
    expect((await response.json()).parts[0].text).toBe('Model A (model-a)')
  })

  test('preserves model context through prompt route validation', async () => {
    const response = await fetch(`${base}/eval/prompts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ enabled: true, content: '{{ modelName }} ({{ modelId }})' }],
        context: { modelId: 'model-a', modelName: 'Model A' },
      }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).items[0].content).toBe('Model A (model-a)')
  })

  test('has no host globals, including through helper constructors', async () => {
    const response = await evaluate([
      "{{ [typeof process, typeof fetch, typeof require, typeof document, readFile.constructor('return typeof process')()] }}",
    ])
    expect(response.status).toBe(200)
    expect((await response.json()).parts[0].text).toBe(
      '["undefined","undefined","undefined","undefined","undefined"]',
    )
  })

  test('shares variables within a successful batch and isolates separate guests', async () => {
    const response = await evaluate([
      '{{ setVar("x", 42) }}',
      '{{ getVar("x") }}',
    ])
    expect(await response.json()).toMatchObject({
      parts: [{ text: '' }, { text: '42' }],
      environment: { x: 42 },
      dirty: true,
    })
    expect(
      (await (await evaluate(['{{ getVar("x") }}'])).json()).parts[0].text,
    ).toBe('')
  })

  test('does not return partial output or environment on failure', async () => {
    const response = await evaluate([
      '{{ setVar("x", 42) }}',
      '{{ missingName() }}',
    ])
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'Dynamic JavaScript failed or exceeded its resource limit',
    })
  })

  test('terminates unbounded JavaScript and stays available', async () => {
    const response = await evaluate(['#eval\nwhile (true) {}\n#end'])
    expect(response.status).toBe(422)
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect((await (await evaluate(['{{ 2 + 2 }}'])).json()).parts[0].text).toBe(
      '4',
    )
  }, 10_000)

  test('requires explicit filesystem authority, independent of guest context', async () => {
    const text = '{{ readFile("fixture.txt", { wrap: false }) }}'
    const denied = await evaluate([text], {
      context: { workDir: root, isAdmin: true },
    })
    expect((await denied.json()).parts[0].text).toBe('')
    const allowed = await evaluate([text], { authorizedWorkDir: root })
    expect((await allowed.json()).parts[0].text).toBe('workspace fixture')
    expect(
      (
        await evaluate(['{{ readFile("../outside") }}'], {
          authorizedWorkDir: root,
        })
      ).status,
    ).toBe(422)
  })

  test('requires authentication on real operational routes', async () => {
    for (const path of [
      '/eval/message',
      '/mcp',
      '/shell/stream',
      '/mcp-ext/list',
      '/workspace/read-file',
    ]) {
      expect((await fetch(`${base}${path}`, { method: 'POST' })).status).toBe(
        401,
      )
    }
  })
})

type AuthoredStatus = {
  state: string
  call?: number
  result?: { texts: string[] }
}

function operation<T>(name: string, body: Record<string, unknown> = {}) {
  return fetch(`${base}/eval/operations/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).then(async (response) => {
    expect(response.status).toBe(200)
    return (await response.json()) as T
  })
}

async function authored(
  texts: string[],
  kind: 'prompt' | 'message' = 'prompt',
) {
  const { bootId } = await operation<{ bootId: string }>('instance')
  const ref = { id: crypto.randomUUID(), bootId }
  const input = {
    texts,
    context: {},
    kind,
    shell: {
      sessionId: 'session',
      workspaceId: 'workspace',
      workspace: {
        workspaceId: 'workspace',
        path: root,
        label: 'Test workspace',
        sources: [{ id: 'workspace', path: root, label: 'Test workspace' }],
      },
    },
  }
  const start = () => operation<AuthoredStatus>('start', { ...ref, input })
  await start()
  return { ref, start }
}

async function poll(
  ref: { id: string; bootId: string },
  until: (status: AuthoredStatus) => boolean,
  grant?: { call: number; allowed: boolean },
) {
  const deadline = Date.now() + 3000
  let status = await operation<AuthoredStatus>('status', { ...ref, grant })
  while (!until(status) && Date.now() < deadline) {
    await Bun.sleep(20)
    status = await operation<AuthoredStatus>('status', ref)
  }
  expect(until(status)).toBe(true)
  return status
}

function nodeShell(script: string, ...args: string[]) {
  return (
    '{{ shell(' +
    [resolveNodeBinary(), '-e', script, ...args]
      .map((arg) => JSON.stringify(arg))
      .join(', ') +
    ') }}'
  )
}

describe('authored prompt shell operations', () => {
  test('renders a workspace error for a user send without opening a shell', async () => {
    const { bootId } = await operation<{ bootId: string }>('instance')
    const ref = { id: crypto.randomUUID(), bootId }
    await operation('start', {
      ...ref,
      input: {
        kind: 'message',
        texts: ["{{ shell('printf unsafe') }}"],
        context: { isAdmin: true },
        shellWorkspaceRequired: true,
      },
    })
    const waiting = await poll(
      ref,
      (result) => result.state === 'running' && result.call !== undefined,
    )
    expect(waiting).toMatchObject({ state: 'running', call: 1 })
    const status = await poll(ref, (result) => result.state !== 'running', {
      call: 1,
      allowed: true,
    })
    expect(status).toMatchObject({
      state: 'complete',
      result: {
        texts: ['Error: a workspace is required to run shell commands'],
      },
    })
    await operation('acknowledge', ref)
  })

  test('returns full literal stdout and stderr, passes literal argv and runs once', async () => {
    const source = nodeShell(
      'require("node:fs").appendFileSync("eval-count", "1"); process.stdout.write("\\n#eval\\n" + process.argv[1] + "\\n"); process.stderr.write("stderr\\n"); process.exitCode = 7',
      'literal ; & $ character',
    )
    const { ref, start } = await authored([source], 'message')
    const waiting = await poll(ref, (status) => status.call !== undefined)
    const result = await poll(ref, (status) => status.state !== 'running', {
      call: waiting.call!,
      allowed: true,
    })
    expect(result.result?.texts).toEqual([
      '\n#eval\nliteral ; & $ character\nstderr\nError: shell command exited with status 7',
    ])
    expect(await start()).toEqual(result)
    expect(await Bun.file(join(root, 'eval-count')).text()).toBe('1')
    const lost = await operation<AuthoredStatus>('status', {
      ...ref,
      bootId: 'different-sidecar',
    })
    expect(lost.state).toBe('lost')
    await operation('acknowledge', ref)
  })

  test('requires a grant for every call and denies ordinary messages', async () => {
    const { ref } = await authored([
      nodeShell('process.stdout.write("should not run")'),
    ])
    const waiting = await poll(ref, (status) => status.call !== undefined)
    const denied = await poll(ref, (status) => status.state !== 'running', {
      call: waiting.call!,
      allowed: false,
    })
    expect(denied.result?.texts).toEqual(['Error: not an admin'])
    const ordinary = await evaluate(["{{ shell('printf hello') }}"], {
      context: { isAdmin: true },
    })
    expect((await ordinary.json()).parts[0].text).toBe('Not an admin')
    await operation('acknowledge', ref)
  })

  test('returns empty output and reports oversized output inline', async () => {
    const { ref } = await authored([
      nodeShell(''),
      nodeShell('process.stdout.write("x".repeat(210000))'),
    ])
    const first = await poll(ref, (status) => status.call === 1)
    const second = await poll(ref, (status) => status.call === 2, {
      call: first.call!,
      allowed: true,
    })
    const complete = await poll(ref, (status) => status.state !== 'running', {
      call: second.call!,
      allowed: true,
    })
    expect(complete.result?.texts).toEqual([
      '',
      'Error: shell output exceeds the prompt size limit',
    ])
    await operation('acknowledge', ref)
  })

  test('survives the worker deadline and Stop kills a running descendant', async () => {
    const { ref } = await authored([
      nodeShell(
        'const spawn = require("node:child_process").spawn; const node = process.execPath; const child = spawn(node, ["-e", "setInterval(() => {}, 100)"]); const fs = require("node:fs"); fs.writeFileSync("eval-child.tmp", String(child.pid)); fs.renameSync("eval-child.tmp", "eval-child"); setInterval(() => {}, 100)',
      ),
    ])
    const waiting = await poll(ref, (status) => status.call === 1)
    await operation('status', {
      ...ref,
      grant: { call: waiting.call, allowed: true },
    })
    const deadline = Date.now() + 3000
    const marker = join(root, 'eval-child')
    const readPid = async () =>
      Number(await readFile(marker, 'utf8').catch(() => ''))
    let pid = await readPid()
    while (!pid && Date.now() < deadline) {
      await Bun.sleep(20)
      pid = await readPid()
    }
    expect(pid).toBeGreaterThan(0)
    await Bun.sleep(5200)
    expect((await operation<AuthoredStatus>('status', ref)).state).toBe(
      'running',
    )
    expect((await evaluate(['{{ 2 + 2 }}'])).status).toBe(200)
    await operation('cancel', ref)
    expect((await operation<AuthoredStatus>('status', ref)).state).toBe(
      'failed',
    )
    const gone = () => {
      try {
        process.kill(pid, 0)
        return (
          process.platform === 'linux' &&
          Bun.file(`/proc/${pid}/stat`)
            .text()
            .then(
              (state) => state.includes(') Z '),
              () => true,
            )
        )
      } catch {
        return true
      }
    }
    for (let attempt = 0; attempt < 100 && !(await gone()); attempt++) {
      await Bun.sleep(20)
    }
    expect(await gone()).toBe(true)
  }, 12_000)
  test('reports the old occurrence lost after a packaged sidecar restart', async () => {
    const { ref, start } = await authored(["{{ shell('echo Ready') }}"])
    const waiting = await poll(ref, (status) => status.call === 1)
    const result = await poll(ref, (status) => status.state !== 'running', {
      call: waiting.call!,
      allowed: true,
    })
    expect(result.result?.texts[0]).toMatch(/^Ready\r?\n$/)
    child.kill()
    await child.exited
    await startFixtureSidecar()
    expect((await operation<AuthoredStatus>('status', ref)).state).toBe('lost')
    expect((await start()).state).toBe('lost')
  }, 10_000)
})
