import { Plan, PlanSubscriptionStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { getPlanCatalogue } from '@/lib/plan-catalogue'

function nextPeriodEnd(start: Date, interval: string): Date | null {
  if (interval === 'year') return new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()))
  if (interval === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()))
  return null
}

export async function advanceSubscriptionLifecycle(now = new Date()): Promise<{ processed: number; renewed: number; expired: number; appliedDowngrades: number }> {
  const [subscriptions, plans] = await Promise.all([
    db.userPlanSubscription.findMany({ where: { OR: [{ trialEndsAt: { lte: now }, status: PlanSubscriptionStatus.trialing }, { currentPeriodEnd: { lte: now } }] }, select: { id: true, userId: true, plan: true, status: true, trialEndsAt: true, currentPeriodStart: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, scheduledPlan: true, scheduledAt: true, version: true, user: { select: { plan: true } } } }),
    getPlanCatalogue(true),
  ])
  const catalogue = new Map(plans.map(plan => [plan.key, plan]))
  let renewed = 0
  let expired = 0
  let appliedDowngrades = 0
  for (const subscription of subscriptions) {
    const periodEnded = Boolean(subscription.currentPeriodEnd && subscription.currentPeriodEnd <= now)
    const trialEnded = subscription.status === PlanSubscriptionStatus.trialing && Boolean(subscription.trialEndsAt && subscription.trialEndsAt <= now)
    if (!periodEnded && !trialEnded) continue
    const scheduled = subscription.scheduledPlan
    const targetPlan = scheduled ?? (subscription.cancelAtPeriodEnd || subscription.status === PlanSubscriptionStatus.cancelled ? Plan.free : subscription.plan)
    const targetCatalogue = catalogue.get(targetPlan)
    const nextStart = periodEnded ? now : subscription.currentPeriodStart ?? now
    const nextEnd = nextPeriodEnd(nextStart, targetCatalogue?.interval ?? 'forever')
    const targetStatus = targetPlan === Plan.free && (subscription.cancelAtPeriodEnd || subscription.status === PlanSubscriptionStatus.cancelled) ? PlanSubscriptionStatus.expired : PlanSubscriptionStatus.active
    let applied = false
    await db.$transaction(async tx => {
      const updated = await tx.userPlanSubscription.updateMany({ where: { id: subscription.id, version: subscription.version }, data: { plan: targetPlan, status: targetStatus, trialStartsAt: null, trialEndsAt: null, currentPeriodStart: nextStart, currentPeriodEnd: nextEnd, cancelAtPeriodEnd: false, scheduledPlan: null, scheduledAt: null, version: { increment: 1 }, updatedById: 'system:subscription-lifecycle' } })
      if (updated.count !== 1) return
      applied = true
      if (subscription.user.plan !== targetPlan) {
        await tx.user.update({ where: { id: subscription.userId }, data: { plan: targetPlan } })
        await tx.userPlanChange.create({ data: { userId: subscription.userId, fromPlan: subscription.user.plan, toPlan: targetPlan, reason: scheduled ? 'Scheduled plan change reached its billing boundary' : 'Subscription lifecycle advanced', actorUserId: 'system:subscription-lifecycle' } })
      }
    })
    if (!applied) continue
    if (scheduled) appliedDowngrades += 1
    else if (targetStatus === PlanSubscriptionStatus.expired) expired += 1
    else renewed += 1
  }
  return { processed: renewed + expired, renewed, expired, appliedDowngrades }
}
