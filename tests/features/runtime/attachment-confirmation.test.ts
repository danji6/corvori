import type { Id } from '@cv/convex/_generated/dataModel'
import type { ActionCtx } from '@cv/convex/_generated/server'
import { confirmImage } from '@cv/convex/actions/attachments'
import type { ConfirmedImage } from '@cv/convex/model/attachments/actions'
import type { ConfirmAttachmentArgs } from '@cv/convex/types'
import { expect, mock, test } from 'bun:test'
import { type FunctionReference, getFunctionName } from 'convex/server'

type ImageAction = {
  _handler: (
    ctx: ActionCtx,
    args: ConfirmAttachmentArgs,
  ) => Promise<ConfirmedImage>
}

const { _handler: confirm } = confirmImage as unknown as ImageAction
const args: ConfirmAttachmentArgs = {
  storageId: 'upload' as Id<'_storage'>,
  sessionId: 'session' as Id<'sessions'>,
  filename: 'pixel.png',
  mediaType: 'image/png',
}
const id = 'attachment' as Id<'attachments'>
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgMAAGsBAfwAAAAASUVORK5CYII='

function fixture() {
  const runQuery = mock(
    async (_ref: FunctionReference<'query', 'internal'>, _args: unknown) =>
      null,
  )
  const get = mock(async (_storageId: Id<'_storage'>) => {
    const bytes = Uint8Array.from(atob(png), (byte) => byte.charCodeAt(0))
    return new Blob([bytes], { type: args.mediaType })
  })
  const runMutation = mock(
    async (_ref: FunctionReference<'mutation', 'internal'>, _args: unknown) =>
      id,
  )
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'uploader' }) },
    runQuery,
    storage: { get },
    runMutation,
  } as unknown as ActionCtx

  return { ctx, runQuery, get, runMutation }
}

test('image confirmation checks membership before reading or confirming an upload', async () => {
  const { ctx, runQuery, get, runMutation } = fixture()
  const denied = new Error('Not a session member')
  runQuery.mockRejectedValueOnce(denied)

  await expect(confirm(ctx, args)).rejects.toBe(denied)

  expect(getFunctionName(runQuery.mock.calls[0]![0])).toBe(
    'sessions:_getMemberWorkspaceContext',
  )
  expect(runQuery.mock.calls[0]![1]).toEqual({
    sessionId: args.sessionId,
    subject: 'uploader',
  })
  expect(get).not.toHaveBeenCalled()
  expect(runMutation).not.toHaveBeenCalled()
})

test('image confirmation forwards the stored image dimensions to the mutation', async () => {
  const { ctx, get, runMutation } = fixture()
  const imageDimensions = { width: 1, height: 1 }

  await expect(confirm(ctx, args)).resolves.toEqual({ id, imageDimensions })

  expect(get).toHaveBeenCalledWith(args.storageId)
  expect(getFunctionName(runMutation.mock.calls[0]![0])).toBe(
    'attachments:_confirmWithDimensions',
  )
  expect(runMutation.mock.calls[0]![1]).toEqual({ ...args, imageDimensions })
})
