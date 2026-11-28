import type { ContainerRequest } from '@microsoft/mxc-sdk/v1'

import type { ShellJobProcess } from '../pty'

/** Let MXC own the single terminal and report its workload's exit to the sidecar. */
export async function windowsTerminal(
  request: ContainerRequest,
  columns: number,
  rows: number,
): Promise<ShellJobProcess> {
  const { spawnWithPty } = await import('@microsoft/mxc-sdk/v1')
  const child = await spawnWithPty(request, { size: { rows, columns } })
  const input = child.input
  const output = child.output.setEncoding('utf8')
  let active = true
  const ended = child
    .wait()
    .then(
      (result) => result.exitCode,
      () => null,
    )
    .finally(() => {
      active = false
      child.dispose()
    })
  return {
    mode: 'pty',
    pid: child.id,
    onData: (cb) => {
      output.on('data', cb)
    },
    onExit: (cb) => {
      void ended.then(cb, () => cb(null))
    },
    write: (data) => {
      if (active) input.write(data)
    },
    resize: (columns, rows) => {
      if (active) child.resize({ columns, rows })
    },
    kill: () => {
      if (active) child.kill()
    },
  }
}
