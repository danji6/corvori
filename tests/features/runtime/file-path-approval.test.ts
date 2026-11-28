import { buildApprovalActions } from '@/lib/chat/tool-approval-policy'
import { createOpenAI } from '@ai-sdk/openai'
import { alwaysLabel, approvalHold } from '@cv/convex/lib/tool/approvalPolicy'
import { rememberApproval } from '@cv/convex/model/chat/approvalMemory'
import { patchToolApproval } from '@cv/convex/model/chat/approvals'
import { getSessionWithWorkspace } from '@cv/convex/model/session/folderContext'
import { getApprovals } from '@cv/convex/model/session/state'
import { attachApprovalPreviews } from '@cv/convex/model/stream/engineApproval'
import { offloadToolOutputs } from '@cv/convex/model/stream/engineOutput'
import { buildProviderHistory } from '@cv/convex/model/stream/history'
import { OFFLOAD_THRESHOLD } from '@cv/convex/model/stream/toolOutput'
import type { WorkspaceToolContext } from '@cv/convex/model/tool/context'
import { replayLanguageModel } from '@cv/convex/model/tool/dispatchTransport'
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from '@cv/convex/model/tool/files'
import { callMcpTool } from '@cv/convex/model/tool/mcp'
import type { ToolApprovals } from '@cv/core/types'
import { withAgentHome } from '@cv/core/workspace/personal'
import {
  FILE_IMAGE_MAX_BYTES,
  type FileImageOutput,
  isFileImageOutput,
} from '@cv/core/workspace/read-image'
import { type UIMessage, streamText } from 'ai'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { ZodType } from 'zod'
import { SELF, providerData, stored } from '~/tests/helpers/provider-history'
import { captureStreamFetch } from '~/tests/helpers/provider-middleware'
import { skillsDatabase } from '~/tests/helpers/skills-db'
import { createTempDirectory } from '~/tests/helpers/temp-directory'

let root: string
let project: string
let outside: string
let server: ReturnType<typeof Bun.serve>
let context: WorkspaceToolContext
let approvals: ToolApprovals = {}
const previousUrl = process.env.SIDECAR_URL
const previousData = process.env.CHAT_SIDECAR_DATA_DIR
const options = { toolCallId: 'approved-file', messages: [], context: undefined as never } // prettier-ignore

beforeAll(async () => {
  root = await createTempDirectory('file-path-approval-')
  project = path.join(root, 'project')
  outside = path.join(root, 'outside')
  await mkdir(project)
  await mkdir(outside)
  await writeFile(path.join(outside, 'note'), 'external note')
  await symlink(outside, path.join(project, 'external'))
  process.env.CHAT_SIDECAR_DATA_DIR = path.join(root, 'data')
  const { handleMcpRequest } = await import('@cv/sidecar/mcp/mcp')
  const app = new Hono().all('/mcp', handleMcpRequest)
  server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) })
  process.env.SIDECAR_URL = `http://127.0.0.1:${server.port}`
  context = {
    sessionId: 'approved-file-session',
    ownerId: 'approved-file-session',
    workspaceId: 'project',
    workspace: {
      workspaceId: 'project',
      path: project,
      label: 'Project',
      sources: [{ id: 'project', path: project, label: 'Project' }],
    },
    approvals: async () => approvals,
  } as WorkspaceToolContext
})

afterAll(async () => {
  server?.stop(true)
  if (previousUrl === undefined) delete process.env.SIDECAR_URL
  else process.env.SIDECAR_URL = previousUrl
  if (previousData === undefined) delete process.env.CHAT_SIDECAR_DATA_DIR
  else process.env.CHAT_SIDECAR_DATA_DIR = previousData
  await rm(root, { recursive: true, force: true })
})

async function needsApproval(tool: unknown, input: unknown) {
  return (
    tool as { needsApproval: (input: unknown) => Promise<boolean> }
  ).needsApproval(input)
}

