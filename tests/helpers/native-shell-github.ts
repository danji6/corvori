import { execFileSync } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Run the installed GitHub CLI against a disposable API using only a test credential. */
export async function nativeGitHubFixture(root: string, workspace: string) {
  const gh = Bun.which('gh')
  if (!gh) throw new Error('The native CLI test requires gh')
  const binary = join(workspace, 'fixture-gh')
  await copyFile(gh, binary)
  const requests: string[] = []
  const fetch = async (request: Request) => {
    const token = request.headers.get('authorization')
    if (!['Bearer fixture-token', 'token fixture-token'].includes(token ?? ''))
      return new Response('Missing fixture credential', { status: 401 })
    requests.push(await request.text())
    return Response.json({
      data: {
        repository: {
          hasIssuesEnabled: true,
          pullRequests: {
            nodes: [],
            edges: [],
            totalCount: 0,
            pageInfo: { hasNextPage: false },
          },
        },
      },
    })
  }
  const transport =
    process.platform === 'linux'
      ? await tcpApi(root, workspace, fetch)
      : socketApi(workspace, fetch)
  const launcher = join(root, 'fixture-launcher')
  await writeFile(
    launcher,
    ['#!/bin/sh', ...transport.environment, 'exec "' + binary + '" "$@"'].join(
      '\n',
    ),
    { mode: 0o700 },
  )
  return { launcher, server: transport.server, requests }
}

function socketApi(
  root: string,
  fetch: (request: Request) => Promise<Response>,
) {
  const socket = join(root, 'api.sock')
  const server = Bun.serve({ unix: socket, fetch })
  return {
    server,
    environment: [
      'mkdir -p "$HOME/.config/gh" || exit 1',
      'echo "http_unix_socket: ' +
        socket +
        '" > "$HOME/.config/gh/config.yml" || exit 1',
    ],
  }
}

async function tcpApi(
  root: string,
  workspace: string,
  fetch: (request: Request) => Promise<Response>,
) {
  const key = join(root, 'api.key')
  const cert = join(workspace, 'api.crt')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  )
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch,
    tls: { key: await readFile(key), cert: await readFile(cert) },
  })
  return {
    server,
    environment: [
      'export GH_HOST=127.0.0.1:' + server.port,
      'export GH_ENTERPRISE_TOKEN="$GH_TOKEN"',
      'export SSL_CERT_FILE="' + cert + '"',
    ],
  }
}
