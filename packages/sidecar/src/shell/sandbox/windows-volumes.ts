import { stat } from 'node:fs/promises'

/** Give the container read-only access to the host's mounted drive letters. */
export async function mountedDrives() {
  const letters = Array.from(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    (letter) => letter + ':\\',
  )
  const drives = await Promise.all(
    letters.map(async (root) => {
      try {
        return (await stat(root)).isDirectory() ? root : undefined
      } catch (error) {
        if (
          ![
            'ENOENT',
            'ENODEV',
            'EACCES',
            'EPERM',
            'EBUSY',
            'EIO',
            'UNKNOWN',
          ].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error
      }
    }),
  )
  return drives.filter((drive): drive is string => !!drive)
}
