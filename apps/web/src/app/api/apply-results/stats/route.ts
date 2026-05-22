/**
 * GET /api/apply-results/stats
 * Aggregate statistics for the authenticated user's auto-apply history.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { db } from '@/lib/db'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const rows = await db.$queryRaw`
    SELECT
      COUNT(*)::int                                            AS total,
      COUNT(*) FILTER (WHERE status = 'submitted')::int        AS submitted,
      COUNT(*) FILTER (WHERE status = 'manual')::int           AS manual,
      COUNT(*) FILTER (WHERE status = 'failed')::int           AS failed,
      COUNT(*) FILTER (WHERE status = 'dry-run')::int          AS "dryRun",
      COUNT(*) FILTER (WHERE flow_used = 'programmatic')::int  AS programmatic,
      COUNT(*) FILTER (WHERE flow_used = 'llm')::int           AS llm,
      ROUND(AVG(duration_ms) FILTER (WHERE status = 'submitted'))::int AS "avgDurationMs"
    FROM apply_results
    WHERE user_id = ${auth.userId}
  `

  const stats = (rows as unknown[])[0] ?? {
    total: 0, submitted: 0, manual: 0, failed: 0, dryRun: 0,
    programmatic: 0, llm: 0, avgDurationMs: null,
  }

  return ok({ stats })
}