test('once-approved file calls read, write and edit outside without remembering access', async () => {
  const read = await createReadFileTool(context)
  const write = await createWriteFileTool(context)
  const edit = await createEditFileTool(context)
  const readInput = { path: 'external/note' }
  const writeInput = {
    path: path.join(outside, 'new', '$approved.txt'),
    content: 'first version',
  }
  const editInput = {
    path: '../outside/new/$approved.txt',
    edits: [{ oldText: 'first', newText: 'second' }],
  }

  for (const [tool, input] of [
    [read, readInput],
    [write, writeInput],
    [edit, editInput],
  ] as const) {
    const schema = tool.inputSchema as ZodType
    expect(schema.safeParse(input).success).toBe(true)
    expect(
      schema.safeParse({ ...input, allowOutsideWorkspace: true }).success,
    ).toBe(false)
  }

  expect(await needsApproval(read, readInput)).toBe(true)
  expect(await needsApproval(write, writeInput)).toBe(true)
  expect(await needsApproval(edit, editInput)).toBe(true)
  // Execution models Allow for this call, without adding a saved path grant.
  const result = await read.execute!(readInput, options)
  expect(JSON.parse(result as string).content).toBe('external note')
  await write.execute!(writeInput, options)
  await edit.execute!(editInput, options)
  expect(await readFile(writeInput.path, 'utf8')).toBe('second version')

  expect(approvals).toEqual({})
  expect(await needsApproval(read, readInput)).toBe(true)
  expect(await needsApproval(write, writeInput)).toBe(true)
  expect(await needsApproval(edit, editInput)).toBe(true)
  await expect(
    callMcpTool('read_file', {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      workspace: context.workspace,
      path: writeInput.path,
    }),
  ).rejects.toThrow('Path escapes the configured workspace')
})

test('unrestricted file execution reaches external files without a saved path grant', async () => {
  approvals = { mode: 'unrestricted' }
  try {
    const read = await createReadFileTool(context)
    const input = { path: path.join(outside, 'note') }
    expect(await needsApproval(read, input)).toBe(false)
    const result = await read.execute!(input, options)
    expect(JSON.parse(result as string).content).toBe('external note')
  } finally {
    approvals = {}
  }
})

const screenshotInput = { path: 'screenshot' }

