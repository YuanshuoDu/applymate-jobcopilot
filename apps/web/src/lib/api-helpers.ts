import { auth } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { checkRateLimit } from '@/lib/rate-limit'
import { resolveFeatureConfig, type UserAiSettings, type FeatureId } from '@/lib/model-router'
import { db } from '@/lib/db'

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? 'fallback-secret-change-this',
)

/** Get authenticated userId — supports both NextAuth session and Extension Bearer token */
export async function requireAuth(
  req?: NextRequest,
): Promise<{ userId: string } | NextResponse> {
  // 1. Extension Bearer token (x-user-id header set by middleware)
  if (req) {
    const uid = req.headers.get('x-user-id')
    if (uid) return { userId: uid }

    // 2. Extension Bearer token (direct verification — fallback)
    const authHeader = req.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET)
        if (payload.sub) {
          return { userId: payload.sub as string }
        }
      } catch {
        // token invalid — fall through to session check
      }
    }
  }

  // 3. NextAuth session (web app)
  const session = await auth()
  if (session?.user?.id) return { userId: session.user.id }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export function isErrorResponse(val: unknown): val is NextResponse {
  return val instanceof NextResponse
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status })
}

export function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

// ── AI Route helpers ──────────────────────────────────────────────────────────

/** Auth + rate limit + load user AI config. Returns the config or an error response. */
export async function prepareAiRoute(req: NextRequest, featureId: FeatureId) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return { error: auth }

  const rl = checkRateLimit(`ai:${auth.userId}`)
  if (!rl.ok) return { error: err(`Rate limit exceeded — retry in ${rl.retryAfter}s`, 429) }

  const user  = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>
  const cfg   = resolveFeatureConfig(featureId, (prefs.aiSettings ?? null) as UserAiSettings | null)

  return { userId: auth.userId, cfg }
}

/** Create an SSE ReadableStream response. Pass a body function that receives emit(). */
export function sseResponse(body: (emit: (event: string, data: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream  = new ReadableStream({
    async start(controller) {
      function emit(event: string, data: unknown) {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch { /* client disconnected */ }
      }
      try { await body(emit) }
      finally { controller.close() }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
