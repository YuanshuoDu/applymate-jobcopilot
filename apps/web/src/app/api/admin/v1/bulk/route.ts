import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

const MAX_IDS = 100
const USER_ACTIONS = ['suspend', 'restore'] as const
const APPLICATION_ACTIONS = ['cancel', 'manual_review'] as const

function parseBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as { resource?: unknown; action?: unknown; ids?: unknown; reason?: unknown }
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(Boolean))]
    : []
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  return { resource: typeof body.resource === 'string' ? body.resource : '', action: typeof body.action === 'string' ? body.action : '', ids, reason }
}

export async function POST(request: NextRequest) {
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = parseBody(await request.json().catch(() => null))
  if (!body || body.ids.length === 0 || body.ids.length > MAX_IDS || body.reason.length < 10 || body.reason.length > 500) {
    return NextResponse.json({ error: `ids (1-${MAX_IDS}) and a 10-500 character reason are required` }, { status: 400 })
  }

  const isUsers = body.resource === 'users' && USER_ACTIONS.includes(body.action as typeof USER_ACTIONS[number])
  const isApplications = body.resource === 'applications' && APPLICATION_ACTIONS.includes(body.action as typeof APPLICATION_ACTIONS[number])
  if (!isUsers && !isApplications) return NextResponse.json({ error: 'Unsupported bulk resource or action' }, { status: 400 })

  const permission = isUsers ? (body.action === 'suspend' ? 'users.suspend' : 'users.restore') : body.action === 'cancel' ? 'applications.cancel' : 'applications.manual_review'
  const actor = await requireAdmin(permission, request)
  if (isAdminResponse(actor)) return actor
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!key) return NextResponse.json({ error: 'Idempotency-Key is required' }, { status: 400 })

  if (isUsers) {
    const users = await db.user.findMany({ where: { id: { in: body.ids } }, select: { id: true, accountStatus: true } })
    const targetStatus = body.action === 'suspend' ? 'suspended' : 'active'
    const eligible = users.filter(user => user.accountStatus !== targetStatus)
    const result = await runAdminMutation({
      actorUserId: actor.userId,
      action: `users.bulk_${body.action}`,
      idempotencyKey: key,
      targetId: `bulk:${body.resource}:${body.action}`,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'user', reason: body.reason, outcome: 'success', before: { ids: users.map(user => user.id), statuses: users.map(user => user.accountStatus) }, after: { status: targetStatus, affected: eligible.length } },
      mutate: async tx => {
        if (eligible.length === 0) return { affected: 0 }
        const updated = await tx.user.updateMany({ where: { id: { in: eligible.map(user => user.id) } }, data: body.action === 'suspend' ? { accountStatus: 'suspended', suspendedAt: new Date(), suspendedById: actor.userId, suspensionReason: body.reason } : { accountStatus: 'active', suspendedAt: null, suspendedById: null, suspensionReason: null } })
        return { affected: updated.count }
      },
    })
    return NextResponse.json(result.duplicate ? { duplicate: true } : { resource: body.resource, action: body.action, affected: result.value.affected }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  }

  const numericIds = body.ids.map(Number).filter(Number.isInteger)
  if (!numericIds.length) return NextResponse.json({ error: 'Application IDs must be numeric' }, { status: 400 })
  const results = await db.applyResult.findMany({ where: { id: { in: numericIds } }, select: { id: true, userId: true, jobId: true } })
  const tasks = results.length ? await db.applicationTask.findMany({ where: { OR: results.map(row => ({ userId: row.userId, jobId: row.jobId })) }, select: { id: true, userId: true, jobId: true, status: true } }) : []
  const eligible = tasks.filter(task => body.action === 'cancel' ? !['submitted', 'skipped', 'cancelled'].includes(task.status) : !['submitted', 'cancelled'].includes(task.status))
  const next = body.action === 'cancel' ? { status: 'cancelled', checkpoint: 'cancelled_by_admin', error: body.reason } : { status: 'waiting_for_user', checkpoint: 'admin_review', error: 'Manual review requested by an administrator' }
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: `applications.bulk_${body.action}`,
    idempotencyKey: key,
    targetId: `bulk:${body.resource}:${body.action}`,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'application', reason: body.reason, outcome: 'success', before: { taskIds: eligible.map(task => task.id) }, after: { status: next.status, affected: eligible.length } },
    mutate: async tx => {
      let affected = 0
      for (const task of eligible) {
        const updated = await tx.applicationTask.updateMany({ where: { id: task.id, status: task.status }, data: { ...next, completedAt: body.action === 'cancel' ? new Date() : null } })
        if (updated.count === 1) {
          affected += 1
          await tx.applicationTaskEvent.create({ data: { taskId: task.id, type: body.action === 'cancel' ? 'cancelled_by_admin' : 'manual_review_requested', actor: 'system', body: body.reason } })
        }
      }
      return { affected }
    },
  })
  return NextResponse.json(result.duplicate ? { duplicate: true } : { resource: body.resource, action: body.action, affected: result.value.affected }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
