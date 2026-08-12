import { NextRequest, NextResponse } from 'next/server'
import { handlers } from '@/lib/auth'
import { applyAdminSecurityHeaders } from '@/lib/admin/http-security'
import { isAdminAuthApiPath, isAdminHost } from '@/lib/host-routing'

function administratorAuthEndpointOnly(request: NextRequest): Response | null {
  if (!isAdminHost(request.nextUrl.hostname) || isAdminAuthApiPath(request.nextUrl.pathname)) return null
  return applyAdminSecurityHeaders(NextResponse.json({ error: 'Administrator authentication endpoint is unavailable' }, { status: 404 }))
}

async function administratorProviderDiscovery(request: NextRequest): Promise<Response | null> {
  if (!isAdminHost(request.nextUrl.hostname) || request.nextUrl.pathname !== '/api/auth/providers') return null

  const response = await handlers.GET(request)
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response

  const providers = await response.clone().json() as unknown
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return response

  const credentials = (providers as Record<string, unknown>).credentials
  if (!credentials) return response

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify({ credentials }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function GET(request: NextRequest) {
  return administratorAuthEndpointOnly(request) ?? await administratorProviderDiscovery(request) ?? handlers.GET(request)
}

export async function POST(request: NextRequest) {
  return administratorAuthEndpointOnly(request) ?? handlers.POST(request)
}
