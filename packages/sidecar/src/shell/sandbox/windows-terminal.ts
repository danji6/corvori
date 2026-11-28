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
  const ended = child
    .wait()
    .then(
      (result) => result.exitCode,
      () => null,
    )
    .finally(() => child.dispose())
  return {
    mode: 'pty',
    pid: child.id,
    onData: (cb) => {
      output.on('data', cb)
    },
    onExit: (cb) => {
      void ended.then(cb)
    },
    write: (data) => {
      input.write(data)
    },
    resize: (columns, rows) => child.resize({ columns, rows }),
    kill: () => child.kill(),
  }
}
