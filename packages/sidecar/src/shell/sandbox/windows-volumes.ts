import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Include named local volumes, directory mount points, and mapped drive letters. */
export async function windowsVolumes(system: string) {
  const system32 = join(system, 'System32')
  const { stdout } = await execute(join(system32, 'mountvol.exe'), [], {
    cwd: system32,
    env: { SystemRoot: system, PATH: system32 },
    timeout: 5000,
    windowsHide: true,
  })
  const paths = stdout.split(/\r?\n/).map((line) => line.trim())
  const volumes = paths.filter((path) =>
    /^\\\\\?\\Volume\{[\da-f-]{36}\}\\$/i.test(path),
  )
  if (!volumes.length)
    throw new Error('Windows did not report its local volumes')
  const mounted = paths.filter((path) => /^[a-z]:\\.*\\?$/i.test(path))
  const letters: string[] = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\'
    try {
      await stat(root)
      letters.push(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { letters, denied: [...new Set([...letters, ...mounted, ...volumes])] }
}
