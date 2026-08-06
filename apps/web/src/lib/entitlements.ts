import { db } from '@/lib/db'

export type RuntimeEntitlementKind = 'boolean' | 'limit' | 'text'
export type RuntimeEntitlementSource = 'plan' | 'override'

export interface RuntimeEntitlement {
  featureKey: string
  kind: RuntimeEntitlementKind
  enabled: boolean
  limit: number | null
  textValue: string | null
  source: RuntimeEntitlementSource
  expiresAt: Date | null
}

export async function resolveEntitlement(userId: string, featureKey: string, now = new Date()): Promise<RuntimeEntitlement | null> {
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { plan: true } })
    if (!user) return null

    const [catalogue, override] = await Promise.all([
      db.planCatalog.findUnique({ where: { plan: user.plan }, select: { entitlements: { where: { featureKey }, select: { featureKey: true, kind: true, enabled: true, limit: true, textValue: true } } } }),
      db.userFeatureOverride.findUnique({ where: { userId_featureKey: { userId, featureKey } }, select: { featureKey: true, enabled: true, limit: true, expiresAt: true } }),
    ])
    const base = catalogue?.entitlements[0]
    const activeOverride = override && (!override.expiresAt || override.expiresAt > now) ? override : null

    if (activeOverride) {
      const overrideKind = base?.kind ?? (activeOverride.limit !== null ? 'limit' : 'boolean')
      return {
        featureKey: activeOverride.featureKey,
        kind: entitlementKind(overrideKind),
        enabled: activeOverride.enabled,
        limit: activeOverride.limit,
        textValue: base?.textValue ?? null,
        source: 'override',
        expiresAt: activeOverride.expiresAt,
      }
    }
    if (!base) return catalogue ? { featureKey, kind: 'boolean', enabled: false, limit: null, textValue: null, source: 'plan', expiresAt: null } : null
    return { featureKey: base.featureKey, kind: entitlementKind(base.kind), enabled: base.enabled, limit: base.limit, textValue: base.textValue, source: 'plan', expiresAt: null }
  } catch {
    // The catalogue is additive. Keep older deployments usable until migrations and seed complete.
    return null
  }
}

export async function isFeatureAllowed(userId: string, featureKey: string): Promise<boolean> {
  const entitlement = await resolveEntitlement(userId, featureKey)
  if (entitlement === null) return true
  if (!entitlement.enabled) return false
  return entitlement.kind !== 'limit' || entitlement.limit === null || entitlement.limit > 0
}

export async function resolveEntitlementLimit(userId: string, featureKey: string): Promise<number | null> {
  const entitlement = await resolveEntitlement(userId, featureKey)
  if (!entitlement || entitlement.kind !== 'limit') return null
  return entitlement.limit
}

export type AiAccessDecision = 'allowed' | 'disabled' | 'exhausted'

export async function resolveAiAccess(userId: string, now = new Date()): Promise<AiAccessDecision> {
  const entitlement = await resolveEntitlement(userId, 'ai_credits', now)
  if (entitlement === null) return 'allowed'
  if (!entitlement.enabled || (entitlement.kind === 'limit' && entitlement.limit === 0)) return 'disabled'
  if (entitlement.kind !== 'limit' || entitlement.limit === null) return 'allowed'

  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  try {
    const rows = await db.$queryRaw<Array<{ used: number; limit: number }>>`
      SELECT used, "limit"
      FROM ai_budgets
      WHERE user_id = ${userId} AND month = ${month}
      LIMIT 1
    `
    const row = rows[0]
    return !row || Number(row.used) < entitlement.limit ? 'allowed' : 'exhausted'
  } catch {
    // Budget tracking was added after the original AI routes; missing tables must not break old deployments.
    return 'allowed'
  }
}

export async function isAiBudgetAvailable(userId: string, now = new Date()): Promise<boolean> {
  return (await resolveAiAccess(userId, now)) === 'allowed'
}

function entitlementKind(value: unknown): RuntimeEntitlementKind {
  return value === 'limit' || value === 'text' ? value : 'boolean'
}
