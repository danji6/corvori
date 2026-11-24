import type { Id } from '@cv/convex/_generated/dataModel'
import {
  confirm,
  getToolFile,
  getUrlMap,
} from '@cv/convex/model/attachments/files'
import { sendMessage } from '@cv/convex/model/chat/send'
import { previewShares } from '@cv/convex/model/chat/sharedAttachments'
import { attachmentShareUrl } from '@cv/core/attachments'
import { expect, spyOn, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const sessionId = 'destination' as Id<'sessions'>
const owner = 'owner' as Id<'users'>
const nativeUrl = 'https://storage.example.test/api/storage/key'
const sharedUrl = attachmentShareUrl(nativeUrl, 'file1')

function fixture() {
  const { ctx, db, rows } = skillsDatabase()
  const getUrl = spyOn(
    {
      storageUrl: async (_id: string) => nativeUrl,
    },
    'storageUrl',
  )
  Object.assign(ctx, { storage: { getUrl } })
  Object.assign(db, { system: { get: async () => ({ size: 20 }) } })
  rows('sessions').push({ _id: sessionId, ownerId: owner })
  rows('userSessions').push({
    _id: 'member',
    sessionId,
    userId: owner,
    role: 'owner',
  })
  rows('attachmentFiles').push({
    _id: 'file1',
    filename: 'Logo.png',
    storageId: 'blob',
    mediaType: 'image/png',
    byteLength: 20,
  })
  rows('attachments').push({
    _id: 'sourceAttachment',
    sessionId: 'other',
    fileId: 'file1',
    filename: 'Logo.png',
  })
  return { ctx, db, rows, getUrl }
}

test('saves shared URLs as session-local attachments and opens them after a host change', async () => {
  const { ctx, rows, getUrl } = fixture()
  const clientSendId = 'f8f3dd4b-f817-4c9b-bb92-c6605f1d7458'
  const messageId = await sendMessage(ctx, {
    sessionId,
    clientSendId,
    content: sharedUrl + ' ' + sharedUrl,
    silent: true,
  })
  const [card] = rows('attachments').slice(1)
  expect(rows('messages')).toContainEqual(
    expect.objectContaining({ _id: messageId, clientSendId }),
  )
  expect(card).toMatchObject({ fileId: 'file1', sessionId, messageId })
  expect(rows('attachmentFiles')).toHaveLength(1)
  expect(rows('attachments')).toHaveLength(2)
  expect(rows('messageContents')[0].parts).toEqual([
    expect.objectContaining({
      type: 'file',
      filename: 'Logo.png',
      attachmentId: card._id,
    }),
  ])
  expect(getUrl).toHaveBeenCalledTimes(1)

  const execution = { streamId: 'stream' as Id<'streams'>, generation: 1 }
  rows('streams').push({
    _id: execution.streamId,
    generation: 1,
    sessionId,
    invokedBy: owner,
    state: { phase: 'streaming' },
  })
  expect(
    await getToolFile(ctx, { ...execution, attachmentId: card._id }),
  ).toMatchObject({ _id: 'file1', storageId: 'blob' })
  expect(
    await getToolFile(ctx, { ...execution, attachmentId: 'sourceAttachment' }),
  ).toBeNull()

  const newUrl = nativeUrl.replace('storage.example.test', 'new.example.test')
  getUrl.mockResolvedValue(newUrl)
  const urls = await getUrlMap(ctx, { ids: [card._id] })
  expect(urls[card._id]).toMatchObject({
    url: newUrl,
    shareUrl: attachmentShareUrl(newUrl, 'file1'),
  })
})

test('rejects reused send IDs within a session before creating another message', async () => {
  const { ctx, rows } = fixture()
  const args = {
    sessionId,
    clientSendId: '610031e7-6f1a-44e4-bfc2-74422201d6b1',
    content: 'Hello',
    silent: true,
  }
  await sendMessage(ctx, args)
  await expect(sendMessage(ctx, args)).rejects.toThrow(
    'Client send ID is already in use',
  )
  expect(rows('messages')).toHaveLength(1)
})

test('removes only verified links and leaves other links in place', async () => {
  const { ctx, rows } = fixture()
  const forged = sharedUrl.replace('/key', '/other')
  const code = '\x60' + sharedUrl + '\x60'
  await sendMessage(ctx, {
    sessionId,
    content: `Look at [this](${sharedUrl}) today. ${forged} ${nativeUrl} ${code}`,
    silent: true,
  })
  expect(rows('messageContents')[0].parts).toEqual([
    expect.objectContaining({ type: 'file', filename: 'Logo.png' }),
    { type: 'text', text: `Look at today. ${forged} ${nativeUrl} ${code}` },
  ])
})

test('previews and sends pasted attachment cards without uploading a file', async () => {
  const { ctx, rows, getUrl } = fixture()
  const forged = sharedUrl.replace('/key', '/other')
  expect(
    await previewShares(ctx, { urls: [forged, sharedUrl, sharedUrl] }),
  ).toEqual([
    null,
    expect.objectContaining({
      filename: 'Logo.png',
      fileId: 'file1',
      shareUrl: sharedUrl,
      url: nativeUrl,
    }),
  ])
  expect(rows('attachments')).toHaveLength(1)

  await expect(
    sendMessage(ctx, {
      sessionId,
      content: '',
      attachments: [{ shareUrl: forged }],
      silent: true,
    }),
  ).rejects.toThrow('Shared attachment is no longer available')
  expect(rows('attachments')).toHaveLength(1)

  getUrl.mockClear()
  await sendMessage(ctx, {
    sessionId,
    content: '',
    attachments: [{ shareUrl: sharedUrl }, { shareUrl: sharedUrl }],
    silent: true,
  })
  expect(rows('attachments')).toHaveLength(2)
  expect(rows('attachmentFiles')).toHaveLength(1)
  expect(rows('messageContents')[0].parts).toEqual([
    expect.objectContaining({ type: 'file', filename: 'Logo.png' }),
  ])
  expect(getUrl).toHaveBeenCalledTimes(1)
})

test('reserves names within the destination session and retries deterministic clashes', async () => {
  const { ctx, rows } = fixture()
  const random = spyOn(Math, 'random').mockReturnValue(0.5)
  const input = {
    sessionId,
    storageId: 'newblob' as Id<'_storage'>,
    filename: 'Logo.png',
    mediaType: 'image/png',
  }
  try {
    for (let i = 0; i < 3; i++) await confirm(ctx, input, owner)
    await confirm(ctx, { ...input, filename: '' }, owner)
    const names = rows('attachments')
      .slice(1)
      .map(({ filename }) => filename)
    expect(names[0]).toBe('Logo.png')
    expect(names[1]).toMatch(/^Logo-[a-z]+(?:-[a-z]+)+\.png$/)
    expect(names[2]).toBe(String(names[1]).replace('.png', '-2.png'))
    expect(names[3]).toMatch(/^pasted-image-[a-z]+(?:-[a-z]+)+\.png$/)
  } finally {
    random.mockRestore()
  }
})
