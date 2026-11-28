import { stat } from 'node:fs/promises'

/** Give the container read-only access to the host's mounted drive letters. */
export async function mountedDrives() {
  const letters = Array.from(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    (letter) => letter + ':\\',
  )
  const drives = await Promise.all(
    letters.map(async (root) => {
      const info = await stat(root).catch(() => undefined)
      return info?.isDirectory() ? root : undefined
    }),
  )
  return drives.filter((drive): drive is string => !!drive)
}
