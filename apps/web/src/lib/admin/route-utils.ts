import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { AdminActor } from '@/lib/admin/authorization'
import type { Permission } from '@/lib/admin/permissions'

class AdminResponseError extends Error {
  constructor(readonly response: NextResponse) { super('Admin authorization failed') }
}

export async function requireAdminActor(permission: Permission, request: Request): Promise<AdminActor> {
  const { isAdminResponse, requireAdmin } = await import('@/lib/admin/authorization')
  const actor = await requireAdmin(permission, request)
  if ((typeof isAdminResponse === 'function' && isAdminResponse(actor)) || actor instanceof Response) throw new AdminResponseError(actor as NextResponse)
  return actor
}

export function requestId(request: Request): string {
  return request.headers.get('x-request-id')?.trim() || randomUUID()
}

export function adminJson(body: unknown, status: number, correlationId: string): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'x-request-id': correlationId },
  })
}

export function adminError(error: unknown, correlationId: string): NextResponse {
  if (error instanceof AdminResponseError) return error.response
  if (isAdminAuthorizationError(error)) {
    return adminJson({ error: error.code }, error.status, correlationId)
  }
  if (isAdminIdempotencyError(error)) {
    return adminJson({ error: error.code }, error.status, correlationId)
  }
  return adminJson({ error: 'ADMIN_REQUEST_FAILED' }, 400, correlationId)
}

function isAdminAuthorizationError(value: unknown): value is { status: 401 | 403; code: string } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { status?: unknown; code?: unknown }
  return (candidate.status === 401 || candidate.status === 403) && typeof candidate.code === 'string'
}

function isAdminIdempotencyError(value: unknown): value is { status: 409; code: string } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { status?: unknown; code?: unknown }
  return candidate.status === 409 && candidate.code === 'IDEMPOTENCY_KEY_REUSED'
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON body')
  return value as Record<string, unknown>
}

export function requiredReason(body: Record<string, unknown>): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 10 || reason.length > 500) throw new Error('Reason must be 10-500 characters')
  return reason
}

export function requiredIdempotencyKey(request: Request): string {
  const key = request.headers.get('Idempotency-Key')?.trim() || ''
  if (key.length < 8 || key.length > 200) throw new Error('Idempotency-Key is required')
  return key
}
