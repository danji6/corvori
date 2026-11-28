const { process } = globalThis
const { readFileSync, readdirSync, writeFileSync } =
  process.getBuiltinModule('fs')
const { dirname, join } = process.getBuiltinModule('path')

function permitted(operation) {
  try {
    return operation()
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) return false
    throw error
  }
}

function read(path) {
  return permitted(() => readFileSync(path, 'utf8') === 'fixture')
}

function write(path) {
  return permitted(() => {
    writeFileSync(path, 'fixture')
    return true
  })
}

async function main() {
  const [outside, port] = process.argv.slice(2)
  const sibling = dirname(outside)
  const online = await globalThis
    .fetch('http://127.0.0.1:' + port, {
      signal: globalThis.AbortSignal.timeout(2500),
    })
    .then(
      async (response) => (await response.text()) === 'fixture',
      () => false,
    )
  const result = {
    ordinary: write('result'),
    dependencyRead: read('node_modules/sample'),
    dependencyWrite: write('node_modules/sample'),
    ignored: read('ignored'),
    outside: read(outside),
    shared: read(join(sibling, 'shared')),
    listSibling: permitted(() => readdirSync(sibling).includes('sample')),
    linked: read('linked/sample'),
    online,
  }
  process.stdout.write(JSON.stringify(result))
}

void main()
