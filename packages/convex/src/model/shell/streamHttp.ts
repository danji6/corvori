import { ConvexError } from 'convex/values'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import type { ErrorPayload } from '../../errors'
import { authorizeAdmin } from '../../functions'
import {
  allowedOrigin,
  corsHeaders,
  jsonResponse,
  preflightResponse,
} from '../../lib/httpResponses'
import { sidecarUrl } from '../sidecar'
import { sidecarRequest } from '../sidecarTransport'

// httpActions cap a response body at 20 MiB, so we recycle the connection
// once it goes above this limit
const STREAM_BYTE_BUDGET = 8 * 1024 * 1024

/**
 * Streams a terminal's live output to the browser by proxying the
 * sidecar SSE endpoint. The client reconnects with its last offset.
 */
export async function termStreamHandler(ctx: ActionCtx, req: Request) {
  const origin = allowedOrigin(req)

  if (req.method === 'OPTIONS') {
    return preflightResponse(origin)
  }

  const url = new URL(req.url)
  const sessionId = url.searchParams.get('sessionId')
  const jobId = url.searchParams.get('jobId')
  const offset = url.searchParams.get('offset') ?? '0'
  if (!sessionId || !jobId) {
    return jsonResponse({ error: 'Missing sessionId or jobId' }, 400, origin)
  }

  try {
    const identity = await authorizeAdmin(ctx)
    await ctx.runQuery(internal.sessions._getMemberWorkspaceContext, {
      sessionId: sessionId as Id<'sessions'>,
      subject: identity.subject,
    })
  } catch (error) {
    const code =
      error instanceof ConvexError
        ? ((error.data as ErrorPayload).code ?? 403)
        : 401
    return jsonResponse({ error: 'Unauthorized' }, code, origin)
  }

  const query = new URLSearchParams({
    sessionId,
    jobId,
    offset,
    maxBytes: String(STREAM_BYTE_BUDGET),
  })
  let upstream: Response
  try {
    upstream = await fetch(
      `${sidecarUrl()}/shell/stream?${query.toString()}`,
      sidecarRequest({
        headers: { Accept: 'text/event-stream' },
        signal: req.signal,
      }),
    )
  } catch {
    return jsonResponse({ error: 'Server unavailable' }, 502, origin)
  }

  if (!upstream.ok || !upstream.body) {
    return jsonResponse({ error: 'Stream failed' }, upstream.status, origin)
  }

  // Pass the SSE bytes through, preserving event frames and pings
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
