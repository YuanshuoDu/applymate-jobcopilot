/**
 * GET /api/agent/run
 *
 * Server-Sent Events stream — runs the 6-stage Agent Pipeline:
 *   Scout → Analyze → Prepare → Gate → Execute → Audit
 *
 * SSE event types:
 *   stage_start — { stage, label }                          new in v2
 *   stage_done  — { stage, ...metrics }                     new in v2
 *   start       — { total }
 *   job_start   — { jobId, company, role }
 *   job_done    — { jobId, company, role, score, autoApplied, … }
 *   job_skip    — { jobId, company, role, reason }
 *   job_error   — { jobId, company, role, error }
 *   info        — { message }
 *   done        — { processed, applied, pending, skipped, failed, durationMs }
 *   error       — { message }
 */
import { NextRequest }                              from 'next/server'
import { db }                                       from '@/lib/db'
import { err, prepareAiRoute, sseResponse }          from '@/lib/api-helpers'
import { runAgentPipeline }                          from '@/lib/agent/run-service'
import { hasEffectiveEntitlement }                   from '@/lib/entitlements'
import { recordLegacyTraffic }                       from '@/lib/observability/legacy-counter'

const ACTIVE_CANONICAL_TURN_STATUSES = [
  'queued',
  'in_progress',
  'waiting_for_dependency',
  'waiting_for_approval',
  'waiting_for_user',
] as const

const LEGACY_ENTRY_FENCE_CODE = 'legacy_agent_run_blocked_by_active_turn'

export async function GET(req: NextRequest) {
  recordLegacyTraffic('agent_run_endpoint')
  recordLegacyTraffic('agent_stream_connect')
  const prep = await prepareAiRoute(req, 'agent', 'job_discovery')
  if ('error' in prep) return prep.error
  if (!(await hasEffectiveEntitlement(prep.userId, 'auto_apply'))) return err('Your current plan does not include autonomous applications.', 403)

  // autonomous=true → never pause, make all decisions automatically
  const autonomous = req.nextUrl.searchParams.get('autonomous') === 'true'
  const requestedSessionId = req.nextUrl.searchParams.get('sessionId')
  let sessionId: string | undefined
  if (requestedSessionId) {
    const existing = await db.agentSession.findFirst({
      where: { id: requestedSessionId, userId: prep.userId },
      select: { id: true },
    })
    if (!existing) return err('Session not found', 404)
    sessionId = existing.id

    const activeTurn = await db.agentTurn.findFirst({
      where: {
        sessionId: existing.id,
        userId: prep.userId,
        status: { in: [...ACTIVE_CANONICAL_TURN_STATUSES] },
      },
      select: { id: true },
    })
    if (activeTurn) {
      return Response.json({
        error: 'A canonical agent turn is already active for this session.',
        code: LEGACY_ENTRY_FENCE_CODE,
      }, { status: 409 })
    }
  }

  return sseResponse(async emit => {
    await runAgentPipeline({ userId: prep.userId, aiConfig: prep.cfg, sessionId, autonomous, emit })
  })
}
