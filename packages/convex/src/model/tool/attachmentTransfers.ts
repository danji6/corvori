'use node'

import { TOOL_DESCRIPTIONS } from '@cv/core/types/tool-descriptions'
import { suffixFilename } from '@cv/core/utils/attachment-names'

import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { ToolError } from '../../errors'
import { type StreamExecutionArgs } from '../../types'
import { type TransferResult, transferTarget } from '../attachmentTransfers'
import { postSidecar } from '../sidecar'
import { findAttachment } from './attachments'

type Operation = Doc<'attachmentTransfers'>

type CopyInput = { reference: string; destination?: string }

type PublishInput = { path: string; filename?: string }

type Invocation = {
  ctx: ActionCtx
  execution: StreamExecutionArgs
  callId: string
  signal?: AbortSignal
}

export async function createAttachmentTransferTool(
  name: Operation['kind'],
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])

  if (name === 'copy_attachment') {
    return tool({
      description: TOOL_DESCRIPTIONS.copy_attachment,
      inputSchema: z.strictObject({
        reference: z.string().min(1).describe('Session attachment reference'),
        destination: z
          .string()
          .min(1)
          .optional()
          .describe('Optional full session:// destination file path'),
      }),
      execute: (input, { toolCallId, abortSignal }) =>
        copyAttachment(
          { ctx, execution, callId: toolCallId, signal: abortSignal },
          input,
        ),
    })
  }

  return tool({
    description: TOOL_DESCRIPTIONS.attach_file,
    inputSchema: z.strictObject({
      path: z.string().min(1).describe('The session:// file to publish'),
      filename: z
        .string()
        .min(1)
        .optional()
        .describe('Name displayed on the attachment'),
    }),
    execute: (input, { toolCallId, abortSignal }) =>
      attachFile(
        { ctx, execution, callId: toolCallId, signal: abortSignal },
        input,
      ),
  })
}

const DEFAULT_COPY_DIRECTORY = 'session://attachments/'

type CopyOutcome = { status: 'committed' | 'occupied' }
type CopyCheckpoint = { result: TransferResult } | { outcome: CopyOutcome }

async function copyAttachment(
  call: Invocation,
  input: CopyInput,
): Promise<TransferResult> {
  const { ctx, execution } = call
  const { file, reference } = await findAttachment(
    ctx,
    input.reference,
    execution,
  )
  const filename = safeFilename(file.filename)
  const operation = await begin(
    call,
    'copy_attachment',
    [reference, input.destination],
    input.destination ?? DEFAULT_COPY_DIRECTORY + filename,
  )
  if (operation.result) return operation.result

  await stageCopy(call, operation, file)
  const result = await commitCopy(
    call,
    operation,
    {
      reference,
      filename: file.filename,
      byteLength: file.byteLength,
      mediaType: file.mediaType,
    },
    input.destination === undefined ? filename : undefined,
  )

  // Remove the private hard link before a subsequent tool can publish this file.
  await postSidecar('/session-files/cleanup-transfer', {
    operationId: operation._id,
    discardUpload: false,
  }).catch(() => {})
  return result
}

async function stageCopy(
  { ctx, signal }: Invocation,
  operation: Operation,
  file: Pick<Doc<'attachmentFiles'>, 'storageId' | 'byteLength'>,
) {
  const url = await ctx.storage.getUrl(file.storageId)
  if (!url) throw new ToolError('Attachment data is no longer available')
  await postSidecar(
    '/session-files/stage-copy',
    { ...transferTarget(operation), url, byteLength: file.byteLength },
    signal,
  )
}

