import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { applyAdminSecurityHeaders } from '@/lib/admin/http-security'

const PUBLIC_ROUTES = ['/login', '/register', '/forgot-password', '/reset-password', '/api/auth']

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

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

  return pathname === '/admin' || pathname.startsWith('/admin/')
    ? applyAdminSecurityHeaders(NextResponse.next())
    : NextResponse.next()
}

export const config = {
  // Run on all routes except static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons).*)'],
}
