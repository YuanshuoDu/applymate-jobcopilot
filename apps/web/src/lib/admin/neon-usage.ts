import { pinnedFetch } from '@jobcopilot/shared'

export const NEON_METRIC_NAMES = [
  'compute_unit_seconds',
  'root_branch_bytes_month',
  'child_branch_bytes_month',
  'instant_restore_bytes_month',
  'public_network_transfer_bytes',
  'private_network_transfer_bytes',
  'extra_branches_month',
  'snapshot_storage_bytes_month',
] as const

export type NeonMetricName = (typeof NEON_METRIC_NAMES)[number]
export type NeonMetricUnit = 'cu_seconds' | 'bytes' | 'branch_months'
export type NeonMetric = { name: NeonMetricName; value: number; unit: NeonMetricUnit; estimatedCostUsd: number | null }
export type NeonUsageSnapshot = {
  available: boolean
  period: 'current_month' | 'current_billing_period'
  source: 'neon_consumption_api' | 'neon_project_details'
  sampledAt: string
  plan: string | null
  metrics: NeonMetric[]
  inputBytes: number
  outputBytes: number
  estimatedCostUsd: number | null
  alertThresholdUsd: number | null
  alertTriggered: boolean
}

type Environment = Record<string, string | undefined>
type NeonRequest = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>
type ConsumptionResponse = { projects?: unknown; pagination?: { cursor?: unknown } }
type MetricRate = { rateUsd: number | null }

const GB = 1_000_000_000
const DEFAULT_RATES: Record<'launch' | 'scale', Record<NeonMetricName, MetricRate>> = {
  launch: {
    compute_unit_seconds: { rateUsd: 0.106 / 3600 }, root_branch_bytes_month: { rateUsd: 0.35 / GB }, child_branch_bytes_month: { rateUsd: 0.35 / GB },
    instant_restore_bytes_month: { rateUsd: 0.2 / GB }, public_network_transfer_bytes: { rateUsd: 0.1 / GB }, private_network_transfer_bytes: { rateUsd: 0.01 / GB },
    extra_branches_month: { rateUsd: 0.002 * 730 }, snapshot_storage_bytes_month: { rateUsd: 0.09 / GB },
  },
  scale: {
    compute_unit_seconds: { rateUsd: 0.222 / 3600 }, root_branch_bytes_month: { rateUsd: 0.35 / GB }, child_branch_bytes_month: { rateUsd: 0.35 / GB },
    instant_restore_bytes_month: { rateUsd: 0.2 / GB }, public_network_transfer_bytes: { rateUsd: 0.1 / GB }, private_network_transfer_bytes: { rateUsd: 0.01 / GB },
    extra_branches_month: { rateUsd: 0.002 * 730 }, snapshot_storage_bytes_month: { rateUsd: 0.09 / GB },
  },
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function number(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
function monthStart(now: Date): string { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() }
function configuredNumber(env: Environment, key: string, fallback: number | null): number | null {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}
function planName(value: string | null): 'launch' | 'scale' | null {
  const normalized = value?.toLowerCase() ?? ''
  if (normalized.includes('scale')) return 'scale'
  if (normalized.includes('launch')) return 'launch'
  return null
}
function metricUnit(name: NeonMetricName): NeonMetricUnit {
  return name === 'compute_unit_seconds' ? 'cu_seconds' : name === 'extra_branches_month' ? 'branch_months' : 'bytes'
}

function metricValue(value: unknown): number | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) return number((value as { value?: unknown }).value)
  return number(value)
}

function mergeMetrics(target: Map<NeonMetricName, number>, parsed: { plan: string | null; metrics: Array<{ name: NeonMetricName; value: number }> }): string | null {
  for (const metric of parsed.metrics) target.set(metric.name, (target.get(metric.name) ?? 0) + metric.value)
  return parsed.plan
}

export function parseNeonConsumption(value: unknown): { plan: string | null; metrics: Array<{ name: NeonMetricName; value: number }> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const projects = (value as ConsumptionResponse).projects
  if (!Array.isArray(projects)) return null
  const totals = new Map<NeonMetricName, number>()
  let plan: string | null = null
  for (const project of projects) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) continue
    const periods = (project as { periods?: unknown }).periods
    if (!Array.isArray(periods)) continue
    for (const period of periods) {
      if (!period || typeof period !== 'object' || Array.isArray(period)) continue
      plan ??= text((period as { period_plan?: unknown }).period_plan)
      const metrics = (period as { consumption?: unknown }).consumption
      if (!Array.isArray(metrics)) continue
      for (const entry of metrics) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const values = (entry as { metrics?: unknown }).metrics
        if (!Array.isArray(values)) continue
        for (const metric of values) {
          if (!metric || typeof metric !== 'object' || Array.isArray(metric)) continue
          const name = text((metric as { metric_name?: unknown }).metric_name)
          const parsed = name && (NEON_METRIC_NAMES as readonly string[]).includes(name) ? metricValue((metric as { value?: unknown }).value) : null
          if (parsed !== null) {
            const typedName = name as NeonMetricName
            totals.set(typedName, (totals.get(typedName) ?? 0) + parsed)
          }
        }
      }
    }
  }
  return { plan, metrics: [...totals.entries()].map(([name, value]) => ({ name, value })) }
}

