import { NextRequest, NextResponse } from 'next/server'
import { Plan, PlanSubscriptionStatus } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { AdminMutationConflict, runAdminMutation } from '@/lib/admin/write-transaction'
import { parsePlan, reasonFrom } from '@/lib/admin/user-lifecycle'
import { db } from '@/lib/db'
import { shouldScheduleDowngrade } from '@/lib/plan-change-policy'

type Params = { params: Promise<{ id: string }> }
type ParsedDateInput = Date | null | undefined | { error: string }

const subscriptionSelect = {
  id: true,
  plan: true,
  status: true,
  trialStartsAt: true,
  trialEndsAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  scheduledPlan: true,
  scheduledAt: true,
  version: true,
  updatedAt: true,
} as const

function parseDateInput(value: unknown, field: string): ParsedDateInput {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') return { error: `${field} must be an ISO date or null` }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? { error: `${field} must be an ISO date or null` } : date
}

function isDateError(value: ParsedDateInput): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('billing.update', request)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const toPlan = parsePlan(body?.toPlan)
  const requestedStatus = body?.status === undefined ? undefined : Object.values(PlanSubscriptionStatus).includes(body.status as PlanSubscriptionStatus) ? body.status as PlanSubscriptionStatus : null
  const reason = reasonFrom(body?.reason, 'reason')
  const idempotencyKey = request.headers.get('idempotency-key')
  const trialEndsAtInput = parseDateInput(body?.trialEndsAt, 'trialEndsAt')
  const currentPeriodEndInput = parseDateInput(body?.currentPeriodEnd, 'currentPeriodEnd')
  const trialDateError = isDateError(trialEndsAtInput) ? trialEndsAtInput : undefined
  const periodDateError = isDateError(currentPeriodEndInput) ? currentPeriodEndInput : undefined
  const dateError = trialDateError ?? periodDateError
  if (!toPlan || requestedStatus === null || dateError || typeof reason !== 'string' || !idempotencyKey) {
    const error = !toPlan
      ? 'toPlan must be free, pro, or enterprise'
      : requestedStatus === null
        ? 'status is invalid'
        : dateError
          ? dateError.error
          : typeof reason === 'string' ? 'Idempotency-Key is required' : reason.error
    return NextResponse.json({ error }, { status: 400 })
  }

  const { id } = await params
  const existing = await db.user.findUnique({ where: { id }, select: { plan: true } })
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  const existingSubscription = await db.userPlanSubscription.findUnique({ where: { userId: id }, select: subscriptionSelect }).catch(() => null)
  if (existingSubscription && body?.version !== existingSubscription.version) return NextResponse.json({ error: 'Subscription changed; refresh before saving' }, { status: 409 })
  const status = requestedStatus ?? existingSubscription?.status ?? PlanSubscriptionStatus.active
  const parsedTrialEndsAt = isDateError(trialEndsAtInput) ? null : trialEndsAtInput
  const parsedCurrentPeriodEnd = isDateError(currentPeriodEndInput) ? null : currentPeriodEndInput
  const trialEndsAt = parsedTrialEndsAt === undefined ? (status === PlanSubscriptionStatus.trialing ? existingSubscription?.trialEndsAt ?? null : null) : parsedTrialEndsAt
  const currentPeriodEnd = parsedCurrentPeriodEnd === undefined ? existingSubscription?.currentPeriodEnd ?? null : parsedCurrentPeriodEnd
  const cancelAtPeriodEnd = typeof body?.cancelAtPeriodEnd === 'boolean' ? body.cancelAtPeriodEnd : existingSubscription?.cancelAtPeriodEnd ?? false
  if (status === PlanSubscriptionStatus.trialing && (!trialEndsAt || trialEndsAt <= new Date())) return NextResponse.json({ error: 'A future trial end is required' }, { status: 400 })
  if (status !== PlanSubscriptionStatus.trialing && parsedTrialEndsAt instanceof Date) return NextResponse.json({ error: 'trialEndsAt is only valid for a trialing subscription' }, { status: 400 })
  const now = new Date()
  const scheduledDowngrade = existingSubscription ? shouldScheduleDowngrade({ from: existing.plan, to: toPlan, currentPeriodEnd, now, applyImmediately: body?.applyImmediately === true }) : false
  if (existing.plan === toPlan && existingSubscription && status === existingSubscription.status && trialEndsAt?.getTime() === existingSubscription.trialEndsAt?.getTime() && currentPeriodEnd?.getTime() === existingSubscription.currentPeriodEnd?.getTime() && cancelAtPeriodEnd === existingSubscription.cancelAtPeriodEnd && !existingSubscription.scheduledPlan) return NextResponse.json({ error: 'Subscription is unchanged' }, { status: 409 })
  let result
  try {
    result = await runAdminMutation({
      actorUserId: actor.userId,
      action: existing.plan === toPlan ? 'users.subscription_updated' : 'users.plan_updated',
      idempotencyKey,
      targetId: id,
      audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'user', targetId: id, tenantUserId: id, reason, outcome: 'success', before: { plan: existing.plan, subscription: existingSubscription }, after: { plan: scheduledDowngrade ? existing.plan : toPlan, scheduledPlan: scheduledDowngrade ? toPlan : null, status, trialEndsAt, currentPeriodEnd, cancelAtPeriodEnd: scheduledDowngrade || cancelAtPeriodEnd } },
      mutate: async (tx) => {
        if (existing.plan !== toPlan && !scheduledDowngrade) await tx.userPlanChange.create({ data: { userId: id, fromPlan: existing.plan, toPlan, reason, actorUserId: actor.userId } })
        const user = await tx.user.update({ where: { id }, data: { plan: scheduledDowngrade ? existing.plan : toPlan }, select: adminUserMetadataSelect })
        const subscriptionData = { plan: scheduledDowngrade ? existing.plan : toPlan, status, trialEndsAt, currentPeriodEnd, cancelAtPeriodEnd: scheduledDowngrade || cancelAtPeriodEnd, scheduledPlan: scheduledDowngrade ? toPlan : null, scheduledAt: scheduledDowngrade ? currentPeriodEnd : null, updatedById: actor.userId }
        if (existingSubscription) {
          const updated = await tx.userPlanSubscription.updateMany({
            where: { userId: id, version: existingSubscription.version },
            data: { ...subscriptionData, trialStartsAt: status === PlanSubscriptionStatus.trialing ? existingSubscription.status === PlanSubscriptionStatus.trialing ? existingSubscription.trialStartsAt ?? now : now : null, version: { increment: 1 } },
          })
          if (updated.count !== 1) throw new AdminMutationConflict('Subscription changed; refresh before saving')
        } else {
          await tx.userPlanSubscription.create({ data: { userId: id, ...subscriptionData, trialStartsAt: status === PlanSubscriptionStatus.trialing ? now : null, currentPeriodStart: now }, select: subscriptionSelect })
        }
        const subscription = await tx.userPlanSubscription.findUniqueOrThrow({ where: { userId: id }, select: subscriptionSelect })
        return { user, subscription }
      },
    })
  } catch (error) {
    if (error instanceof AdminMutationConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({ user: toAdminUserMetadata(result.value.user), subscription: result.value.subscription, scheduled: scheduledDowngrade }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function GET(request: NextRequest, { params }: Params) {
  const actor = await requireAdmin('billing.read', request)
  if (isAdminResponse(actor)) return actor
  const { id } = await params
  const [changes, subscription] = await Promise.all([
    db.userPlanChange.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, fromPlan: true, toPlan: true, reason: true, actorUserId: true, createdAt: true } }),
    db.userPlanSubscription.findUnique({ where: { userId: id }, select: subscriptionSelect }).catch(() => null),
  ])
  return NextResponse.json({ changes, subscription }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
