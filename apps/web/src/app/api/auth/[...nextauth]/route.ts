import { NextRequest, NextResponse } from 'next/server'
import { handlers } from '@/lib/auth'
import { applyAdminSecurityHeaders } from '@/lib/admin/http-security'
import { isAdminAuthApiPath, isAdminHost } from '@/lib/host-routing'

function administratorAuthEndpointOnly(request: NextRequest): Response | null {
  if (!isAdminHost(request.nextUrl.hostname) || isAdminAuthApiPath(request.nextUrl.pathname)) return null
  return applyAdminSecurityHeaders(NextResponse.json({ error: 'Administrator authentication endpoint is unavailable' }, { status: 404 }))
}

export async function GET(request: NextRequest) {
  return administratorAuthEndpointOnly(request) ?? handlers.GET(request)
}

export async function POST(request: NextRequest) {
  return administratorAuthEndpointOnly(request) ?? handlers.POST(request)
}
