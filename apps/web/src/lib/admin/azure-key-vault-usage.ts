import { getAzureManagementToken, pinnedFetch } from '@jobcopilot/shared'

export type AzureKeyVaultMetricName = 'service_api_hits' | 'service_api_results'
export type AzureKeyVaultMetric = { name: AzureKeyVaultMetricName; value: number; unit: 'requests'; estimatedCostUsd: null }
export type AzureKeyVaultUsageSnapshot = {
  available: boolean
  period: 'current_month'
  source: 'azure_monitor_metrics' | 'azure_cost_management'
  sampledAt: string
  totalOperations: number
  totalResults: number
  avgLatencyMs: number
  cost: number | null
  currency: string | null
  alertThreshold: number | null
  maxBudget: number | null
  alertTriggered: boolean
  metrics: AzureKeyVaultMetric[]
}

type Environment = Record<string, string | undefined>
type AzureRequest = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>
type AzureTokenProvider = () => Promise<string | null>
type MetricSeries = { name?: { value?: unknown }; timeseries?: unknown }
type CostResponse = { properties?: { columns?: unknown; rows?: unknown } }
type ParsedMetrics = { totalOperations: number; totalResults: number; avgLatencyMs: number; metrics: AzureKeyVaultMetric[] }
type ParsedCost = { cost: number; currency: string | null }
type UsageConfig = { resourceId: string; costScope: string | null; cacheTtlSeconds: number }
type UsageCache = { key: string; expiresAt: number; snapshot: AzureKeyVaultUsageSnapshot }

const METRICS_API_VERSION = '2023-10-01'
const COST_API_VERSION = '2025-03-01'
const DEFAULT_CACHE_TTL_SECONDS = 15 * 60
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const RESOURCE_ID = new RegExp(`^/subscriptions/${UUID}/resourceGroups/[^/]+/providers/Microsoft\\.KeyVault/vaults/[^/]+$`, 'i')
const SCOPE = new RegExp(`^/subscriptions/${UUID}(?:/resourceGroups/[^/]+)?$`, 'i')
let usageCache: UsageCache | null = null

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function nonNegative(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
function positiveOrNull(value: unknown): number | null {
  const parsed = nonNegative(value)
  return parsed !== null && parsed > 0 ? parsed : null
}
function monthStart(now: Date): string { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() }
function cacheTtl(env: Environment): number {
  const value = Number(env.AZURE_USAGE_CACHE_TTL_SECONDS)
  return Number.isFinite(value) && value >= 60 ? Math.min(Math.trunc(value), 86_400) : DEFAULT_CACHE_TTL_SECONDS
}

export function azureKeyVaultUsageConfig(env: Environment = process.env): UsageConfig | null {
  const resourceId = text(env.AZURE_KEY_VAULT_RESOURCE_ID)
  if (!resourceId || !RESOURCE_ID.test(resourceId)) return null
  const configuredScope = text(env.AZURE_COST_MANAGEMENT_SCOPE)
  const subscriptionId = text(env.AZURE_SUBSCRIPTION_ID)
  const costScope = configuredScope ?? (subscriptionId ? `/subscriptions/${subscriptionId}` : null)
  return { resourceId, costScope: costScope && SCOPE.test(costScope) ? costScope : null, cacheTtlSeconds: cacheTtl(env) }
}

export function parseAzureMonitorMetrics(value: unknown): ParsedMetrics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { value?: unknown }).value)) return null
  let totalOperations = 0
  let totalResults = 0
  let latencyTotal = 0
  let latencySamples = 0
  for (const rawSeries of (value as { value: unknown[] }).value) {
    if (!rawSeries || typeof rawSeries !== 'object' || Array.isArray(rawSeries)) continue
    const series = rawSeries as MetricSeries
    const name = text(series.name?.value)?.toLowerCase()
    const timeseries = Array.isArray(series.timeseries) ? series.timeseries : []
    for (const rawTimeSeries of timeseries) {
      if (!rawTimeSeries || typeof rawTimeSeries !== 'object' || Array.isArray(rawTimeSeries)) continue
      const data = Array.isArray((rawTimeSeries as { data?: unknown }).data) ? (rawTimeSeries as { data: unknown[] }).data : []
      for (const rawPoint of data) {
        if (!rawPoint || typeof rawPoint !== 'object' || Array.isArray(rawPoint)) continue
        const point = rawPoint as { total?: unknown; average?: unknown }
        if (name === 'serviceapihit') totalOperations += nonNegative(point.total) ?? 0
        if (name === 'serviceapiresult') totalResults += nonNegative(point.total) ?? 0
        if (name === 'serviceapilatency') {
          const average = nonNegative(point.average)
          if (average !== null) { latencyTotal += average; latencySamples += 1 }
        }
      }
    }
  }
  return {
    totalOperations: Math.trunc(totalOperations), totalResults: Math.trunc(totalResults),
    avgLatencyMs: latencySamples ? Math.round(latencyTotal / latencySamples) : 0,
    metrics: [
      { name: 'service_api_hits', value: Math.trunc(totalOperations), unit: 'requests', estimatedCostUsd: null },
      { name: 'service_api_results', value: Math.trunc(totalResults), unit: 'requests', estimatedCostUsd: null },
    ],
  }
}

