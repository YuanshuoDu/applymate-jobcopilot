import { Plan, PlanSubscriptionStatus } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { adminPageLimit, pageResult } from '@/lib/admin/pagination'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { toAdminUserMetadata } from '@/lib/admin/dto'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('billing.read', request)
  if (isAdminResponse(actor)) return actor
  const params = request.nextUrl.searchParams
  const limit = adminPageLimit(params.get('limit'))
  const cursor = params.get('cursor')
  const rows = await db.userPlanSubscription.findMany({ orderBy: { updatedAt: 'desc' }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: limit + 1, include: { user: { select: { id: true, name: true, email: true, plan: true, accountStatus: true, location: true, createdAt: true, _count: { select: { jobs: true, resumes: true, notifications: true } }, gmailSyncState: { select: { lastSyncedAt: true, lastError: true } } } } } })
  const page = pageResult(rows, limit)
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'billing.subscriptions_viewed', outcome: 'success' })
  return NextResponse.json({ items: page.items.map((row) => ({ ...row, user: toAdminUserMetadata(row.user) })), nextCursor: page.nextCursor }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function PATCH(request: NextRequest) {
  const actor = await requireAdmin('billing.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as { userId?: string; plan?: string; status?: string; trialEndsAt?: string | null; currentPeriodEnd?: string | null; cancelAtPeriodEnd?: boolean; version?: number; reason?: string } | null
  const userId = typeof body?.userId === 'string' ? body.userId.trim() : ''
  const plan = body?.plan as Plan
  const status = body?.status as PlanSubscriptionStatus
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  const trialEndsAt = body?.trialEndsAt ? new Date(body.trialEndsAt) : null
  const currentPeriodEnd = body?.currentPeriodEnd ? new Date(body.currentPeriodEnd) : null
  if (!userId || !Object.values(Plan).includes(plan) || !Object.values(PlanSubscriptionStatus).includes(status) || (trialEndsAt && Number.isNaN(trialEndsAt.getTime())) || (currentPeriodEnd && Number.isNaN(currentPeriodEnd.getTime())) || !key || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'Invalid subscription update' }, { status: 400 })
  if (status === PlanSubscriptionStatus.trialing && (!trialEndsAt || trialEndsAt <= new Date())) return NextResponse.json({ error: 'A future trial end is required' }, { status: 400 })
  const user = await db.user.findUnique({ where: { id: userId }, select: { plan: true } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  const existing = await db.userPlanSubscription.findUnique({ where: { userId }, select: { id: true, version: true, status: true, plan: true } }).catch(() => null)
  if (existing && body?.version !== existing.version) return NextResponse.json({ error: 'Subscription changed; refresh before saving' }, { status: 409 })
  const result = await runAdminMutation({ actorUserId: actor.userId, action: 'billing.subscription_updated', idempotencyKey: key, targetId: userId, audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'plan', targetId: userId, tenantUserId: userId, reason, outcome: 'success', before: { plan: user.plan, subscription: existing }, after: { plan, status, trialEndsAt, currentPeriodEnd, cancelAtPeriodEnd: body?.cancelAtPeriodEnd === true } }, mutate: async (tx) => {
    if (user.plan !== plan) await tx.userPlanChange.create({ data: { userId, fromPlan: user.plan, toPlan: plan, reason, actorUserId: actor.userId } })
    await tx.user.update({ where: { id: userId }, data: { plan } })
    return tx.userPlanSubscription.upsert({ where: { userId }, create: { userId, plan, status, trialStartsAt: status === 'trialing' ? new Date() : null, trialEndsAt, currentPeriodStart: new Date(), currentPeriodEnd, cancelAtPeriodEnd: body?.cancelAtPeriodEnd === true, updatedById: actor.userId }, update: { plan, status, trialStartsAt: status === 'trialing' ? new Date() : null, trialEndsAt, currentPeriodEnd, cancelAtPeriodEnd: body?.cancelAtPeriodEnd === true, updatedById: actor.userId, version: { increment: 1 } } })
  } })
  if (result.duplicate) return NextResponse.json({ duplicate: true })
  return NextResponse.json({ subscription: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
