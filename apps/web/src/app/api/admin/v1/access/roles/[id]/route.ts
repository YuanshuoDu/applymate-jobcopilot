import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { isPermission } from '@/lib/admin/permissions'
import { db } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('admin_roles.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const { id } = await params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const permissions = Array.isArray(body?.permissions) ? body.permissions.filter((value): value is string => typeof value === 'string') : null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const description = body?.description === null ? null : typeof body?.description === 'string' ? body.description.trim() : undefined
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const idempotencyKey = request.headers.get('idempotency-key')
  if (!permissions || permissions.length > 60 || permissions.some(permission => !isPermission(permission)) || !name || name.length > 80 || (description !== undefined && description !== null && description.length > 240) || reason.length < 10 || reason.length > 500 || !idempotencyKey) return NextResponse.json({ error: 'Invalid role update' }, { status: 400 })
  const role = await db.adminRole.findUnique({ where: { id }, select: { id: true, system: true, key: true, permissions: true } })
  if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  if (role.system) return NextResponse.json({ error: 'System roles cannot be edited' }, { status: 409 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'admin_roles.updated', idempotencyKey, targetId: id, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'admin_role', targetId: id, reason, outcome: 'success', before: { permissions: role.permissions }, after: { permissions } }, mutate: (tx) => tx.adminRole.update({ where: { id }, data: { name, description, permissions: [...new Set(permissions)] } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ role: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
