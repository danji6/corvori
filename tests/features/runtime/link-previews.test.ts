import type { Id } from '@cv/convex/_generated/dataModel'
import type { ActionCtx } from '@cv/convex/_generated/server'
import { loadLinkPreview } from '@cv/convex/model/linkPreviews/preview'
import {
  isPublicAddress,
  publicHttpUrl,
} from '@cv/convex/model/linkPreviews/publicHttp'
import {
  publishLinkPreview,
  readLinkPreviewWork,
} from '@cv/convex/model/linkPreviews/records'
import { loadSavedLinkPreviews } from '@cv/convex/model/linkPreviews/worker'
import {
  appendSegment,
  deleteVersions,
  finalizeTurn,
  insertMessage,
  replaceSelectedContent,
  setSegmentParts,
  setSelectedVersion,
} from '@cv/convex/model/messageContents'
import type {
  LinkPreviewJob,
  PublishLinkPreviewArgs,
} from '@cv/convex/validators/linkPreviews'
import { expect, test } from 'bun:test'
import { type FunctionReference, getFunctionName } from 'convex/server'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const url = 'https://example.com/article'
const nextUrl = 'https://example.com/another'
const text = (value: string) => ({ type: 'text', text: value })
const preview = { kind: 'website' as const, title: 'Article' }

async function fixture() {
  const { ctx: base, db, rows, scheduled } = skillsDatabase()
  const deleted: Id<'_storage'>[] = []
  const ctx = {
    ...base,
    storage: {
      delete: async (id: Id<'_storage'>) => {
        deleted.push(id)
      },
    } as typeof base.storage,
  }
  const sessionId = await ctx.db.insert('sessions', { ownerId: base.userId })
  const fields = {
    sessionId,
    sender: { type: 'user', id: base.userId } as const,
    senderName: 'Owner',
    role: 'user' as const,
  }
  const jobs = () =>
    scheduled.flatMap(({ reference, args }) =>
      getFunctionName(reference as FunctionReference<'action'>) ===
      'actions/messages:_loadLinkPreviews'
        ? [args as LinkPreviewJob]
        : [],
    )
  return { ctx, db, rows, fields, jobs, deleted }
}

test('limits preview connections to public addresses and ordinary HTTP URLs', async () => {
  for (const address of [
    '127.0.0.1',
    '10.20.30.40',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
  ]) {
    expect(isPublicAddress(address)).toBe(false)
  }
  expect(isPublicAddress('93.184.216.34')).toBe(true)
  expect(isPublicAddress('2606:4700::1')).toBe(true)
  expect(() => publicHttpUrl('file:///path')).toThrow()
  expect(() => publicHttpUrl('https://user:password@example.test')).toThrow()
  expect(await loadLinkPreview('http://127.0.0.1')).toBeNull()
})

test('saves the message before lookup and keeps an unchanged URL reserved or ready', async () => {
  const { ctx, fields, jobs } = await fixture()
  const { messageId, contentId } = await insertMessage(
    ctx,
    { ...fields, status: 'done' },
    [text(`${url} ${url}`)],
  )
  const message = (await ctx.db.get(messageId))!
  const [job] = jobs()
  expect(message.status).toBe('done')
  expect(await readLinkPreviewWork(ctx, job)).toEqual([url])

  for (const value of [`Read ${url}`, `[Read more](${url})`]) {
    const row = (await ctx.db.get(contentId))!
    await setSegmentParts(ctx, message, row, [text(value)])
    expect(jobs()).toEqual([job])
    if (value.startsWith('Read'))
      await publishLinkPreview(ctx, { ...job, url, preview })
  }

  expect((await ctx.db.get(contentId))?.linkPreviews).toEqual([
    { url, state: 'ready', ...preview },
  ])
  expect(await readLinkPreviewWork(ctx, job)).toEqual([])
})

test('the worker remembers an unavailable preview across edits to surrounding text', async () => {
  const { ctx, fields, jobs } = await fixture()
  const blocked = 'http://127.0.0.1'
  const { messageId, contentId } = await insertMessage(
    ctx,
    { ...fields, status: 'done' },
    [text(blocked)],
  )
  const [job] = jobs()
  const action = {
    runQuery: (_reference: unknown, args: LinkPreviewJob) =>
      readLinkPreviewWork(ctx, args),
    runMutation: (_reference: unknown, args: PublishLinkPreviewArgs) =>
      publishLinkPreview(ctx, args),
  } as unknown as ActionCtx

  await loadSavedLinkPreviews(action, job)
  await setSegmentParts(
    ctx,
    (await ctx.db.get(messageId))!,
    (await ctx.db.get(contentId))!,
    [text(`Read ${blocked}`)],
  )
  expect((await ctx.db.get(contentId))?.linkPreviews).toEqual([
    { url: blocked, state: 'unavailable' },
  ])
  expect(jobs()).toEqual([job])
})

