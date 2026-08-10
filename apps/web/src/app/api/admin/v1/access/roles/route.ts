import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { isPermission, PERMISSIONS } from '@/lib/admin/permissions'
import { db } from '@/lib/db'

function parseRole(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid role body' }
  const input = body as Record<string, unknown>
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const description = input.description === undefined || input.description === null ? null : typeof input.description === 'string' ? input.description.trim() : ''
  const permissions = Array.isArray(input.permissions) ? input.permissions.filter((value): value is string => typeof value === 'string') : null
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(key) || !name || name.length > 80 || (description !== null && description.length > 240)) return { error: 'Invalid role key, name, or description' }
  if (!permissions || permissions.length > 60 || permissions.some(permission => !isPermission(permission))) return { error: 'Role contains an unknown permission' }
  return { key, name, description, permissions: [...new Set(permissions)] }
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('admin_members.read', request)
  if (isAdminResponse(actor)) return actor
  const [roles] = await Promise.all([db.adminRole.findMany({ orderBy: { key: 'asc' }, select: { id: true, key: true, name: true, description: true, permissions: true, system: true, createdAt: true, updatedAt: true } })])
  return NextResponse.json({ roles, permissions: PERMISSIONS }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('admin_roles.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const parsed = parseRole(body)
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')
  if ('error' in parsed || reason.length < 10 || reason.length > 500 || !idempotencyKey) return NextResponse.json({ error: 'error' in parsed ? parsed.error : 'A reason and Idempotency-Key are required' }, { status: 400 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'admin_roles.created', idempotencyKey, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'admin_role', reason, outcome: 'success', after: { key: parsed.key, permissions: parsed.permissions } }, mutate: (tx) => tx.adminRole.create({ data: { key: parsed.key, name: parsed.name, description: parsed.description, permissions: parsed.permissions, system: false } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ role: result.value }, { status: 201, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