export function parseNeonProjectDetails(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as { data_transfer_bytes?: unknown; project?: { data_transfer_bytes?: unknown } }
  return number(record.data_transfer_bytes) ?? number(record.project?.data_transfer_bytes)
}

export function estimateNeonCost(metrics: Array<{ name: NeonMetricName; value: number }>, env: Environment = process.env, plan: string | null = text(env.NEON_PLAN)): number | null {
  const selectedPlan = planName(plan)
  if (!selectedPlan && !['NEON_COST_PER_CU_HOUR', 'NEON_COST_PER_GB_MONTH', 'NEON_COST_PER_INSTANT_RESTORE_GB_MONTH', 'NEON_COST_PER_PUBLIC_NETWORK_GB', 'NEON_COST_PER_PRIVATE_NETWORK_GB', 'NEON_COST_PER_EXTRA_BRANCH_MONTH', 'NEON_COST_PER_SNAPSHOT_GB_MONTH'].some(key => env[key]?.trim())) return null
  const rates = DEFAULT_RATES[selectedPlan ?? 'launch']
  const rate = (name: NeonMetricName): number | null => {
    const overrides: Partial<Record<NeonMetricName, number | null>> = {
      compute_unit_seconds: configuredNumber(env, 'NEON_COST_PER_CU_HOUR', null) === null ? undefined : (configuredNumber(env, 'NEON_COST_PER_CU_HOUR', null) ?? 0) / 3600,
      root_branch_bytes_month: configuredNumber(env, 'NEON_COST_PER_GB_MONTH', null),
      child_branch_bytes_month: configuredNumber(env, 'NEON_COST_PER_GB_MONTH', null),
      instant_restore_bytes_month: configuredNumber(env, 'NEON_COST_PER_INSTANT_RESTORE_GB_MONTH', null),
      public_network_transfer_bytes: configuredNumber(env, 'NEON_COST_PER_PUBLIC_NETWORK_GB', null),
      private_network_transfer_bytes: configuredNumber(env, 'NEON_COST_PER_PRIVATE_NETWORK_GB', null),
      extra_branches_month: configuredNumber(env, 'NEON_COST_PER_EXTRA_BRANCH_MONTH', null),
      snapshot_storage_bytes_month: configuredNumber(env, 'NEON_COST_PER_SNAPSHOT_GB_MONTH', null),
    }
    const override = overrides[name]
    if (override !== undefined && override !== null) return name === 'extra_branches_month' || name === 'compute_unit_seconds' ? override : override / GB
    return rates[name].rateUsd
  }
  const includedGb = configuredNumber(env, 'NEON_PUBLIC_NETWORK_INCLUDED_GB', selectedPlan === 'scale' || selectedPlan === 'launch' ? 100 : 5) ?? 0
  let total = 0
  for (const metric of metrics) {
    const metricRate = rate(metric.name)
    if (metricRate === null) return null
    const billableValue = metric.name === 'public_network_transfer_bytes' ? Math.max(0, metric.value - includedGb * GB) : metric.value
    total += metric.name === 'extra_branches_month' || metric.name === 'compute_unit_seconds' ? billableValue * metricRate : (billableValue / GB) * (metricRate * GB)
  }
  return Number(total.toFixed(6))
}

