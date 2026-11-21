import { isAllowedOrigin } from '../origins'

/**
 * The origin to answer with, or `null` when the caller is not allowed one.
 * A same-origin request carries no `Origin` header and needs no CORS headers.
 */
export function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get('Origin')
  if (!origin) return null

  return isAllowedOrigin(origin, req.url) ? origin : null
}

export const corsHeaders = (origin: string | null) => ({
  ...(origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
      }
    : {}),
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Retry-After',
  Vary: 'Origin',
})

export function preflightResponse(origin: string | null) {
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json',
    },
  })
}
