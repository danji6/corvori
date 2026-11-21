import { loadLinkPreview } from '@cv/convex/model/linkPreviews/preview'
import {
  isPublicAddress,
  publicHttpUrl,
} from '@cv/convex/model/linkPreviews/publicHttp'
import { expect, test } from 'bun:test'

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