async function writeScreenshot(width: number) {
  const png = await sharp({
    create: {
      width,
      height: 80,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer()
  await writeFile(path.join(project, screenshotInput.path), png)
}

test('read_file sends pixels to the next provider step and replays the saved snapshot', async () => {
  await writeScreenshot(1600)
  const read = await createReadFileTool(context)
  const output = await read.execute!(screenshotInput, options)
  if (!isFileImageOutput(output)) throw new Error('Expected an image')
  expect(output).toMatchObject({
    originalWidth: 1600,
    originalHeight: 80,
    width: 1536,
    height: 77,
  })
  expect(JSON.stringify(output).length).toBeLessThan(OFFLOAD_THRESHOLD)
  const { ctx, parts } = await storeScreenshot(output)

  await writeScreenshot(12)
  const current = await read.execute!(screenshotInput, options)
  expect(current).toMatchObject({ width: 12 })

  const history = await screenshotHistory(ctx, parts)
  await expectScreenshotOnProviderWire(history, output, true)

  for (const history of [
    await screenshotHistory(ctx, parts, { laterTurn: true }),
    await screenshotHistory(ctx, parts, { omitMedia: true }),
  ]) {
    const serialized = JSON.stringify(history)
    expect(serialized).toContain('"width":1536')
    expect(serialized).not.toContain(output.base64)
  }
})

test('read_file compresses a detailed screenshot before shrinking below 1000 pixels', async () => {
  const size = 1400
  const pixels = createHash('shake256', { outputLength: size ** 2 * 4 })
    .update('read-file-preview-test')
    .digest()
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
  const png = await sharp(pixels, {
    raw: { width: size, height: size, channels: 4 },
  })
    .png()
    .toBuffer()
  await writeFile(path.join(project, screenshotInput.path), png)

  const read = await createReadFileTool(context)
  const output = await read.execute!(screenshotInput, options)
  if (!isFileImageOutput(output)) throw new Error('Expected an image')
  expect(output).toMatchObject({
    originalWidth: size,
    originalHeight: size,
    mediaType: 'image/jpeg',
  })
  expect(output.width).toBeGreaterThanOrEqual(1000)
  expect(output.height).toBe(output.width)
  expect(Buffer.byteLength(output.base64, 'base64')).toBeLessThanOrEqual(
    FILE_IMAGE_MAX_BYTES,
  )
  const { ctx, parts } = await storeScreenshot(output)
  const history = await screenshotHistory(ctx, parts)
  await expectScreenshotOnProviderWire(history, output, false)
})

test('read_file preserves transparency when compacting a detailed PNG', async () => {
  const size = 1200
  const colors = [
    [14, 25, 41, 64],
    [10, 200, 70, 255],
    [200, 20, 40, 100],
    [21, 21, 21, 255],
  ]
  const indices = createHash('shake256', { outputLength: size ** 2 })
    .update('read-file-alpha-test')
    .digest()
  const pixels = Buffer.alloc(indices.length * 4)
  for (const [i, index] of indices.entries()) {
    pixels.set(colors[index % colors.length], i * 4)
  }
  const png = await sharp(pixels, {
    raw: { width: size, height: size, channels: 4 },
  })
    .png()
    .toBuffer()
  expect(png.length).toBeGreaterThan(FILE_IMAGE_MAX_BYTES)
  const input = { path: 'transparent-detail.png' }
  await writeFile(path.join(project, input.path), png)

  const read = await createReadFileTool(context)
  const output = await read.execute!(input, options)
  if (!isFileImageOutput(output)) throw new Error('Expected an image')
  expect(output).toMatchObject({
    mediaType: 'image/png',
    width: size,
    height: size,
  })
  const preview = Buffer.from(output.base64, 'base64')
  expect(preview.length).toBeLessThanOrEqual(FILE_IMAGE_MAX_BYTES)
  const stats = await sharp(preview).stats()
  expect(stats.channels[3]).toMatchObject({ min: 64, max: 255 })
})

async function storeScreenshot(output: FileImageOutput) {
  const part = {
    type: 'tool-read_file',
    state: 'output-available',
    toolCallId: 'call_screenshot',
    input: screenshotInput,
    output,
  } satisfies UIMessage['parts'][number]
  const blobs = new Map<string, Blob>()
  const ctx = {
    runMutation: async () => true,
    storage: {
      store: async (blob: Blob) => {
        blobs.set('screenshot-snapshot', blob)
        return 'screenshot-snapshot'
      },
      get: async (id: string) => blobs.get(id) ?? null,
    },
  } as never
  const parts = await offloadToolOutputs(
    ctx,
    [part],
    new Map(),
    { streamId: 'stream' as never, generation: 0 },
    'output' as never,
  )
  expect(parts[0]).toMatchObject({ outputRef: 'screenshot-snapshot' })
  expect(JSON.stringify(parts)).not.toContain(output.base64)
  return { ctx, parts }
}

async function expectScreenshotOnProviderWire(
  history: Awaited<ReturnType<typeof screenshotHistory>>,
  output: FileImageOutput,
  hasAlpha: boolean,
) {
  const bodies: Record<string, unknown>[] = []
  const provider = createOpenAI({
    apiKey: 'test',
    fetch: captureStreamFetch(bodies),
  })
  for (const model of [provider.responses('test'), provider.chat('test')]) {
    const wrapped = await replayLanguageModel(model, {
      wireDefinitions: [],
      wireCalls: new Map(),
    })
    await streamText({
      model: wrapped,
      messages: history,
      maxRetries: 0,
    }).consumeStream()
  }
  for (const [index, type] of ['input_image', 'image_url'].entries()) {
    const body = JSON.stringify(bodies[index])
    expect(body).toContain(`"type":"${type}"`)
    const imageData = new RegExp(
      `data:${output.mediaType};base64,([A-Za-z0-9+/=]+)`,
    )
    const data = body.match(imageData)?.[1]
    expect(data).toBe(output.base64)
    const image = await sharp(Buffer.from(data!, 'base64')).metadata()
    expect(image).toMatchObject({
      width: output.width,
      height: output.height,
      hasAlpha,
    })
  }
}

function screenshotHistory(
  ctx: Parameters<typeof buildProviderHistory>[0],
  parts: UIMessage['parts'],
  { laterTurn = false, omitMedia = false } = {},
) {
  const data: Parameters<typeof buildProviderHistory>[1] = providerData()
  if (laterTurn) data.stream.state.processingMessageId = 'next' as never
  data.stream.omitActiveMedia = omitMedia
  return buildProviderHistory(ctx, data, [], {
    toolNames: ['read_file'],
    historyRows: [
      {
        ...stored({ type: 'agent', id: SELF }, 'assistant'),
        _id: 'output' as never,
        parts,
      },
    ],
  })
}

test('checks access before decoding images and rejects invalid image reads', async () => {
  const read = await createReadFileTool(context)
  const corrupt = Buffer.from('89504e470d0a1a0a', 'hex')
  await writeFile(path.join(outside, 'corrupt.png'), corrupt)
  const external = { path: 'external/corrupt.png' }
  expect(await needsApproval(read, external)).toBe(true)
  await expect(
    callMcpTool('read_file', {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      workspace: context.workspace,
      ...external,
    }),
  ).rejects.toThrow('Path escapes the configured workspace')
  await expect(read.execute!(external, options)).rejects.toThrow(
    'Could not read image',
  )

  const filename = path.join(project, 'oversized.png')
  await writeFile(filename, corrupt)
  await truncate(filename, 20 * 1024 * 1024 + 1)
  await expect(
    read.execute!({ path: 'oversized.png' }, options),
  ).rejects.toThrow('20 MiB read limit')
  await expect(
    read.execute!({ path: 'oversized.png', limit: 1 }, options),
  ).rejects.toThrow('do not accept text paging')
})

test('read_file applies JPEG orientation and reads WebP and animated GIF', async () => {
  const jpeg = await sharp({
    create: { width: 4, height: 2, channels: 3, background: 'red' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const webp = await sharp(jpeg).webp().toBuffer()
  const gif = await sharp(
    Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]),
    { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } },
  )
    .gif()
    .toBuffer()

  const read = await createReadFileTool(context)
  for (const [name, bytes, width, height] of [
    ['rotated.jpg', jpeg, 2, 4],
    ['photo.webp', webp, 4, 2],
    ['animated.gif', gif, 2, 1],
  ] as const) {
    await writeFile(path.join(project, name), bytes)
    const output = await read.execute!({ path: name }, options)
    expect(output).toMatchObject({
      originalWidth: width,
      originalHeight: height,
      width,
      height,
    })
    if (name === 'animated.gif' && isFileImageOutput(output)) {
      const pixels = await sharp(Buffer.from(output.base64, 'base64'))
        .raw()
        .toBuffer()
      expect(Array.from(pixels.subarray(0, 3))).toEqual([255, 0, 0])
    }
  }
})

test('read_file preserves SVG text pagination', async () => {
  await writeFile(path.join(project, 'icon.svg'), '<svg>\n<path/>\n</svg>')
  const read = await createReadFileTool(context)
  const input = { path: 'icon.svg', limit: 1 }
  const first = JSON.parse((await read.execute!(input, options)) as string)
  expect(first).toMatchObject({ content: '<svg>', truncated: true })
  const second = await read.execute!(
    {
      ...input,
      byteOffset: first.nextByteOffset,
    },
    options,
  )
  expect(JSON.parse(second as string).content).toBe('<path/>')
})

async function sessionApprovalFixture(scope: 'project' | 'personal') {
  const database = skillsDatabase()
  const hasProject = scope === 'project'
  if (hasProject) {
    await database.db.insert('sessionFolders', {
      _id: context.workspaceId,
      ownerId: 'owner',
      name: 'Project',
      revision: 0,
      sources: context.workspace!.sources,
    })
  }
  await database.db.insert('sessions', {
    _id: context.sessionId,
    ownerId: 'owner',
    ...(hasProject && { folderId: context.workspaceId }),
  })
  const session = await getSessionWithWorkspace(database.ctx, context.sessionId)
  const liveApprovals = () => getApprovals(database.ctx, context.sessionId)
  const workspace = hasProject
    ? context.workspace!
    : withAgentHome(undefined, {
        agentId: 'agent',
        ownerId: 'owner',
        path: project,
        revision: 0,
      })
  return {
    ...database,
    session: session!,
    liveApprovals,
    toolContext: {
      ...context,
      workspace,
      workspaceId: workspace.workspaceId,
      approvals: liveApprovals,
    },
  }
}

test.each([
  ['read_file', 'project'],
  ['write_file', 'project'],
  ['edit_file', 'project'],
  ['shell', 'project'],
  ['read_file', 'personal'],
] as const)(
  '%s approval remembers the external path without broadening access (%s)',
  async (toolName, scope) => {
    const fixture = await sessionApprovalFixture(scope)
    const folderApproval = toolName === 'shell'
    const filePath =
      scope === 'personal'
        ? path.join(project, 'external/note')
        : 'external/note'
    const input = folderApproval
      ? { command: 'ls', cwd: outside }
      : { path: filePath }
    const grant = folderApproval ? outside : path.join(outside, 'note')
    const unapprovedPath = folderApproval
      ? path.join(root, 'outside-sibling', 'note')
      : path.join(outside, 'sibling')
    const setup = {
      stream: { sessionId: context.sessionId },
      workspaceSessionId: context.sessionId,
      workspace: fixture.toolContext.workspace,
      agent: {},
    } as Parameters<typeof attachApprovalPreviews>[1]
    const action = {
      runQuery: fixture.liveApprovals,
    } as unknown as Parameters<typeof attachApprovalPreviews>[0]
    const parts = await attachApprovalPreviews(action, setup, [
      {
        type: `tool-${toolName}`,
        toolCallId: options.toolCallId,
        state: 'approval-requested',
        approval: { id: 'file-approval' },
        input,
      },
    ])
    const request = parts[0] as (typeof parts)[number] & {
      approvalPathStatus?: 'paths'
      approvalPaths?: string[]
    }
    expect(request.approvalPaths).toEqual([grant])
    const hold = approvalHold(toolName, input, undefined, request.approvalPathStatus) // prettier-ignore
    const choices = buildApprovalActions(true, alwaysLabel(toolName, input, {}), hold) // prettier-ignore
    const remembered = choices.find((choice) => choice.remember)
    expect(remembered?.remember).toBe('paths')

    const { matched } = patchToolApproval(parts, {
      toolCallId: options.toolCallId,
      approved: true,
    })
    await rememberApproval(fixture.ctx, fixture.session, matched, remembered!.remember!) // prettier-ignore
    expect(await fixture.liveApprovals()).toEqual({
      paths: [grant],
    })
    for (const tool of await Promise.all([
      createReadFileTool(fixture.toolContext),
      createWriteFileTool(fixture.toolContext),
      createEditFileTool(fixture.toolContext),
    ])) {
      expect(await needsApproval(tool, { path: filePath })).toBe(false)
      expect(await needsApproval(tool, { path: unapprovedPath })).toBe(true)
      if (folderApproval) {
        expect(
          await needsApproval(tool, { path: path.join(outside, 'new/note') }),
        ).toBe(false)
        expect(
          await needsApproval(tool, {
            path: path.join(outside, '.git/config'),
          }),
        ).toBe(true)
      }
    }
  },
)
