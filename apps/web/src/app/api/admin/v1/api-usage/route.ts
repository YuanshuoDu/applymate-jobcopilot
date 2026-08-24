import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { db } from '@/lib/db'
import { JOB_API_PROVIDERS } from '@/lib/api-usage/job-api-catalog'
import { quotaPeriodBounds, type QuotaPeriod } from '@/lib/api-usage/quota-period'
import { MODEL_CATALOGUE } from '@/lib/model-router'

type JobRow = { provider: string; operation: string; credentialSource: string; calls: number; jobs: number; errors: number; avgLatency: number | null; lastEventAt: Date | null }
type AiRow = { provider: string; model: string; credentialSource: string; calls: number; inputTokens: number; outputTokens: number; cost: number; errors: number; avgLatency: number | null; lastEventAt: Date | null }
type TrendRow = { day: Date; category: string; calls: number; errors: number; units: number; cost: number }
type OptimizationRow = { eventType: string; provider: string | null; events: number; requestsAvoided: number; jobsReturned: number; netNewJobs: number; validApplyUrls: number; completeDescriptions: number }

const number = (value: unknown) => Number(value ?? 0)
const latestEvent = (rows: Array<{ lastEventAt: Date | string | null }>) => rows.reduce<Date | null>((latest, row) => {
  if (!row.lastEventAt) return latest
  const current = new Date(row.lastEventAt)
  return !latest || current > latest ? current : latest
}, null)

