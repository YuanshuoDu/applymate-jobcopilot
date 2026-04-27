import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { auth } from '@/lib/auth'

const API_PROTECTED = ['/api/jobs', '/api/dashboard', '/api/resume', '/api/activity', '/api/agent', '/api/me']
const PUBLIC_ROUTES = ['/login', '/register', '/forgot-password', '/api/auth']

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? 'fallback-secret-change-this',
)

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // ── Allow public routes through ────────────────────────────
  if (PUBLIC_ROUTES.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // ── API routes: check Bearer token ─────────────────────────
  if (API_PROTECTED.some(p => pathname.startsWith(p))) {
    const authHeader = req.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET)
        if (payload.sub) {
          const headers = new Headers(req.headers)
          headers.set('x-user-id', payload.sub as string)
          return NextResponse.next({ request: { headers } })
        }
      } catch {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      }
    }
    // Fall through — route handlers call auth() for session check
    return NextResponse.next()
  }

  // ── Page routes: require NextAuth session ──────────────────
  // Skip static files / Next internals
  if (pathname.startsWith('/_next') || pathname.includes('.')) {
    return NextResponse.next()
  }

  const session = await auth()
  if (!session?.user) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  // Run on all routes except static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons).*)'],
}
