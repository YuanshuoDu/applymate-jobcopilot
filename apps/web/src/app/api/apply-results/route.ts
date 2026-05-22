/**
 * GET /api/apply-results
 * Returns the authenticated user's full auto-apply history,
 * joined with Job data for display context.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { db } from '@/lib/db'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const results = await db.$queryRaw`
    SELECT
      ar.id,
      ar.job_id       AS "jobId",
      ar.status,
      ar.mode,
      ar.ats_type     AS "atsType",
      ar.flow_used    AS "flowUsed",
      ar.error,
      ar.duration_ms  AS "durationMs",
      ar.created_at   AS "createdAt",
      j.role          AS "jobTitle",
      j.company       AS "jobCompany",
      j.url           AS "jobUrl"
    FROM apply_results ar
    LEFT JOIN "Job" j ON j.id = ar.job_id
    WHERE ar.user_id = ${auth.userId}
    ORDER BY ar.created_at DESC
    LIMIT 50
  `

  return ok({ results })
}
