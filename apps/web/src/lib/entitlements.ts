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

export type EntitlementDecision = {
  allowed: boolean
  key: string
  limit: number | null
  usage: number
  reason: 'available' | 'missing' | 'expired' | 'limit_reached'
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
  const value = snapshot.entitlements.find(item => entitlementKey(item) === requested)
  const limit = value ? entitlementLimit(value) : null
  return !subscriptionExpired && Boolean(value) && (limit === null || limit > 0)
}

export async function checkEntitlementLimit(userId: string, key: string, usage: number): Promise<EntitlementDecision> {
  const snapshot = await getEffectiveEntitlements(userId)
  const requested = entitlementKey(key)
  const value = snapshot.entitlements.find(item => entitlementKey(item) === requested)
  const limit = value ? entitlementLimit(value) : null
  const expired = snapshot.subscriptionStatus === 'expired'
    || (snapshot.subscriptionStatus === 'trialing' && Boolean(snapshot.trialEndsAt && snapshot.trialEndsAt <= new Date()))
    || (snapshot.subscriptionStatus === 'cancelled' && (!snapshot.subscriptionPeriodEnd || snapshot.subscriptionPeriodEnd <= new Date()))
  if (!value) return { allowed: false, key: requested, limit: null, usage, reason: 'missing' }
  if (expired) return { allowed: false, key: requested, limit, usage, reason: 'expired' }
  if (limit !== null && usage >= limit) return { allowed: false, key: requested, limit, usage, reason: 'limit_reached' }
  return { allowed: true, key: requested, limit, usage, reason: 'available' }
}
