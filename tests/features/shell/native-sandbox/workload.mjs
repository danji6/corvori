import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const [action, file] = process.argv.slice(2)

if (action === 'write') {
  writeFileSync(file, 'workspace output')
  console.log('workspace write complete')
} else if (action === 'child') {
  const child = spawnSync(
    process.execPath,
    [import.meta.filename, 'read', file],
    {
      stdio: 'inherit',
    },
  )
  process.exitCode = child.status ?? 1
} else if (action === 'unexplained' || action === 'optional') {
  if (action === 'unexplained') appendFileSync('starts', 'x')
  let visible
  try {
    visible = readFileSync(file, 'utf8') === 'fixture value'
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) throw error
  }
  if (visible) throw new Error('Protected fixture was readable')
  if (action === 'optional') console.log('handled')
  else process.exitCode = 42
} else if (action === 'retry') {
  appendFileSync('retry-starts', 'x')
  let readable = false
  try {
    readable = readFileSync(file, 'utf8') === 'fixture value'
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) throw error
  }
  const url = 'http://127.0.0.1:' + process.argv[4]
  const online = await globalThis
    .fetch(url, { signal: globalThis.AbortSignal.timeout(2000) })
    .then(async (response) => (await response.text()) === 'fixture')
    .catch(() => false)
  console.log('file=' + readable + ' network=' + online)
  if (!readable || !online) process.exitCode = 42
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
