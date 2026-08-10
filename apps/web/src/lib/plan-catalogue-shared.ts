export const PLAN_KEYS = ['free', 'pro', 'enterprise'] as const
export type PlanKey = typeof PLAN_KEYS[number]

export const BILLING_INTERVALS = ['forever', 'month', 'year'] as const
export type BillingInterval = typeof BILLING_INTERVALS[number]

export type PlanCatalogueRecord = {
  id?: string
  version?: number
  key: PlanKey
  name: string
  priceMinor: number
  currency: string
  interval: BillingInterval
  description: string
  features: string[]
  entitlements: string[]
  badge: string | null
  cta: string
  trialDays: number
  active: boolean
  sortOrder: number
}

export type PublicPlan = Omit<PlanCatalogueRecord, 'priceMinor' | 'active' | 'sortOrder'> & {
  price: string
  period: string
}

export const DEFAULT_PLAN_CATALOGUE: readonly PlanCatalogueRecord[] = [
  {
    key: 'free',
    name: 'Free',
    priceMinor: 0,
    currency: 'EUR',
    interval: 'forever',
    description: 'Get started for free',
    features: ['5 applications/month', 'Basic CV tailoring', 'Job tracker (20 jobs)', 'Extension popup'],
    entitlements: ['applications:5/month', 'cv:basic', 'tracker:20', 'extension:popup', 'ai_credits:25', 'job_discovery:20', 'tailored_resume', 'cover_letter:5'],
    badge: null,
    cta: 'Get started free',
    trialDays: 0,
    active: true,
    sortOrder: 0,
  },
  {
    key: 'pro',
    name: 'Pro',
    priceMinor: 1200,
    currency: 'EUR',
    interval: 'month',
    description: 'Best for serious job seekers',
    features: ['Unlimited applications', 'AI CV tailoring per role', 'Unlimited tracker', 'Full sidebar', 'AI cover letters', 'Gmail integration', 'Priority support'],
    entitlements: ['applications:unlimited', 'cv:tailoring', 'tracker:unlimited', 'extension:sidebar', 'cover_letters:ai', 'auto_apply', 'gmail:connected', 'support:priority', 'ai_credits:1000', 'job_discovery:1000', 'tailored_resume', 'cover_letter:100', 'gmail_tracking'],
    badge: 'Most popular',
    cta: 'Start free trial',
    trialDays: 14,
    active: true,
    sortOrder: 1,
  },
  {
    key: 'enterprise',
    name: 'Team',
    priceMinor: 2900,
    currency: 'EUR',
    interval: 'month',
    description: 'For teams and recruiters',
    features: ['Everything in Pro', '5 team seats', 'Shared job pool', 'Analytics dashboard', 'Custom AI model', 'Dedicated support'],
    entitlements: ['plan:pro', 'seats:5', 'jobs:shared', 'analytics:dashboard', 'ai:custom_model', 'auto_apply', 'support:dedicated', 'ai_credits:10000', 'job_discovery:10000', 'tailored_resume', 'cover_letter:1000', 'gmail_tracking', 'api_access'],
    badge: null,
    cta: 'Contact sales',
    trialDays: 0,
    active: true,
    sortOrder: 2,
  },
]

const DEFAULT_BY_KEY = new Map(DEFAULT_PLAN_CATALOGUE.map(plan => [plan.key, plan]))

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function boundedText(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback
}

function planKey(value: unknown): PlanKey {
  return typeof value === 'string' && PLAN_KEYS.includes(value as PlanKey) ? value as PlanKey : 'free'
}

function billingInterval(value: unknown): BillingInterval {
  return typeof value === 'string' && BILLING_INTERVALS.includes(value as BillingInterval)
    ? value as BillingInterval
    : 'month'
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback
}

function normalizedFeatures(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 20)
}

function normalizedEntitlements(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 40)
}

export function normalizePlanRow(value: unknown): PlanCatalogueRecord {
  const input = asRecord(value)
  const key = planKey(input.plan ?? input.key)
  const fallback = DEFAULT_BY_KEY.get(key) ?? DEFAULT_BY_KEY.get('free')!
  const currency = boundedText(input.currency, fallback.currency, 3).toUpperCase()
  const features = normalizedFeatures(input.features)
  const entitlements = normalizedEntitlements(input.entitlements)

  return {
    id: typeof input.id === 'string' ? input.id : undefined,
    version: boundedInteger(input.version, 1, 1, 1_000_000),
    key,
    name: boundedText(input.name, fallback.name, 80),
    priceMinor: boundedInteger(input.priceMinor, fallback.priceMinor, 0, 10_000_000),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : fallback.currency,
    interval: billingInterval(input.interval),
    description: boundedText(input.description, fallback.description, 240),
    features: features.length ? features : [...fallback.features],
    entitlements: entitlements.length ? entitlements : [...fallback.entitlements],
    badge: typeof input.badge === 'string' && input.badge.trim() ? input.badge.trim().slice(0, 60) : null,
    cta: boundedText(input.cta, fallback.cta, 80),
    trialDays: boundedInteger(input.trialDays, fallback.trialDays, 0, 365),
    active: typeof input.active === 'boolean' ? input.active : fallback.active,
    sortOrder: boundedInteger(input.sortOrder, fallback.sortOrder, 0, 1000),
  }
}

export function formatPlanPrice(input: Pick<PlanCatalogueRecord, 'priceMinor' | 'currency'>): string {
  const currency = /^[A-Z]{3}$/.test(input.currency) ? input.currency : 'EUR'
  const fractionDigits = input.priceMinor % 100 === 0 ? 0 : 2
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: 2,
  }).format(input.priceMinor / 100)
}

export function toPublicPlan(plan: PlanCatalogueRecord): PublicPlan {
  return {
    key: plan.key,
    name: plan.name,
    price: formatPlanPrice(plan),
    currency: plan.currency,
    interval: plan.interval,
    period: plan.interval,
    description: plan.description,
    features: [...plan.features],
    entitlements: [...plan.entitlements],
    badge: plan.badge,
    cta: plan.cta,
    trialDays: plan.trialDays,
  }
}
