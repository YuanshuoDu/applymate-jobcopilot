import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

type QualityRow = { atsType: string; calls: number; successes: number; directCalls: number; directSuccesses: number; avgDuration: number | null }
type TrendRow = { day: Date; calls: number; successes: number; directCalls: number; directSuccesses: number }

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('ats.read', request)
  if (isAdminResponse(actor)) return actor
  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days') ?? '30') || 30, 1), 365)
  const atsType = request.nextUrl.searchParams.get('atsType')?.trim() ?? ''
  const since = new Date(Date.now() - days * 86_400_000)
  const filter = atsType ? Prisma.sql`AND ats_type = ${atsType}` : Prisma.empty
  const [sources, trend] = await Promise.all([
    db.$queryRaw<QualityRow[]>`
      SELECT COALESCE(ats_type, 'unknown') AS "atsType", COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status = 'submitted')::int AS successes,
        COUNT(*) FILTER (WHERE mode = 'unattended')::int AS "directCalls",
        COUNT(*) FILTER (WHERE mode = 'unattended' AND status = 'submitted')::int AS "directSuccesses",
        ROUND(AVG(duration_ms))::int AS "avgDuration"
      FROM apply_results WHERE created_at >= ${since} ${filter}
      GROUP BY ats_type ORDER BY calls DESC
    `,
    db.$queryRaw<TrendRow[]>`
      SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status = 'submitted')::int AS successes,
        COUNT(*) FILTER (WHERE mode = 'unattended')::int AS "directCalls",
        COUNT(*) FILTER (WHERE mode = 'unattended' AND status = 'submitted')::int AS "directSuccesses"
      FROM apply_results WHERE created_at >= ${since} ${filter}
      GROUP BY DATE_TRUNC('day', created_at) ORDER BY day ASC
    `,
  ])
  const serialize = (row: QualityRow | TrendRow) => ({ ...row, calls: Number(row.calls), successes: Number(row.successes), directCalls: Number(row.directCalls), directSuccesses: Number(row.directSuccesses), successRate: row.calls ? Number((row.successes / row.calls * 100).toFixed(1)) : 0, directSuccessRate: row.directCalls ? Number((row.directSuccesses / row.directCalls * 100).toFixed(1)) : 0, ...('avgDuration' in row ? { avgDuration: Number(row.avgDuration ?? 0) } : {}) })
  return NextResponse.json({ days, sources: sources.map(serialize), trend: trend.map(serialize) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
