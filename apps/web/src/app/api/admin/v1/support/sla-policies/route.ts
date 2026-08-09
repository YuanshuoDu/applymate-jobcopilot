import { NextRequest, NextResponse } from 'next/server'
import { SupportCasePriority } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('support_cases.read', request)
  if (isAdminResponse(actor)) return actor
  const policies = await db.supportSlaPolicy.findMany({ where: { active: true }, orderBy: [{ category: 'asc' }, { priority: 'asc' }], select: { id: true, category: true, priority: true, firstResponseMinutes: true, resolutionMinutes: true, warningMinutes: true, version: true } })
  return NextResponse.json({ policies }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin('support_sla.manage', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { category?: string; priority?: string; firstResponseMinutes?: number; resolutionMinutes?: number; warningMinutes?: number; version?: number; reason?: string } | null
  const category = typeof body?.category === 'string' ? body.category.trim().slice(0, 80) : ''
  const priority = body?.priority as SupportCasePriority
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  const minutes = [body?.firstResponseMinutes, body?.resolutionMinutes, body?.warningMinutes]
  if (!category || !Object.values(SupportCasePriority).includes(priority) || minutes.some((value) => !Number.isInteger(value) || (value as number) < 1 || (value as number) > 10080) || !key || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'Invalid SLA policy' }, { status: 400 })
  const current = await db.supportSlaPolicy.findUnique({ where: { category_priority: { category, priority } }, select: { version: true } })
  if (current && current.version !== body?.version) return NextResponse.json({ error: 'SLA policy changed; refresh before saving' }, { status: 409 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'support.sla_policy_updated', idempotencyKey: key, targetId: `${category}:${priority}`, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'support_case', targetId: `${category}:${priority}`, reason, outcome: 'success', after: { category, priority, firstResponseMinutes: minutes[0], resolutionMinutes: minutes[1], warningMinutes: minutes[2] } }, mutate: (tx) => tx.supportSlaPolicy.upsert({ where: { category_priority: { category, priority } }, create: { category, priority, firstResponseMinutes: minutes[0] as number, resolutionMinutes: minutes[1] as number, warningMinutes: minutes[2] as number, updatedById: actor.userId }, update: { firstResponseMinutes: minutes[0] as number, resolutionMinutes: minutes[1] as number, warningMinutes: minutes[2] as number, updatedById: actor.userId, version: { increment: 1 } } }) })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ policy: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