test('rejects removed, re-added and deleted link results and releases their thumbnails', async () => {
  const { ctx, fields, jobs, deleted } = await fixture()
  const { messageId, contentId } = await insertMessage(
    ctx,
    { ...fields, status: 'done' },
    [text(url)],
  )
  const message = (await ctx.db.get(messageId))!
  const [old] = jobs()

  for (const value of [nextUrl, url]) {
    await setSegmentParts(ctx, message, (await ctx.db.get(contentId))!, [
      text(value),
    ])
  }
  const [, removed, current] = jobs()
  expect(await readLinkPreviewWork(ctx, old)).toEqual([])
  expect(await readLinkPreviewWork(ctx, removed)).toEqual([])
  const staleImage = 'stale' as Id<'_storage'>
  await publishLinkPreview(ctx, {
    ...old,
    url,
    preview: { ...preview, imageStorageId: staleImage },
  })
  expect(await readLinkPreviewWork(ctx, current)).toEqual([url])

  const savedImage = 'saved' as Id<'_storage'>
  await publishLinkPreview(ctx, {
    ...current,
    url,
    preview: { ...preview, imageStorageId: savedImage },
  })
  await deleteVersions(ctx, messageId)
  expect(await ctx.db.get(contentId)).toBeNull()

  const lateImage = 'late' as Id<'_storage'>
  await publishLinkPreview(ctx, {
    ...current,
    url,
    preview: { ...preview, imageStorageId: lateImage },
  })
  expect(deleted).toEqual([staleImage, savedImage, lateImage])
})

test('queues settled stream segments and evaluated text while skipping bulk inserts', async () => {
  const { ctx, fields, jobs } = await fixture()
  await insertMessage(
    ctx,
    { ...fields, status: 'done', skipLinkPreviews: true },
    [text(url)],
  )
  const { messageId, contentId } = await insertMessage(
    ctx,
    { ...fields, status: 'processing' },
    [text(url)],
  )
  const tailId = await appendSegment(ctx, (await ctx.db.get(contentId))!)
  const tail = (await ctx.db.get(tailId))!
  const message = (await ctx.db.get(messageId))!
  const placeholder = { ...text(nextUrl), evaluationPending: true }
  await setSegmentParts(ctx, message, tail, [placeholder])
  expect(jobs()).toEqual([])

  await finalizeTurn(ctx, { message, row: tail, parts: [placeholder] })
  const [first] = jobs()
  expect(jobs()).toHaveLength(1)
  expect(await readLinkPreviewWork(ctx, first)).toEqual([url])
  await setSegmentParts(ctx, (await ctx.db.get(messageId))!, tail, [
    text(nextUrl),
  ])
  expect(await readLinkPreviewWork(ctx, jobs()[1])).toEqual([nextUrl])
})

test('moves retained previews during a full edit without affecting another version', async () => {
  const { ctx, fields, jobs, deleted } = await fixture()
  const { messageId, contentId } = await insertMessage(
    ctx,
    { ...fields, status: 'processing' },
    [text(nextUrl)],
  )
  const tailId = await appendSegment(ctx, (await ctx.db.get(contentId))!)
  await finalizeTurn(ctx, {
    message: (await ctx.db.get(messageId))!,
    row: (await ctx.db.get(tailId))!,
    parts: [text(url)],
  })
  const savedImage = 'retained' as Id<'_storage'>
  await publishLinkPreview(ctx, {
    ...jobs()[1],
    url,
    preview: { ...preview, imageStorageId: savedImage },
  })
  await ctx.db.insert('messageContents', {
    messageId,
    sessionId: fields.sessionId,
    segmentIndex: 0,
    version: 2,
    parts: [text(nextUrl)],
  })
  const message = (await ctx.db.get(messageId))!
  await setSelectedVersion(ctx, message, 2)
  await setSelectedVersion(ctx, (await ctx.db.get(messageId))!, 1)
  await replaceSelectedContent(ctx, (await ctx.db.get(messageId))!, [
    text(`Keep ${url}`),
  ])
  expect(jobs()).toHaveLength(2)
  expect((await ctx.db.get(contentId))?.linkPreviews).toEqual([
    { url, state: 'ready', ...preview, imageStorageId: savedImage },
  ])
  expect(await ctx.db.get(tailId)).toBeNull()
  expect(deleted).toEqual([])
})
