/// <reference types="bun-types" />
import {
  attachmentRef,
  attachmentReference,
  attachmentShare,
  attachmentShareUrl,
  readUtf8Range,
  shouldAttachTextPaste,
} from '@cv/core/attachments'
import { markdownHttpLinks } from '@cv/core/utils/markdown-links'
import { describe, expect, test } from 'bun:test'

describe('durable attachment links', () => {
  test('round trips attachment IDs and encoded filenames', () => {
    const ref = attachmentRef('record1', 'notes (#1).txt')
    expect(ref).toBe('attachment:record1/notes%20%28%231%29.txt')
    expect(attachmentReference(ref)).toEqual({
      attachmentId: 'record1',
      filename: 'notes (#1).txt',
    })
    expect(attachmentReference('attachment:record1/%E0%A4%A')).toBeNull()
  })

  test('preserves the exact storage URL when adding and parsing a share hint', () => {
    const url = 'http://localhost:3210/api/storage/key?component=chat'
    const share = attachmentShareUrl(url, 'file1')
    expect(share).toBe(url + '#attachment=file1')
    expect(attachmentShare(share)).toEqual({ url, fileId: 'file1' })
    expect(attachmentShare(url)).toBeNull()
    expect(attachmentShare(share + '&x=other')).toBeNull()
  })

  test('locates shared URLs and ignores code', () => {
    const localUrl = 'http://localhost:3210/api/storage/key#attachment=file1'
    const external = 'https://example.test/attachment#attachment=file2'
    const text = [
      `See ${localUrl}.`,
      `[external link](${external})`,
      '`' + external + '`',
      '````text',
      external,
      '~~~',
      localUrl,
      '````',
    ].join('\n')
    expect(
      markdownHttpLinks(text).map(({ start, end, url }) => [
        text.slice(start, end),
        url,
      ]),
    ).toEqual([
      [localUrl, localUrl],
      [`[external link](${external})`, external],
    ])
  })
})

describe('large text pastes', () => {
  test('uses UTF-8 bytes at the 16 KiB boundary', () => {
    expect(shouldAttachTextPaste('x'.repeat(16 * 1024 - 1))).toBe(false)
    expect(shouldAttachTextPaste('x'.repeat(16 * 1024))).toBe(true)
    expect(shouldAttachTextPaste('🙂'.repeat(4096))).toBe(true)
  })

  test('keeps shell and slash commands inline', () => {
    const tail = 'x'.repeat(16 * 1024)
    expect(shouldAttachTextPaste(`/system ${tail}`)).toBe(false)
    expect(shouldAttachTextPaste(`$ echo ${tail}`)).toBe(false)
    expect(shouldAttachTextPaste(tail, true)).toBe(false)
  })
})

describe('readUtf8Range', () => {
  const bytes = new TextEncoder().encode('A🙂BéC')

  test('never splits a multi-byte code point', () => {
    expect(readUtf8Range(bytes, 1, 2)).toMatchObject({
      content: '🙂',
      offset: 1,
      endOffset: 5,
      nextOffset: 5,
      eof: false,
      truncated: true,
    })
  })

  test('advances an offset that points into a code point', () => {
    expect(readUtf8Range(bytes, 3, 3)).toMatchObject({
      content: 'Bé',
      offset: 5,
      endOffset: 8,
      nextOffset: 8,
    })
  })

  test('reports EOF with the authoritative byte length', () => {
    expect(readUtf8Range(bytes, 8, 64)).toEqual({
      content: 'C',
      offset: 8,
      endOffset: 9,
      nextOffset: null,
      totalBytes: 9,
      eof: true,
      truncated: false,
    })
  })

  test('honors large byte limits deterministically', () => {
    const large = new TextEncoder().encode('0123456789'.repeat(12_000))

    for (const limit of [300, 400, 1_200, 5_000, 20_000, 65_536]) {
      const first = readUtf8Range(large, 0, limit)
      const second = readUtf8Range(large, 0, limit)
      expect(new TextEncoder().encode(first.content)).toHaveLength(limit)
      expect(first).toEqual(second)
      expect(first.endOffset).toBe(limit)
      expect(first.nextOffset).toBe(limit)
      expect(first.truncated).toBe(true)
    }
  })
})