function metricCost(metric: { name: NeonMetricName; value: number }, env: Environment, plan: string | null): number | null {
  const selectedPlan = planName(plan)
  const rates = DEFAULT_RATES[selectedPlan ?? 'launch']
  const overrideKey: Record<NeonMetricName, string> = {
    compute_unit_seconds: 'NEON_COST_PER_CU_HOUR', root_branch_bytes_month: 'NEON_COST_PER_GB_MONTH', child_branch_bytes_month: 'NEON_COST_PER_GB_MONTH',
    instant_restore_bytes_month: 'NEON_COST_PER_INSTANT_RESTORE_GB_MONTH', public_network_transfer_bytes: 'NEON_COST_PER_PUBLIC_NETWORK_GB', private_network_transfer_bytes: 'NEON_COST_PER_PRIVATE_NETWORK_GB',
    extra_branches_month: 'NEON_COST_PER_EXTRA_BRANCH_MONTH', snapshot_storage_bytes_month: 'NEON_COST_PER_SNAPSHOT_GB_MONTH',
  }
  const override = configuredNumber(env, overrideKey[metric.name], null)
  if (!selectedPlan && override === null) return null
  const perUnit = override === null ? rates[metric.name].rateUsd : metric.name === 'compute_unit_seconds' ? override / 3600 : metric.name === 'extra_branches_month' ? override : override / GB
  if (perUnit === null) return null
  const includedGb = configuredNumber(env, 'NEON_PUBLIC_NETWORK_INCLUDED_GB', selectedPlan ? 100 : 5) ?? 0
  const billable = metric.name === 'public_network_transfer_bytes' ? Math.max(0, metric.value - includedGb * GB) : metric.value
  return Number((billable * perUnit).toFixed(6))
}

export function neonCostAlertThreshold(env: Environment = process.env): number | null { return configuredNumber(env, 'NEON_COST_ALERT_USD', null) }

async function readConsumption(request: NeonRequest, orgId: string, projectId: string | null, now: Date, headers: Record<string, string>): Promise<{ plan: string | null; metrics: Array<{ name: NeonMetricName; value: number }> } | null> {
  const totals = new Map<NeonMetricName, number>()
  let plan: string | null = null
  let cursor: string | null = null
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({ org_id: orgId, from: monthStart(now), to: now.toISOString(), granularity: 'monthly', metrics: NEON_METRIC_NAMES.join(',') })
    if (projectId) params.set('project_ids', projectId)
    if (cursor) params.set('cursor', cursor)
    const response = await request(`https://console.neon.tech/api/v2/consumption_history/v2/projects?${params.toString()}`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const body = await response.json() as unknown
    const parsed = parseNeonConsumption(body)
    if (!parsed) return null
    const pagePlan = mergeMetrics(totals, parsed)
    plan ??= pagePlan
    cursor = body && typeof body === 'object' && !Array.isArray(body) ? text((body as ConsumptionResponse).pagination?.cursor) : null
    if (!cursor) break
  }
  return { plan, metrics: [...totals.entries()].map(([name, value]) => ({ name, value })) }
}

export async function readNeonUsage(env: Environment = process.env, request: NeonRequest = (url, init) => pinnedFetch(url, init)): Promise<NeonUsageSnapshot | null> {
  const apiKey = text(env.NEON_API_KEY)
  const orgId = text(env.NEON_ORG_ID)
  const projectId = text(env.NEON_PROJECT_ID)
  if (!apiKey) return null
  const now = new Date()
  const headers = { Authorization: `Bearer ${apiKey}` }
  if (orgId) {
    try {
      const parsed = await readConsumption(request, orgId, projectId, now, headers)
      if (parsed) {
        const cost = estimateNeonCost(parsed.metrics, env, parsed.plan)
        const alert = neonCostAlertThreshold(env)
        return { available: true, period: 'current_month', source: 'neon_consumption_api', sampledAt: now.toISOString(), plan: parsed.plan, metrics: parsed.metrics.map(metric => ({ ...metric, unit: metricUnit(metric.name), estimatedCostUsd: metricCost(metric, env, parsed.plan) })), inputBytes: 0, outputBytes: parsed.metrics.filter(metric => metric.name === 'public_network_transfer_bytes' || metric.name === 'private_network_transfer_bytes').reduce((sum, metric) => sum + metric.value, 0), estimatedCostUsd: cost, alertThresholdUsd: alert, alertTriggered: cost !== null && alert !== null && cost >= alert }
      }
    } catch { /* Fall back to project details, which is available on all plans. */ }
  }
  if (!projectId) return null
  try {
    const response = await request(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const bytes = parseNeonProjectDetails(await response.json())
    if (bytes === null) return null
    const metrics = [{ name: 'public_network_transfer_bytes' as const, value: bytes }]
    const cost = estimateNeonCost(metrics, env)
    const alert = neonCostAlertThreshold(env)
    return { available: true, period: 'current_billing_period', source: 'neon_project_details', sampledAt: now.toISOString(), plan: text(env.NEON_PLAN), metrics: [{ ...metrics[0], unit: 'bytes', estimatedCostUsd: cost }], inputBytes: 0, outputBytes: bytes, estimatedCostUsd: cost, alertThresholdUsd: alert, alertTriggered: cost !== null && alert !== null && cost >= alert }
  } catch { return null }
}
