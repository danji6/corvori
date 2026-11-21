import type { ActionCtx } from '../../_generated/server'
import { createAuth } from '../../auth'
import {
  authFailureRateLimit,
  isAuthFailure,
  withRetryAfter,
} from '../../lib/authFailureRateLimit'
import {
  allowedOrigin,
  corsHeaders,
  jsonResponse,
  preflightResponse,
} from '../../lib/httpResponses'
import {
  checkRateLimit,
  clearRateLimit,
  recordRateLimit,
} from '../../lib/rateLimits'
import { siteUrl } from '../../origins'

export async function authHandler(ctx: ActionCtx, req: Request) {
  const origin = allowedOrigin(req)

  if (req.method === 'OPTIONS') {
    return preflightResponse(origin)
  }

  const { ip } = await ctx.meta.getRequestMetadata()
  const rule = authFailureRateLimit(new URL(req.url).pathname, ip)
  if (rule) {
    const status = await checkRateLimit(ctx, rule.key)
    if (status.limited) {
      return withRetryAfter(
        jsonResponse(
          { message: 'Too many requests. Please try again later.' },
          429,
          origin,
        ),
        status.retryAfter,
      )
    }
  }

  const auth = createAuth(ctx, {
    siteUrl: siteUrl(req.url),
    trustedOrigin: origin,
  })
  let response = await auth.handler(req)

  if (rule && isAuthFailure(response)) {
    const status = await recordRateLimit(ctx, rule)
    if (status.limited) {
      response = withRetryAfter(response, status.retryAfter)
    }
  } else if (rule && response.ok) {
    await clearRateLimit(ctx, rule.key)
  }

  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    headers.set(k, v)
  }

  return new Response(response.body, { status: response.status, headers })
}

// Convex does OIDC discovery at {issuer}/.well-known/openid-configuration.
// The actual endpoint is at /api/auth/convex/.well-known/openid-configuration,
// so we proxy the standard path to it.
export async function oidcDiscoveryHandler(ctx: ActionCtx, req: Request) {
  const auth = createAuth(ctx, { siteUrl: siteUrl(req.url) })
  const url = new URL(req.url)
  url.pathname = '/api/auth/convex/.well-known/openid-configuration'
  return auth.handler(new Request(url.toString(), req))
}
