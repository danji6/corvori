import { buildSidecar, resolveNodeBinary } from '~/scripts/sidecar'

let packaged: ReturnType<typeof buildSidecar> | undefined

/** Start the packaged Node sidecar with a fresh authority and wait until its HTTP server answers. */
export async function nativeShellSidecar(
  directory: string,
  mode: 'pipe' | 'pty',
  cli?: { CORVORI_GH_BINARY: string; GH_TOKEN: string },
) {
  const entry = await (packaged ??= buildSidecar())
  const reservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  const port = reservation.port!
  reservation.stop(true)
  const url = 'http://127.0.0.1:' + port
  const child = Bun.spawn([resolveNodeBinary(), entry], {
    env: {
      ...cli,
      ...(process.platform === 'win32' && {
        ProgramFiles: process.env.ProgramFiles,
        SystemRoot: process.env.SystemRoot,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      }),
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      SIDECAR_SECRET: 'corvori-test-sidecar-credential',
      MCP_PORT: String(port),
      CHAT_SIDECAR_DATA_DIR: directory,
      CHAT_JOB_MODE: mode,
    },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  const close = async () => {
    child.kill()
    await child.exited
  }
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break
    if (
      await fetch(url + '/health')
        .then((r) => r.ok)
        .catch(() => false)
    )
      return { url, close }
    await Bun.sleep(50)
  }
  await close()
  throw new Error('Packaged shell sidecar did not start')
}
