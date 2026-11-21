import {
  adjectives,
  animals,
  uniqueNamesGenerator,
} from 'unique-names-generator'

export function attachmentNameSuffix(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '-',
  })
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function suffixFilename(filename: string, suffix: string | number) {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return `${filename}-${suffix}`
  return `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}`
}

export function namelessAttachment(mediaType: string): string {
  const [kind, subtype] = mediaType.split(';', 1)[0].toLowerCase().split('/')
  if (kind === 'text' && subtype === 'plain') return 'pasted-text.txt'

  const label = ['image', 'video', 'audio', 'text'].includes(kind)
    ? kind
    : 'file'
  const extension =
    {
      jpeg: 'jpg',
      'svg+xml': 'svg',
      plain: 'txt',
      quicktime: 'mov',
      mpeg: kind === 'audio' ? 'mp3' : 'mpeg',
      'octet-stream': 'bin',
    }[subtype] ?? (/^[a-z0-9]{1,10}$/.test(subtype ?? '') ? subtype : 'bin')

  return `pasted-${label}.${extension}`
}
