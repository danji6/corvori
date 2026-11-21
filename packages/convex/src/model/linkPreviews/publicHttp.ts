'use node'

import { Resolver } from 'node:dns/promises'
import { type IncomingMessage, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(address, prefix, 'ipv4')
}
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  blocked.addSubnet(address, prefix, 'ipv6')
}

type Address = { address: string; family: 4 | 6 }

export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !blocked.check(address, 'ipv4')
    case 6:
      return (
        globalIpv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
      )
    default:
      return false
  }
}

export function publicHttpUrl(value: string, base?: URL): URL {
  const url = new URL(value, base)
  const supported = url.protocol === 'https:' || url.protocol === 'http:'
  if (!supported || url.username || url.password || url.port) {
    throw new Error('Unsupported preview URL')
  }
  return url
}

async function resolvePublicAddress(host: string): Promise<Address> {
  const hostname = host.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  if (family === 4 || family === 6) {
    if (isPublicAddress(hostname)) return { address: hostname, family }
    throw new Error('Preview address is not public')
  }

  const resolver = new Resolver({ timeout: 1_500, tries: 1 })
  const [ipv4, ipv6] = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ])
  const address4 =
    ipv4.status === 'fulfilled' && ipv4.value.find(isPublicAddress)
  if (address4) return { address: address4, family: 4 }

  const address6 =
    ipv6.status === 'fulfilled' && ipv6.value.find(isPublicAddress)
  if (address6) return { address: address6, family: 6 }
  throw new Error('Preview address is not public')
}

/** Connects to the validated IP while retaining the original host and TLS identity. */
function requestPinned(url: URL, target: Address, signal: AbortSignal) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const outgoing = request(
      url,
      {
        agent: false,
        signal,
        family: target.family,
        lookup: (_hostname, _options, callback) => {
          callback(null, target.address, target.family)
        },
        headers: { 'Accept-Encoding': 'identity' },
      },
      resolve,
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}

export async function openPublicHttp(value: string, signal: AbortSignal) {
  let url = publicHttpUrl(value)
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted()
    const target = await resolvePublicAddress(url.hostname)
    signal.throwIfAborted()
    const response = await requestPinned(url, target, signal)
    const status = response.statusCode ?? 0
    if (status >= 200 && status < 300) return { url, response }

    response.destroy()
    if (status >= 300 && status < 400 && response.headers.location) {
      url = publicHttpUrl(response.headers.location, url)
    } else {
      break
    }
  }
  throw new Error('Preview request failed')
}

export async function readLimited(
  response: IncomingMessage,
  limit: number,
  mode: 'complete' | 'prefix' = 'complete',
) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    const remaining = limit - length
    if (chunk.length > remaining) {
      if (mode === 'complete') throw new Error('Preview is too large')
      chunks.push(chunk.subarray(0, remaining))
      break
    }
    chunks.push(chunk)
    length += chunk.length
  }
  return Buffer.concat(chunks)
}
