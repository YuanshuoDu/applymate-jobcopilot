import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

type OverallRow = {
  total: number | null
  successRate: number | null
  programmatic: number | null
  patternCache: number | null
  llm: number | null
  avgDurationMs: number | null
  captchaErrors: number | null
  last24h: number | null
  last24hSuccessRate: number | null
}

type AtsRow = { atsType: string | null; count: number; successRate: number | null }
type TrendRow = { day: Date; count: number; successRate: number | null }

export async function getObservabilitySnapshot(options: { days?: number; atsType?: string } = {}) {
  const days = options.days && options.days >= 1 && options.days <= 3_650 ? Math.trunc(options.days) : 3_650
  const since = new Date(Date.now() - days * 24 * 60 * 60_000)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000)
  const atsFilter = options.atsType ? Prisma.sql`AND ats_type = ${options.atsType}` : Prisma.empty
  const [overallRows, byAtsRows, trendRows, registeredUsers, registrationsLast7d, usersByPlan, sources, overdueCases] = await Promise.all([
    db.$queryRaw`
    SELECT COUNT(*)::int AS total,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'submitted') / NULLIF(COUNT(*), 0), 1)::float, 0) AS "successRate",
      COUNT(*) FILTER (WHERE flow_used = 'programmatic')::int AS programmatic,
      COUNT(*) FILTER (WHERE flow_used = 'pattern-cache')::int AS "patternCache",
      COUNT(*) FILTER (WHERE flow_used = 'llm')::int AS llm,
      COALESCE(ROUND(AVG(duration_ms))::int, 0) AS "avgDurationMs",
      COUNT(*) FILTER (WHERE error ILIKE '%captcha%')::int AS "captchaErrors",
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS "last24h",
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'submitted' AND created_at > NOW() - INTERVAL '24 hours') / NULLIF(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0), 1)::float, 0) AS "last24hSuccessRate"
    FROM apply_results WHERE created_at >= ${since} ${atsFilter}
  ` as Promise<OverallRow[]>,
    db.$queryRaw`
    SELECT COALESCE(ats_type, 'unknown') AS "atsType", COUNT(*)::int AS count,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'submitted') / NULLIF(COUNT(*), 0), 1)::float, 0) AS "successRate"
    FROM apply_results WHERE created_at >= ${since} ${atsFilter} GROUP BY ats_type ORDER BY count DESC
  ` as Promise<AtsRow[]>,
    db.$queryRaw`
    SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*)::int AS count,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'submitted') / NULLIF(COUNT(*), 0), 1)::float, 0) AS "successRate"
    FROM apply_results WHERE created_at >= ${since} ${atsFilter}
    GROUP BY DATE_TRUNC('day', created_at) ORDER BY day ASC
  ` as Promise<TrendRow[]>,
    db.user.count(),
    db.user.count({ where: { createdAt: { gte: weekAgo } } }),
    db.user.groupBy({ by: ['plan'], _count: { id: true } }),
    db.atsEmployer.aggregate({ _count: { id: true }, _sum: { jobCount: true } }),
    db.supportCase.count({ where: { slaDueAt: { lt: new Date() }, status: { notIn: ['resolved', 'closed'] } } }),
  ])
  const row = overallRows[0]
  const total = Number(row?.total ?? 0)
  const programmatic = Number(row?.programmatic ?? 0)
  const patternCache = Number(row?.patternCache ?? 0)
  const llm = Number(row?.llm ?? 0)
  const captchaErrors = Number(row?.captchaErrors ?? 0)
  return {
    overall: {
      total,
      successRate: Number(row?.successRate ?? 0),
      byFlowUsed: { programmatic, patternCache, llm, unknown: Math.max(total - programmatic - patternCache - llm, 0) },
      avgDurationMs: Number(row?.avgDurationMs ?? 0),
      captchaRate: total > 0 ? Number(((captchaErrors / total) * 100).toFixed(1)) : 0,
      captchaErrors,
      last24h: { count: Number(row?.last24h ?? 0), successRate: Number(row?.last24hSuccessRate ?? 0) },
    },
    byAts: byAtsRows.map((ats) => ({ atsType: ats.atsType ?? 'unknown', count: Number(ats.count ?? 0), successRate: Number(ats.successRate ?? 0) })),
    trend: trendRows.map((trend) => ({ day: trend.day, count: Number(trend.count ?? 0), successRate: Number(trend.successRate ?? 0) })),
    platform: {
      registeredUsers,
      registrationsLast7d,
      plans: Object.fromEntries(usersByPlan.map((row) => [row.plan, row._count.id])),
      sources: { employers: sources._count.id, jobs: sources._sum.jobCount ?? 0 },
      overdueSupportCases: overdueCases,
    },
  }
}
