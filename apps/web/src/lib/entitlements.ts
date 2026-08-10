import type { Plan, PlanSubscriptionStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { getPlanCatalogue } from './plan-catalogue'

export type EffectiveEntitlements = {
  plan: Plan
  subscriptionStatus: PlanSubscriptionStatus | null
  subscriptionPeriodEnd: Date | null
  trialEndsAt: Date | null
  entitlements: readonly string[]
  limits: Readonly<Record<string, number | null>>
  overrides: readonly string[]
}

function entitlementKey(value: string) {
  return value.split(':', 1)[0]?.trim() ?? value
}

function entitlementLimit(value: string): number | null {
  const match = value.match(/^[^:]+:(\d+)(?:\/[^:]+)?$/)
  return match ? Number(match[1]) : null
}

export async function getEffectiveEntitlements(userId: string): Promise<EffectiveEntitlements> {
  const [user, plans, overrides] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { plan: true, planSubscription: { select: { status: true, currentPeriodEnd: true, trialEndsAt: true } } } }),
    getPlanCatalogue(false),
    db.userFeatureOverride.findMany({ where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { featureKey: true, enabled: true, limit: true, expiresAt: true } }),
  ])
  const plan = user?.plan ?? 'free'
  const catalogue = plans.find(item => item.key === plan) ?? plans[0]
  const values = new Set(catalogue?.entitlements ?? [])
  const limits: Record<string, number | null> = {}
  for (const value of values) limits[entitlementKey(value)] = entitlementLimit(value)
  const appliedOverrides: string[] = []
  for (const override of overrides) {
    const key = entitlementKey(override.featureKey)
    appliedOverrides.push(key)
    for (const value of [...values]) if (entitlementKey(value) === key) values.delete(value)
    if (override.enabled) {
      values.add(override.limit === null ? key : `${key}:${override.limit}`)
      limits[key] = override.limit
    } else {
      limits[key] = null
    }
  }
  return { plan, subscriptionStatus: user?.planSubscription?.status ?? null, subscriptionPeriodEnd: user?.planSubscription?.currentPeriodEnd ?? null, trialEndsAt: user?.planSubscription?.trialEndsAt ?? null, entitlements: [...values].sort(), limits, overrides: appliedOverrides }
}

export async function hasEffectiveEntitlement(userId: string, key: string) {
  const snapshot = await getEffectiveEntitlements(userId)
  const requested = entitlementKey(key)
  const subscriptionExpired = snapshot.subscriptionStatus === 'expired'
    || (snapshot.subscriptionStatus === 'trialing' && Boolean(snapshot.trialEndsAt && snapshot.trialEndsAt <= new Date()))
    || (snapshot.subscriptionStatus === 'cancelled' && (!snapshot.subscriptionPeriodEnd || snapshot.subscriptionPeriodEnd <= new Date()))
  return !subscriptionExpired && snapshot.entitlements.some(value => entitlementKey(value) === requested)
}