async function loadOptimizationRows(since: Date, provider: string | undefined): Promise<OptimizationRow[]> {
  const providerFilter = provider ? Prisma.sql`AND provider = ${provider}` : Prisma.empty
  try {
    return (await db.$queryRaw<OptimizationRow[]>`
      SELECT event_type AS "eventType", provider, COUNT(*)::int AS events,
        SUM(requests_avoided)::int AS "requestsAvoided", SUM(jobs_returned)::int AS "jobsReturned",
        SUM(net_new_jobs)::int AS "netNewJobs", SUM(valid_apply_urls)::int AS "validApplyUrls",
        SUM(complete_descriptions)::int AS "completeDescriptions"
      FROM discovery_optimization_events
      WHERE created_at >= ${since} ${providerFilter}
      GROUP BY event_type, provider ORDER BY "requestsAvoided" DESC`) ?? []
  } catch {
    return []
  }
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('observability.read', request)
  if (isAdminResponse(actor)) return actor
  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days') ?? '30') || 30, 1), 365)
  const rawProvider = request.nextUrl.searchParams.get('provider')?.trim().toLowerCase() ?? ''
  if (rawProvider && !/^[a-z0-9._-]{1,120}$/.test(rawProvider)) return NextResponse.json({ error: 'Invalid provider filter' }, { status: 400 })
  const provider = rawProvider || undefined
  const jobProviderFilter = provider ? Prisma.sql`AND provider = ${provider}` : Prisma.empty
  const aiProviderFilter = provider ? Prisma.sql`AND provider = ${provider}` : Prisma.empty
  const since = new Date(Date.now() - days * 86_400_000)
  const [jobRows, aiRows, trend, quotas, optimizationRows] = await Promise.all([
    db.$queryRaw<JobRow[]>`
      SELECT provider, operation, credential_source AS "credentialSource",
        SUM(request_count)::int AS calls, SUM(jobs_returned)::int AS jobs,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
        ROUND(AVG(latency_ms))::int AS "avgLatency", MAX(created_at) AS "lastEventAt"
      FROM job_api_usage_events WHERE created_at >= ${since} ${jobProviderFilter}
      GROUP BY provider, operation, credential_source ORDER BY calls DESC`,
    db.$queryRaw<AiRow[]>`
      SELECT provider, model, credential_source AS "credentialSource", COUNT(*)::int AS calls,
        SUM(input_tokens)::int AS "inputTokens", SUM(output_tokens)::int AS "outputTokens",
        COALESCE(SUM(estimated_cost_usd), 0)::float AS cost,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
        ROUND(AVG(latency_ms))::int AS "avgLatency", MAX(created_at) AS "lastEventAt"
      FROM ai_usage_events WHERE created_at >= ${since} ${aiProviderFilter}
      GROUP BY provider, model, credential_source ORDER BY cost DESC, calls DESC`,
    db.$queryRaw<TrendRow[]>`
      SELECT day, category, SUM(calls)::int AS calls, SUM(errors)::int AS errors,
        SUM(units)::float AS units, SUM(cost)::float AS cost FROM (
        SELECT DATE_TRUNC('day', created_at) AS day, 'job' AS category,
          SUM(request_count) AS calls, COUNT(*) FILTER (WHERE status = 'error') AS errors,
          SUM(jobs_returned) AS units, 0::numeric AS cost
        FROM job_api_usage_events WHERE created_at >= ${since} ${jobProviderFilter} GROUP BY DATE_TRUNC('day', created_at)
        UNION ALL
        SELECT DATE_TRUNC('day', created_at), 'ai', COUNT(*), COUNT(*) FILTER (WHERE status = 'error'),
          SUM(input_tokens + output_tokens), SUM(estimated_cost_usd)
        FROM ai_usage_events WHERE created_at >= ${since} ${aiProviderFilter} GROUP BY DATE_TRUNC('day', created_at)
      ) usage GROUP BY day, category ORDER BY day ASC`,
    db.apiQuota.findMany({ where: { enabled: true, ...(provider ? { provider } : {}) }, orderBy: [{ category: 'asc' }, { provider: 'asc' }, { operation: 'asc' }] }),
    loadOptimizationRows(since, provider),
  ])

  const jobStats = new Map<string, JobRow[]>()
  for (const row of jobRows) jobStats.set(row.provider, [...(jobStats.get(row.provider) ?? []), row])
  const providers = JOB_API_PROVIDERS.filter(item => !provider || item.key === provider).map(item => {
    const rows = jobStats.get(item.key) ?? []
    return { ...item, calls: rows.reduce((sum, row) => sum + number(row.calls), 0), jobs: rows.reduce((sum, row) => sum + number(row.jobs), 0), errors: rows.reduce((sum, row) => sum + number(row.errors), 0), avgLatency: rows.length ? Math.round(rows.reduce((sum, row) => sum + number(row.avgLatency), 0) / rows.length) : 0, lastEventAt: latestEvent(rows), operations: rows }
  })

  const quotaUsage = await Promise.all(quotas.map(async quota => {
    const bounds = quotaPeriodBounds(quota.period as QuotaPeriod, quota.resetDay)
    let used = 0
    if (quota.category === 'job') {
      const where = { provider: quota.provider, ...(quota.operation === '*' ? {} : { operation: quota.operation }), credentialSource: 'platform', createdAt: { gte: bounds.start, lt: bounds.end } }
      if (quota.metric === 'jobs') used = number((await db.jobApiUsageEvent.aggregate({ where, _sum: { jobsReturned: true } }))._sum.jobsReturned)
      else used = number((await db.jobApiUsageEvent.aggregate({ where, _sum: { requestCount: true } }))._sum.requestCount)
    } else {
      const rows = await db.aiUsageEvent.aggregate({ where: { provider: quota.provider, credentialSource: 'platform', createdAt: { gte: bounds.start, lt: bounds.end } }, _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true }, _count: true })
      if (quota.metric === 'input_tokens') used = number(rows._sum.inputTokens)
      else if (quota.metric === 'output_tokens') used = number(rows._sum.outputTokens)
      else if (quota.metric === 'cost_usd') used = number(rows._sum.estimatedCostUsd)
      else used = number(rows._count)
    }
    return { ...quota, limit: number(quota.limit), used, remaining: Math.max(0, number(quota.limit) - used), percent: number(quota.limit) ? Number((used / number(quota.limit) * 100).toFixed(1)) : 0, periodStart: bounds.start, periodEnd: bounds.end }
  }))

  const jobCalls = providers.reduce((sum, row) => sum + row.calls, 0)
  const jobErrors = providers.reduce((sum, row) => sum + row.errors, 0)
  const knownAiKeys = new Set(aiRows.map(row => `${row.provider}:${row.model}`))
  const aiProviders = [
    ...aiRows.map(row => ({ ...row, calls: number(row.calls), inputTokens: number(row.inputTokens), outputTokens: number(row.outputTokens), cost: number(row.cost), errors: number(row.errors), avgLatency: number(row.avgLatency) })),
    ...MODEL_CATALOGUE.filter(model => (!provider || model.provider === provider) && !knownAiKeys.has(`${model.provider}:${model.model}`)).map(model => ({ provider: model.provider, model: model.model, credentialSource: 'platform', calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, errors: 0, avgLatency: 0, lastEventAt: null })),
  ]
  const aiCalls = aiProviders.reduce((sum, row) => sum + row.calls, 0)
  const aiErrors = aiProviders.reduce((sum, row) => sum + row.errors, 0)
  const aiCatalogue = [...new Set(MODEL_CATALOGUE.map(model => model.provider))].sort().map(key => ({ key, label: key }))
  const optimization = optimizationRows.reduce((summary, row) => ({
    cacheHits: summary.cacheHits + (row.eventType === 'cache_hit' ? number(row.requestsAvoided) : 0),
    singleflightHits: summary.singleflightHits + (row.eventType === 'singleflight_hit' ? number(row.requestsAvoided) : 0),
    providerSkips: summary.providerSkips + (row.eventType === 'provider_skipped' ? number(row.events) : 0),
    shadowJobs: summary.shadowJobs + (row.eventType === 'shadow_comparison' ? number(row.jobsReturned) : 0),
    shadowNetNewJobs: summary.shadowNetNewJobs + (row.eventType === 'shadow_comparison' ? number(row.netNewJobs) : 0),
    shadowValidApplyUrls: summary.shadowValidApplyUrls + (row.eventType === 'shadow_comparison' ? number(row.validApplyUrls) : 0),
    shadowCompleteDescriptions: summary.shadowCompleteDescriptions + (row.eventType === 'shadow_comparison' ? number(row.completeDescriptions) : 0),
  }), { cacheHits: 0, singleflightHits: 0, providerSkips: 0, shadowJobs: 0, shadowNetNewJobs: 0, shadowValidApplyUrls: 0, shadowCompleteDescriptions: 0 })
  return NextResponse.json({ generatedAt: new Date(), days, provider: provider ?? null,
    catalog: { job: JOB_API_PROVIDERS.map(item => ({ key: item.key, label: item.label })), ai: aiCatalogue },
    freshness: { lastEventAt: latestEvent([...providers, ...aiProviders]) },
    job: { summary: { calls: jobCalls, jobs: providers.reduce((sum, row) => sum + row.jobs, 0), errors: jobErrors, errorRate: jobCalls ? Number((jobErrors / jobCalls * 100).toFixed(1)) : 0 }, providers },
    ai: { summary: { calls: aiCalls, tokens: aiProviders.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0), costUsd: Number(aiProviders.reduce((sum, row) => sum + row.cost, 0).toFixed(6)), errors: aiErrors, errorRate: aiCalls ? Number((aiErrors / aiCalls * 100).toFixed(1)) : 0 }, providers: aiProviders },
    quotas: quotaUsage, optimization, trend: trend.map(row => ({ ...row, calls: number(row.calls), errors: number(row.errors), units: number(row.units), cost: number(row.cost) })),
  }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
