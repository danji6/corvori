import type { Id } from '@cv/convex/_generated/dataModel'
import {
  duplicateAuthorProfiles,
  removeAuthorProfiles,
} from '@cv/convex/model/session/authorProfileLifecycle'
import {
  confirmProfileAvatar,
  getEditableProfile,
  getProfile,
  updateProfile,
} from '@cv/convex/model/session/authorProfiles'
import type { MessageSender } from '@cv/convex/validators/messages'
import { describe, expect, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const sessionId = 'session' as Id<'sessions'>
const otherSession = 'other-session' as Id<'sessions'>
const updatedGlobalAvatar = 'global2' as Id<'avatars'>
const owner = { type: 'user', id: 'owner' } as MessageSender
const member = { type: 'user', id: 'member' } as MessageSender
const agent = { type: 'agent', id: 'agent' } as MessageSender
const archived = { type: 'archived', id: 'archived' } as MessageSender

function fixture() {
  const { ctx, rows, db } = skillsDatabase()
  const deleted: string[] = []
  const authed = {
    ...ctx,
    storage: {
      delete: async (id: string) => void deleted.push(id),
    } as typeof ctx.storage,
  }
  rows('users').push({ _id: 'owner', subject: 'owner' })
  rows('sessions').push(
    { _id: sessionId, ownerId: owner.id },
    { _id: otherSession, ownerId: owner.id },
  )
  rows('userSessions').push(
    { _id: '1', sessionId, userId: owner.id },
    { _id: '2', sessionId, userId: member.id },
    { _id: '3', sessionId: otherSession, userId: owner.id },
  )
  rows('settings').push({
    _id: 'settings',
    ownerId: owner.id,
    displayName: 'Ada',
    avatarId: 'global',
  })
  rows('agents').push({
    _id: agent.id,
    ownerId: member.id,
    name: 'Original agent',
  })
  rows('sessionAgents').push({ _id: 'link', sessionId, agentId: agent.id })
  rows('sessionAuthors').push({
    _id: archived.id,
    sessionId,
    name: 'From archive',
    kind: 'agent',
  })
  return { ctx: authed, rows, db, deleted }
}

describe('session author profiles', () => {
  test('inherits live fields independently and resets only the requested field', async () => {
    const { ctx, db, rows, deleted } = fixture()
    const target = { sessionId, sender: owner }
    await updateProfile(ctx, { ...target, name: '  In this chat ' })
    await db.patch('settings', {
      displayName: 'Renamed',
      avatarId: updatedGlobalAvatar,
    })

    expect(await getProfile(ctx, target)).toEqual({
      kind: 'user',
      name: 'In this chat',
      avatarId: updatedGlobalAvatar,
    })
    expect(
      await getProfile(ctx, { ...target, sessionId: otherSession }),
    ).toMatchObject({
      name: 'Renamed',
      avatarId: updatedGlobalAvatar,
    })

    const avatarId = await confirmProfileAvatar(ctx, {
      ...target,
      subject: 'owner',
      name: null,
      originalStorageId: 'original' as Id<'_storage'>,
      thumbStorageId: 'thumbnail' as Id<'_storage'>,
    })
    expect(await getProfile(ctx, target)).toMatchObject({
      name: 'Renamed',
      avatarId,
    })
    await updateProfile(ctx, { ...target, resetAvatar: true })
    expect(await getProfile(ctx, target)).toMatchObject({
      name: 'Renamed',
      avatarId: updatedGlobalAvatar,
    })
    expect(rows('sessionProfiles')).toEqual([])
    expect(deleted).toEqual(['original', 'thumbnail'])
  })

  test('allows edits by the profile owner and keeps historical profiles readable after unlink or leave', async () => {
    const { ctx, db, rows } = fixture()
    const memberCtx = { ...ctx, userId: member.id as Id<'users'> }
    const target = { sessionId, sender: agent }

    await expect(
      updateProfile(ctx, { ...target, name: 'Owned by another member' }),
    ).rejects.toThrow('Forbidden')
    await expect(
      updateProfile(ctx, { sessionId, sender: member, name: 'Another member' }),
    ).rejects.toThrow('Forbidden')
    await expect(
      updateProfile(memberCtx, {
        sessionId,
        sender: archived,
        name: 'Another owner',
      }),
    ).rejects.toThrow('Forbidden')
    expect(
      await getEditableProfile(ctx, {
        sessionId: otherSession,
        sender: archived,
      }),
    ).toBeNull()
    await updateProfile(memberCtx, { ...target, name: 'Agent in this chat' })

    rows('messages').push({ _id: 'historical', sessionId, sender: agent })
    rows('messages').push({
      _id: 'reply',
      sessionId,
      sender: owner,
      replyTo: { sender: member },
    })
    await db.delete('link')
    await db.delete('2')
    await db.insert('settings', {
      ownerId: member.id,
      displayName: 'Former member',
    })
    expect(await getProfile(ctx, target)).toMatchObject({
      name: 'Agent in this chat',
    })
    expect(await getProfile(ctx, { sessionId, sender: member })).toMatchObject({
      name: 'Former member',
    })
    expect(
      await getProfile(ctx, { sessionId: otherSession, sender: agent }),
    ).toBeNull()
    await expect(
      updateProfile(memberCtx, { ...target, name: 'After unlink' }),
    ).rejects.toThrow('Forbidden')

    await updateProfile(ctx, {
      sessionId,
      sender: archived,
      name: 'Edited archive',
    })
    expect(
      await getProfile(ctx, { sessionId, sender: archived }),
    ).toMatchObject({ name: 'Edited archive' })
    expect(
      await getProfile(ctx, { sessionId: otherSession, sender: archived }),
    ).toBeNull()
  })

  test('copies profiles independently and releases shared avatars after the last reference', async () => {
    const { ctx, rows, deleted } = fixture()
    rows('avatars').push({
      _id: 'shared',
      storageId: 'png',
      thumbStorageId: 'png',
    })
    rows('sessionAuthors')[0].avatarId = 'shared'
    await updateProfile(ctx, { sessionId, sender: owner, name: 'Session name' })

    const remap = await duplicateAuthorProfiles(ctx, sessionId, otherSession)
    const copy = remap(archived)
    expect(copy).not.toEqual(archived)
    await updateProfile(ctx, {
      sessionId: otherSession,
      sender: copy,
      name: 'Copy name',
    })
    expect(
      await getProfile(ctx, { sessionId, sender: archived }),
    ).toMatchObject({ name: 'From archive' })
    expect(
      await getProfile(ctx, { sessionId: otherSession, sender: owner }),
    ).toMatchObject({ name: 'Session name' })

    await removeAuthorProfiles(ctx, sessionId)
    expect(deleted).toEqual([])
    await removeAuthorProfiles(ctx, otherSession)
    expect(deleted).toEqual(['png'])
    expect(rows('avatars')).toEqual([])
  })
})