export function parseAzureCostManagement(value: unknown): ParsedCost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const properties = (value as CostResponse).properties
  const columns = Array.isArray(properties?.columns) ? properties.columns : []
  const rows = Array.isArray(properties?.rows) ? properties.rows : []
  const names = columns.map(column => column && typeof column === 'object' && !Array.isArray(column) ? text((column as { name?: unknown }).name)?.toLowerCase() : null)
  const costIndex = names.findIndex(name => name === 'pretaxcost' || name === 'cost')
  const currencyIndex = names.findIndex(name => name === 'currency')
  if (costIndex < 0) return null
  let cost = 0
  const currencies = new Set<string>()
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const parsed = nonNegative(row[costIndex])
    if (parsed !== null) cost += parsed
    const currency = text(currencyIndex >= 0 ? row[currencyIndex] : null)?.toUpperCase()
    if (currency) currencies.add(currency)
  }
  if (currencies.size > 1) return null
  return { cost: Number(cost.toFixed(6)), currency: [...currencies][0] ?? null }
}

export function azureKeyVaultCostAlert(env: Environment = process.env): number | null { return positiveOrNull(env.AZURE_COST_ALERT_USD) }
export function azureKeyVaultMaxBudget(env: Environment = process.env): number | null { return positiveOrNull(env.AZURE_MAX_BUDGET_USD) }

const defaultRequest: AzureRequest = (url, init) => pinnedFetch(url, init)
const defaultToken: AzureTokenProvider = () => getAzureManagementToken()

export async function readAzureKeyVaultUsage(env: Environment = process.env, request: AzureRequest = defaultRequest, tokenProvider: AzureTokenProvider = defaultToken): Promise<AzureKeyVaultUsageSnapshot | null> {
  const config = azureKeyVaultUsageConfig(env)
  if (!config) return null
  const token = await tokenProvider()
  if (!token) return null
  const now = new Date()
  const cacheKey = `${config.resourceId}|${config.costScope ?? ''}`
  const threshold = azureKeyVaultCostAlert(env)
  const currencyOverride = text(env.AZURE_COST_CURRENCY)?.toUpperCase() ?? null
  if (usageCache && usageCache.key === cacheKey && usageCache.expiresAt > Date.now()) return withAlert(usageCache.snapshot, threshold, currencyOverride, env)
  const headers = { Authorization: `Bearer ${token}` }
  const metricParams = new URLSearchParams({ timespan: `${monthStart(now)}/${now.toISOString()}`, interval: 'PT1H', metricnames: 'ServiceApiHit,ServiceApiResult,ServiceApiLatency', aggregation: 'total,average', 'api-version': METRICS_API_VERSION, metricnamespace: 'Microsoft.KeyVault/vaults' })
  const metricUrl = `https://management.azure.com${config.resourceId}/providers/Microsoft.Insights/metrics?${metricParams}`
  const costUrl = config.costScope ? `https://management.azure.com${config.costScope}/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}` : null
  const [metrics, cost] = await Promise.all([
    request(metricUrl, { headers, signal: AbortSignal.timeout(10_000) }).then(async response => response.ok ? parseAzureMonitorMetrics(await response.json()) : null).catch(() => null),
    costUrl ? request(costUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'ActualCost', timeframe: 'MonthToDate', dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } }, filter: { dimensions: { name: 'ResourceId', operator: 'In', values: [config.resourceId] } } } }), signal: AbortSignal.timeout(10_000) }).then(async response => response.ok ? parseAzureCostManagement(await response.json()) : null).catch(() => null) : Promise.resolve(null),
  ])
  if (!metrics && !cost) return null
  const snapshot: AzureKeyVaultUsageSnapshot = {
    available: true, period: 'current_month', source: cost ? 'azure_cost_management' : 'azure_monitor_metrics', sampledAt: now.toISOString(),
    totalOperations: metrics?.totalOperations ?? 0, totalResults: metrics?.totalResults ?? 0, avgLatencyMs: metrics?.avgLatencyMs ?? 0,
    cost: cost?.cost ?? null, currency: cost?.currency ?? currencyOverride, alertThreshold: threshold, maxBudget: azureKeyVaultMaxBudget(env), alertTriggered: false,
    metrics: metrics?.metrics ?? [],
  }
  usageCache = { key: cacheKey, expiresAt: Date.now() + config.cacheTtlSeconds * 1000, snapshot }
  return withAlert(snapshot, threshold, currencyOverride, env)
}

function withAlert(snapshot: AzureKeyVaultUsageSnapshot, threshold: number | null, currencyOverride: string | null, env: Environment): AzureKeyVaultUsageSnapshot {
  const currency = snapshot.currency ?? currencyOverride
  const comparable = currency?.toUpperCase() === 'USD' || currency?.toUpperCase() === text(env.AZURE_COST_ALERT_CURRENCY)?.toUpperCase()
  return { ...snapshot, currency, alertThreshold: threshold, maxBudget: azureKeyVaultMaxBudget(env), alertTriggered: comparable && snapshot.cost !== null && threshold !== null && snapshot.cost >= threshold }
}