async function commitCopy(
  call: Invocation,
  operation: Operation,
  result: TransferResult,
  autoFilename?: string,
): Promise<TransferResult> {
  const { ctx, execution, signal } = call
  let current = operation

  for (;;) {
    signal?.throwIfAborted()
    if (current.result) return current.result

    const path = current.path!
    const args = { ...execution, id: current._id }
    const checkpoint = await commitCopyCandidate(call, current, path)
    if ('result' in checkpoint) return checkpoint.result

    const { outcome } = checkpoint
    if (outcome.status === 'committed') {
      return ctx.runMutation(internal.attachments._finishCopy, {
        ...args,
        result: { ...result, path },
      })
    }
    if (outcome.status !== 'occupied')
      throw new ToolError('Could not confirm the attachment copy')
    if (!autoFilename) {
      await ctx.runMutation(internal.attachments._abandonTransfer, args)
      throw new ToolError('The destination file already exists')
    }

    current = await ctx.runMutation(internal.attachments._advanceCopyPath, {
      ...args,
      previousPath: path,
      nextPath: nextCopyPath(path, autoFilename),
    })
  }
}

async function commitCopyCandidate(
  { ctx, execution, signal }: Invocation,
  operation: Operation,
  path: string,
): Promise<CopyCheckpoint> {
  const args = { ...execution, id: operation._id, path }

  const commit = () =>
    postSidecar<CopyOutcome>(
      '/session-files/commit-copy',
      transferTarget(operation),
      signal,
    )

  const saved = await ctx.runQuery(internal.attachments._assertTransfer, args)
  if (saved) return { result: saved }

  let outcome
  try {
    outcome = await commit()
  } catch {
    signal?.throwIfAborted()
    const result = await ctx.runQuery(
      internal.attachments._assertTransfer,
      args,
    )
    if (result) return { result }
    outcome = await commit()
  }
  signal?.throwIfAborted()
  return { outcome }
}

function nextCopyPath(path: string, filename: string) {
  const candidate = path.slice(DEFAULT_COPY_DIRECTORY.length)
  const dot = filename.lastIndexOf('.')
  const stemLength = dot > 0 ? dot : filename.length
  const extensionLength = filename.length - stemLength
  const previous =
    candidate === filename
      ? 1
      : Number(
          candidate.slice(stemLength + 1, candidate.length - extensionLength),
        )
  return DEFAULT_COPY_DIRECTORY + suffixFilename(filename, previous + 1)
}

async function attachFile(
  call: Invocation,
  input: PublishInput,
): Promise<TransferResult> {
  const { ctx, execution, signal } = call

  const operation = await begin(
    call,
    'attach_file',
    [input.path, input.filename],
    input.path,
  )
  if (operation.result) return operation.result

  return runTransfer(call, operation, async () => {
    const url = await ctx.storage.generateUploadUrl()
    const uploaded = await postSidecar<{
      storageId: Id<'_storage'>
      filename: string
      mediaType: string
    }>(
      '/session-files/publish',
      {
        ...transferTarget(operation),
        url,
        filename: input.filename,
      },
      signal,
    )
    signal?.throwIfAborted()
    const imageDimensions = await publishedImageDimensions(ctx, uploaded)
    signal?.throwIfAborted()
    return ctx.runMutation(internal.attachments._finishPublish, {
      ...execution,
      id: operation._id,
      ...uploaded,
      imageDimensions,
    })
  })
}

async function publishedImageDimensions(
  ctx: ActionCtx,
  { storageId, mediaType }: { storageId: Id<'_storage'>; mediaType: string },
) {
  if (!mediaType.startsWith('image/')) return

  const { readStoredAttachmentImageDimensions } =
    await import('../../actions/io/attachmentImage')
  return readStoredAttachmentImageDimensions(ctx.storage, storageId)
}

async function runTransfer(
  { ctx, execution }: Invocation,
  operation: Operation,
  transfer: () => Promise<TransferResult>,
) {
  try {
    return await transfer()
  } catch (error) {
    await ctx
      .runMutation(internal.attachments._abandonTransfer, {
        ...execution,
        id: operation._id,
      })
      .catch(() => {})
    throw error
  }
}

function begin(
  { ctx, execution, callId }: Invocation,
  kind: Operation['kind'],
  args: unknown[],
  path: string,
) {
  return ctx.runMutation(internal.attachments._beginTransfer, {
    ...execution,
    callId,
    kind,
    request: JSON.stringify(args),
    path,
  })
}

function safeFilename(value: string) {
  const name = value.replace(/[/\\:\p{Cc}]/gu, '_')
  return name.trim() && name !== '.' && name !== '..' ? name : 'attachment'
}
