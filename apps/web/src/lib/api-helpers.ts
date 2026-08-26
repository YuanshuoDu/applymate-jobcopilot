import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { jwtVerify } from 'jose'
import { checkRateLimit } from '@/lib/rate-limit'
import { loadUserAiConfig, type FeatureId } from '@/lib/model-router'
import { db } from '@/lib/db'
import { safeAuth } from '@/lib/safe-auth'
import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from '@/lib/auth-secret'
import { resolvePlatformRoute } from '@/lib/admin/ai-config'
import { activateTenantContext } from '@/lib/db/tenant-store'
import { isFeatureAllowed, resolveAiAccess } from '@/lib/entitlements'
import { authVersionFromClaim, isCurrentAuthVersion } from '@/lib/auth-version'
import { normalizeEmail } from '@/lib/auth-identifiers'

const JWT_SECRET = getAuthJwtSecret()

/** Get authenticated userId — supports both NextAuth session and Extension Bearer token */
export async function requireAuth(
  req?: NextRequest,
  requiredFeature?: string,
): Promise<{ userId: string } | NextResponse> {
  // Extension Bearer token. Do not trust x-user-id: it is a client-settable
  // header unless every proxy strips it before the request reaches this route.
  // `headers()` keeps token auth working for GET handlers that do not declare
  // a NextRequest parameter.
  const authHeader = req
    ? req.headers.get('authorization')
    : (await headers()).get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    try {
      const { payload } = await jwtVerify(token, JWT_SECRET, {
        issuer: EXTENSION_TOKEN_ISSUER,
        audience: EXTENSION_TOKEN_AUDIENCE,
      })
      if (typeof payload.sub === 'string' && payload.sub.length > 0) {
        return activeAccountOrDenied(
          payload.sub,
          authVersionFromClaim(payload.authVersion),
        )
      }
    } catch {
      // A caller that explicitly supplied Bearer credentials must never fall
      // through to a browser cookie. Otherwise a stale extension token for
      // account A could silently execute as the cookie account B.
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // NextAuth session (web app)
  const session = await safeAuth()
  const sessionUser = session?.user
  if (sessionUser?.id) {
    return activeAccountOrDenied(
      sessionUser.id,
      authVersionFromClaim(sessionUser.authVersion),
    )
  }
  // A small number of pre-Auth.js-v5 browser sessions retain signed profile
  // attributes but neither an application `id` nor a standard `sub` claim.
  // Recover only through the unique normalized account email, then apply the
  // same status and revision check used by all other session identities.
  const sessionEmail = typeof sessionUser?.email === 'string'
    ? normalizeEmail(sessionUser.email)
    : ''
  if (sessionEmail) {
    return activeAccountEmailOrDenied(
      sessionEmail,
      authVersionFromClaim(sessionUser?.authVersion),
    )
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

async function activeAccountOrDenied(userId: string, expectedAuthVersion?: number) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { accountStatus: true, authVersion: true } })
  return activeAccountResult(userId, user, expectedAuthVersion)
}

async function activeAccountEmailOrDenied(email: string, expectedAuthVersion: number) {
  const candidates = await db.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, accountStatus: true, authVersion: true },
    take: 2,
  })
  const user = candidates.length === 1 ? candidates[0] : null
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return activeAccountResult(user.id, user, expectedAuthVersion)
}

function activeAccountResult(
  userId: string,
  user: { accountStatus: string; authVersion: number } | null,
  expectedAuthVersion?: number,
) {
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (user.accountStatus !== 'active') return NextResponse.json({ error: 'Account suspended' }, { status: 403 })
  if (expectedAuthVersion !== undefined && !isCurrentAuthVersion(expectedAuthVersion, user.authVersion)) return NextResponse.json({ error: 'Session expired' }, { status: 401 })
  activateTenantContext(userId)
  return { userId }
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
export async function prepareAiRoute(req: NextRequest, featureId: FeatureId, requiredEntitlement?: string | string[]) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return { error: auth }

  const defaultEntitlement = featureId === 'autoApply' ? 'auto_apply' : featureId === 'coverLetter' ? 'cover_letter' : null
  const entitlementKeys = requiredEntitlement ? (Array.isArray(requiredEntitlement) ? requiredEntitlement : [requiredEntitlement]) : defaultEntitlement ? [defaultEntitlement] : []
  for (const entitlementKey of entitlementKeys) {
    if (!(await isFeatureAllowed(auth.userId, entitlementKey))) return { error: err('This feature is not included in your current plan', 403) }
  }
  const aiAccess = await resolveAiAccess(auth.userId)
  if (aiAccess === 'disabled') return { error: err('This feature is not included in your current plan', 403) }
  if (aiAccess === 'exhausted') return { error: err('Monthly AI credits exhausted', 429) }

  const rl = checkRateLimit(`ai:${auth.userId}`)
  if (!rl.ok) return { error: err(`Rate limit exceeded — retry in ${rl.retryAfter}s`, 429) }

  const configured = await loadUserAiConfig(auth.userId, featureId)
  // A stale feature override must not make the application flow unusable when
  // its provider has no key. Fall back to the platform MiniMax model.
  const cfg = configured.resolvedKey ? configured : await resolvePlatformRoute(featureId)

  return { userId: auth.userId, cfg: { ...cfg, usageUserId: auth.userId, usageFeatureKey: featureId, usageRuntime: 'web' as const } }
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
