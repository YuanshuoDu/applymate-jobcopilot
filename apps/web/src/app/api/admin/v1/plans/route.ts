import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { err, ok } from '@/lib/api-helpers'
import { writeAdminAudit } from '@/lib/admin/audit'
import { isAdminResponse } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { requirePricingReadAdmin, requirePricingWriteAdmin } from '@/lib/admin/pricing-access'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import { getAdminPlans } from '@/lib/plan-catalogue'
import { BILLING_INTERVALS, PLAN_KEYS, type BillingInterval, type PlanCatalogueRecord, type PlanKey } from '@/lib/plan-catalogue-shared'

const EDITABLE_FIELDS = new Set(['plan', 'key', 'name', 'priceMinor', 'currency', 'interval', 'description', 'features', 'entitlements', 'badge', 'cta', 'trialDays', 'active', 'sortOrder'])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function validKey(value: unknown): value is PlanKey {
  return typeof value === 'string' && PLAN_KEYS.includes(value as PlanKey)
}

function validInterval(value: unknown): value is BillingInterval {
  return typeof value === 'string' && BILLING_INTERVALS.includes(value as BillingInterval)
}

function shortText(value: unknown, label: string, max: number): string | { error: string } {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return { error: `${label} must be a non-empty string of at most ${max} characters` }
  return value.trim()
}

function parsePlan(value: unknown): PlanCatalogueRecord | { error: string } {
  const input = asRecord(value)
  if (Object.keys(input).some(key => !EDITABLE_FIELDS.has(key))) return { error: 'Unsupported plan field' }

  const keyValue = input.plan ?? input.key
  if (!validKey(keyValue)) return { error: 'plan must be free, pro, or enterprise' }
  const name = shortText(input.name, 'name', 80)
  const description = shortText(input.description, 'description', 240)
  const cta = shortText(input.cta, 'cta', 80)
  if (typeof name !== 'string') return name
  if (typeof description !== 'string') return description
  if (typeof cta !== 'string') return cta
  if (typeof input.priceMinor !== 'number' || !Number.isInteger(input.priceMinor) || input.priceMinor < 0 || input.priceMinor > 10_000_000) return { error: 'priceMinor must be an integer between 0 and 10000000' }
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) return { error: 'currency must be an uppercase ISO 4217 code' }
  if (!validInterval(input.interval)) return { error: 'interval must be forever, month, or year' }
  if (!Array.isArray(input.features) || input.features.length > 20 || input.features.some(feature => typeof feature !== 'string' || !feature.trim() || feature.length > 160)) return { error: 'features must contain at most 20 non-empty strings of at most 160 characters' }
  if (!Array.isArray(input.entitlements) || input.entitlements.length > 40 || input.entitlements.some(entitlement => typeof entitlement !== 'string' || !entitlement.trim() || entitlement.length > 120)) return { error: 'entitlements must contain at most 40 non-empty strings of at most 120 characters' }
  if (input.badge !== null && input.badge !== undefined && (typeof input.badge !== 'string' || input.badge.length > 60)) return { error: 'badge must be null or a string of at most 60 characters' }
  if (typeof input.trialDays !== 'number' || !Number.isInteger(input.trialDays) || input.trialDays < 0 || input.trialDays > 365) return { error: 'trialDays must be an integer between 0 and 365' }
  if (typeof input.active !== 'boolean') return { error: 'active must be boolean' }
  if (typeof input.sortOrder !== 'number' || !Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 1000) return { error: 'sortOrder must be an integer between 0 and 1000' }

  return {
    key: keyValue,
    name,
    priceMinor: input.priceMinor,
    currency: input.currency,
    interval: input.interval,
    description,
    features: input.features.map(feature => feature.trim()),
    entitlements: input.entitlements.map(entitlement => entitlement.trim()),
    badge: typeof input.badge === 'string' && input.badge.trim() ? input.badge.trim() : null,
    cta,
    trialDays: input.trialDays,
    active: input.active,
    sortOrder: input.sortOrder,
  }
}

function upsertData(plan: PlanCatalogueRecord) {
  return {
    plan: plan.key,
    name: plan.name,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    interval: plan.interval,
    description: plan.description,
    features: plan.features,
    entitlements: plan.entitlements,
    badge: plan.badge,
    cta: plan.cta,
    trialDays: plan.trialDays,
    active: plan.active,
    sortOrder: plan.sortOrder,
  }
}

export async function GET(req: NextRequest) {
  const actor = await requirePricingReadAdmin(req)
  if (isAdminResponse(actor)) return actor
  const response = ok({ plans: await getAdminPlans() })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('x-request-id', actor.requestId)
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'plans.catalogue_viewed', outcome: 'success' })
  return response
}

export async function PATCH(req: NextRequest) {
  const actor = await requirePricingWriteAdmin(req)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(req)
  if (writeError) return writeError

  const body = await req.json().catch(() => null)
  const input = asRecord(body)
  if (Object.keys(input).some(key => key !== 'plans') || !Array.isArray(input.plans) || input.plans.length === 0) return err('plans must be a non-empty array')

  const current = await getAdminPlans()
  const merged = new Map<PlanKey, PlanCatalogueRecord>(current.map(plan => [plan.key, plan]))
  const seen = new Set<PlanKey>()
  for (const raw of input.plans) {
    const parsed = parsePlan(raw)
    if ('error' in parsed) return err(parsed.error)
    if (seen.has(parsed.key)) return err(`Duplicate plan: ${parsed.key}`)
    seen.add(parsed.key)
    merged.set(parsed.key, parsed)
  }

  const nextPlans = PLAN_KEYS.map(key => merged.get(key)).filter((plan): plan is PlanCatalogueRecord => Boolean(plan))
  const free = nextPlans.find(plan => plan.key === 'free')
  if (!free?.active) return err('Free plan must remain active')

  const mutation = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'plans.catalogue_updated',
    idempotencyKey: req.headers.get('idempotency-key') as string,
    audit: {
      requestId: actor.requestId,
      actorRoleKey: actor.roleKey,
      outcome: 'success',
      before: current,
      after: nextPlans,
    },
    mutate: (tx) => Promise.all(nextPlans.map(plan => tx.planCatalogue.upsert({
      where: { plan: plan.key },
      update: upsertData(plan),
      create: upsertData(plan),
    }))),
  })

  if (mutation.duplicate) {
    const response = ok({ duplicate: true })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('x-request-id', actor.requestId)
    return response
  }

  const plans = await getAdminPlans()
  const response = ok({ plans })
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('x-request-id', actor.requestId)
  return response
}
