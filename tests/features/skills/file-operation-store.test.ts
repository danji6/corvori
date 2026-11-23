import { fileOperationStore } from '@/lib/chat/file-operation-store'
import type { Id } from '@cv/convex/_generated/dataModel'
import { expect, test } from 'bun:test'
import { setupDom } from '~/tests/setup/dom'

setupDom()

test('recovers a pending operation only for the account and target that saved it', () => {
  const id = 'operation' as Id<'agentFileOperations'>
  localStorage.setItem('corvori-active-agent-files:owner:library', id)

  const owner = fileOperationStore('owner', 'library')
  expect(owner.read()).toMatchObject({ id, pending: true, restoring: true })
  expect(fileOperationStore('other', 'library').read().id).toBeUndefined()
  expect(fileOperationStore('owner', 'other-target').read().id).toBeUndefined()

  owner.update({ pending: false })
  expect(
    localStorage.getItem('corvori-active-agent-files:owner:library'),
  ).toBeNull()
})
