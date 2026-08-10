import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { db } from '@/lib/db'

type TrendRow = { day: Date; calls: number; errors: number; cost: number; avgLatency: number | null }
type ProviderRow = { provider: string; model: string; calls: number; errors: number; cost: number; avgLatency: number | null }

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('ai_budget.read', request)
  if (isAdminResponse(actor)) return actor
  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days') ?? '30') || 30, 1), 365)
  const since = new Date(Date.now() - days * 86_400_000)
  const [trend, providers] = await Promise.all([
    db.$queryRaw<TrendRow[]>`
      SELECT DATE_TRUNC('day', created_at) AS day,
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
        COALESCE(SUM(estimated_cost_usd), 0)::float AS cost,
        ROUND(AVG(latency_ms))::int AS "avgLatency"
      FROM ai_usage_events WHERE created_at >= ${since}
      GROUP BY DATE_TRUNC('day', created_at) ORDER BY day ASC
    `,
    db.$queryRaw<ProviderRow[]>`
      SELECT provider, model, COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
        COALESCE(SUM(estimated_cost_usd), 0)::float AS cost,
        ROUND(AVG(latency_ms))::int AS "avgLatency"
      FROM ai_usage_events WHERE created_at >= ${since}
      GROUP BY provider, model ORDER BY cost DESC, calls DESC
    `,
  ])
  const calls = trend.reduce((sum, row) => sum + Number(row.calls ?? 0), 0)
  const errors = trend.reduce((sum, row) => sum + Number(row.errors ?? 0), 0)
  const cost = trend.reduce((sum, row) => sum + Number(row.cost ?? 0), 0)
  return NextResponse.json({ days, summary: { calls, errors, errorRate: calls ? Number((errors / calls * 100).toFixed(1)) : 0, costUsd: Number(cost.toFixed(6)) }, trend: trend.map(row => ({ ...row, calls: Number(row.calls), errors: Number(row.errors), cost: Number(row.cost), avgLatency: Number(row.avgLatency ?? 0) })), providers: providers.map(row => ({ ...row, calls: Number(row.calls), errors: Number(row.errors), cost: Number(row.cost), avgLatency: Number(row.avgLatency ?? 0) })) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
