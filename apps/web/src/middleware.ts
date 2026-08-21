import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { applyAdminSecurityHeaders } from '@/lib/admin/http-security'
import { adminOrigin, isAdminApiPath, isAdminAuthApiPath, isAdminHost, isAdminPath, isAuthPath, isLocalHost } from '@/lib/host-routing'

const PUBLIC_ROUTES = ['/landing', '/login', '/register', '/forgot-password', '/reset-password', '/api/auth']
const SESSION_COOKIE_NAMES = [
  'authjs.session-token',
  '__Secure-authjs.session-token',
  '__Host-authjs.session-token',
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
] as const

function hasSessionCookie(req: NextRequest) {
  return SESSION_COOKIE_NAMES.some(name => Boolean(req.cookies.get(name)?.value?.trim()))
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const hostname = req.nextUrl.hostname
  const onAdminHost = isAdminHost(hostname)

  // The administrator hostname is intentionally a narrow surface: only the
  // admin UI, Auth.js endpoints, and admin APIs are routable there.
  if (onAdminHost) {
    if (pathname === '/register' || pathname === '/forgot-password' || pathname === '/reset-password') {
      return NextResponse.redirect(new URL('/login?callbackUrl=%2Fadmin&error=admin_registration_disabled', req.url))
    }

    if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
      if (!isAdminAuthApiPath(pathname)) {
        return applyAdminSecurityHeaders(NextResponse.json({ error: 'Administrator authentication endpoint is unavailable' }, { status: 404 }))
      }
    }

    if ((pathname === '/api' || pathname.startsWith('/api/')) && !isAuthPath(pathname) && !isAdminApiPath(pathname)) {
      return applyAdminSecurityHeaders(NextResponse.json({ error: 'Administrator host only' }, { status: 404 }))
    }

    if (!isAuthPath(pathname) && !isAdminPath(pathname) && !pathname.startsWith('/api/')) {
      return NextResponse.redirect(new URL('/admin', req.url))
    }
  } else if (isAdminPath(pathname) && !isLocalHost(hostname)) {
    // Keep the admin session and its logout callback on the administrator
    // origin. Preview deployments are included so they cannot become a
    // second, accidentally public admin surface.
    const target = new URL(pathname, adminOrigin(req.url))
    target.search = req.nextUrl.search
    return NextResponse.redirect(target)
  }

  if (isAdminApiPath(pathname) && !onAdminHost && !isLocalHost(hostname)) {
    return applyAdminSecurityHeaders(NextResponse.json({ error: 'Administrator API is only available on the administrator host' }, { status: 404 }))
  }

  // The visual Agent workspace preview is intentionally available only to a
  // local non-production developer session. It does not expose account data.
  if (pathname === '/agent-preview' && isLocalHost(hostname) && process.env.NODE_ENV !== 'production') {
    return NextResponse.next()
  }

  // ── Allow public routes through ────────────────────────────
  if (PUBLIC_ROUTES.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Route handlers own admin authorization so callers receive API-appropriate
  // 401/403 responses. The middleware supplies defense-in-depth headers only.
  if (pathname.startsWith('/api/admin/v1')) {
    return applyAdminSecurityHeaders(NextResponse.next())
  }

  // API handlers own authentication (session, bearer token, admin permission,
  // or internal secret) and must return API-shaped errors instead of a page
  // redirect. Middleware only adds the admin response headers above.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  // ── Page routes: use a cheap cookie gate ────────────────────
  // The page/layout performs the authoritative Auth.js and RBAC check. Keeping
  // auth out of middleware prevents Prisma and bcrypt from entering the Edge
  // bundle while preserving the anonymous redirect UX.
  // Skip static files / Next internals
  if (pathname.startsWith('/_next') || pathname.includes('.')) {
    return NextResponse.next()
  }

  if (!hasSessionCookie(req)) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return pathname === '/admin' || pathname.startsWith('/admin/')
    ? applyAdminSecurityHeaders(NextResponse.next())
    : NextResponse.next()
}

export const config = {
  // Run on all routes except static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons).*)'],
}
