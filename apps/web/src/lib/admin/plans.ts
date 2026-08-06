export const PLAN_KEYS = ['free', 'pro', 'enterprise'] as const
export type PlanKey = typeof PLAN_KEYS[number]

export const OVERRIDE_FEATURE_KEYS = [
  'ai_credits', 'job_discovery', 'auto_apply', 'tailored_resume', 'cover_letter', 'gmail_tracking', 'api_access',
] as const

export type EntitlementKind = 'boolean' | 'limit' | 'text'

export interface PlanMetadata {
  name: string
  description?: string
  monthlyPriceCents: number
  yearlyPriceCents: number
  currency: string
}

export interface EntitlementValue {
  featureKey: string
  kind: EntitlementKind
  enabled: boolean
  limit?: number
  textValue?: string
}

export interface TransitionValue {
  fromPlan: PlanKey
  toPlan: PlanKey
  enabled: boolean
  note?: string
}

export interface FeatureOverrideValue {
  featureKey: typeof OVERRIDE_FEATURE_KEYS[number]
  enabled: boolean
  limit?: number | null
  expiresAt?: Date
}

export function validatePlanMetadata(input: unknown): PlanMetadata {
  const row = record(input)
  const name = requiredText(row.name, 'Plan name', 80)
  return {
    name,
    description: optionalText(row.description, 500),
    monthlyPriceCents: nonNegativeCents(row.monthlyPriceCents, 'Monthly price'),
    yearlyPriceCents: nonNegativeCents(row.yearlyPriceCents, 'Yearly price'),
    currency: currency(row.currency),
  }
}

export function validateEntitlement(input: unknown): EntitlementValue {
  const row = record(input)
  const featureKey = featureKeyValue(row.featureKey)
  const kind = row.kind
  if (kind !== 'boolean' && kind !== 'limit' && kind !== 'text') throw new Error('Invalid entitlement kind')
  const enabled = row.enabled
  if (typeof enabled !== 'boolean') throw new Error('Entitlement enabled must be boolean')
  if (kind === 'limit') return { featureKey, kind, enabled, limit: boundedInteger(row.limit, 'Entitlement limit') }
  if (kind === 'text') return { featureKey, kind, enabled, textValue: requiredText(row.textValue, 'Entitlement text', 500) }
  return { featureKey, kind, enabled }
}

export function validatePlanTransition(input: unknown, activePlans: ReadonlySet<PlanKey>): TransitionValue {
  const row = record(input)
  const fromPlan = planKey(row.fromPlan, 'Source plan')
  const toPlan = planKey(row.toPlan, 'Target plan')
  if (fromPlan === toPlan) throw new Error('A plan cannot transition to itself')
  const enabled = row.enabled === undefined ? true : row.enabled
  if (typeof enabled !== 'boolean') throw new Error('Transition enabled must be boolean')
  if (enabled && (!activePlans.has(fromPlan) || !activePlans.has(toPlan))) throw new Error('Enabled transitions require active plans')
  return { fromPlan, toPlan, enabled, note: optionalText(row.note, 500) }
}

export function validateFeatureOverride(input: unknown, now = new Date()): FeatureOverrideValue {
  const row = record(input)
  const featureKey = row.featureKey
  if (typeof featureKey !== 'string' || !(OVERRIDE_FEATURE_KEYS as readonly string[]).includes(featureKey)) throw new Error('Unknown feature override')
  if (typeof row.enabled !== 'boolean') throw new Error('Override enabled must be boolean')
  const limit = row.limit === null || row.limit === undefined ? row.limit : boundedInteger(row.limit, 'Override limit')
  const expiresAt = row.expiresAt === undefined || row.expiresAt === null ? undefined : parseFutureDate(row.expiresAt, now)
  return { featureKey: featureKey as FeatureOverrideValue['featureKey'], enabled: row.enabled, limit, expiresAt }
}

export function planKey(value: unknown, field = 'Plan'): PlanKey {
  if (typeof value !== 'string' || !(PLAN_KEYS as readonly string[]).includes(value)) throw new Error(`${field} is invalid`)
  return value as PlanKey
}

function featureKeyValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(value)) throw new Error('Feature key is invalid')
  return value
}

function nonNegativeCents(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) throw new Error(`${field} must be a non-negative integer in cents`)
  return value
}

function boundedInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000_000) throw new Error(`${field} must be a bounded non-negative integer`)
  return value
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${field} is required`)
  return value.trim()
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim().length > max) throw new Error('Text value is too long')
  return value.trim()
}

function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) throw new Error('Currency must be a three-letter code')
  return value.trim().toUpperCase()
}

function parseFutureDate(value: unknown, now: Date): Date {
  const result = value instanceof Date ? value : new Date(typeof value === 'string' ? value : '')
  if (Number.isNaN(result.getTime()) || result <= now) throw new Error('Expiry must be a future date')
  return result
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
