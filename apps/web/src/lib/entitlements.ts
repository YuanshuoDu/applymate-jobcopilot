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

export type RuntimeEntitlementKind = 'boolean' | 'limit' | 'text'
export type RuntimeEntitlement = {
  featureKey: string
  kind: RuntimeEntitlementKind
  enabled: boolean
  limit: number | null
  textValue: string | null
  source: 'plan' | 'override'
  expiresAt: Date | null
}

/** Compatibility API for older user-facing AI routes while the catalogue uses JSON entitlements. */
export async function resolveEntitlement(userId: string, featureKey: string): Promise<RuntimeEntitlement | null> {
  const snapshot = await getEffectiveEntitlements(userId)
  const requested = entitlementKey(featureKey)
  const value = snapshot.entitlements.find(item => entitlementKey(item) === requested)
  if (!value && !snapshot.overrides.includes(requested)) return { featureKey: requested, kind: 'boolean', enabled: false, limit: null, textValue: null, source: 'plan', expiresAt: null }
  const limit = value ? entitlementLimit(value) : snapshot.limits[requested] ?? null
  return {
    featureKey: requested,
    kind: limit !== null ? 'limit' : 'boolean',
    enabled: Boolean(value) && (limit === null || limit > 0),
    limit,
    textValue: null,
    source: snapshot.overrides.includes(requested) ? 'override' : 'plan',
    expiresAt: null,
  }
}

export async function isFeatureAllowed(userId: string, featureKey: string) {
  return hasEffectiveEntitlement(userId, featureKey)
}

export type AiAccessDecision = 'allowed' | 'disabled' | 'exhausted'

export async function resolveAiAccess(userId: string, now = new Date()): Promise<AiAccessDecision> {
  const snapshot = await getEffectiveEntitlements(userId)
  const limit = snapshot.limits.ai_credits
  if (!hasEntitlement(snapshot, 'ai_credits')) return 'disabled'
  if (limit === null) return 'allowed'
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  try {
    const rows = await db.$queryRaw<Array<{ used: number }>>`
      SELECT used FROM ai_budgets WHERE user_id = ${userId} AND month = ${month} LIMIT 1
    `
    return Number(rows[0]?.used ?? 0) < limit ? 'allowed' : 'exhausted'
  } catch {
    return 'allowed'
  }
}

function hasEntitlement(snapshot: EffectiveEntitlements, key: string) {
  const requested = entitlementKey(key)
  const value = snapshot.entitlements.find(item => entitlementKey(item) === requested)
  const limit = value ? entitlementLimit(value) : null
  return Boolean(value) && (limit === null || limit > 0)
}
