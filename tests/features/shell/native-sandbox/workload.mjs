import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const [action, file] = process.argv.slice(2)

if (action === 'write') {
  writeFileSync(file, 'workspace output')
  console.log('workspace write complete')
} else if (action === 'scan') {
  for (const dir of readdirSync('tree')) {
    const parent = join('tree', dir)
    for (const name of readdirSync(parent)) readFileSync(join(parent, name))
  }
} else if (action === 'child') {
  const child = spawnSync(
    process.execPath,
    [import.meta.filename, 'read', file],
    {
      stdio: 'inherit',
    },
  )
  process.exitCode = child.status ?? 1
} else if (action === 'read') {
  // The entire workspace is a disposable fixture. Never print file contents.
  try {
    const contents = readFileSync(file, 'utf8')
    console.log(
      contents === 'fixture value' ? 'read allowed' : 'contents hidden',
    )
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) throw error
    console.log('read denied')
    process.exitCode = 42
  }
} else {
  throw new Error('Unknown fixture action')
}
