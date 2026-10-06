import type { LeasePool } from "../turns/lease.js"
import { reconcileSessionPause, resumeSession } from "./pause-coordinator.js"

export const SESSION_CONTROL_RECOVERY_MAX_BATCH = 50

type Candidate = {
  userId: string
  sessionId: string
  turnId: string
  status: "pausing" | "resuming"
}

export type SessionControlRecoveryReport = {
  scanned: number
  reconciled: number
  failed: number
}

/** Finds bounded, event-backed pause/resume transitions without holding locks during reconciliation. */
export async function reconcilePendingSessionControls(pool: LeasePool): Promise<SessionControlRecoveryReport> {
  const client = await pool.connect()
  let candidates: Candidate[]
  try {
    const result = await client.query<Candidate>(
      `SELECT session."userId", session."id" AS "sessionId", control."turnId", session."status"
       FROM "agent_sessions" AS session
       JOIN LATERAL (
         SELECT turn."id" AS "turnId", event."sequence"
         FROM "agent_turns" AS turn
         JOIN "agent_events" AS event
           ON event."sessionId" = session."id" AND event."turnId" = turn."id"
         WHERE turn."sessionId" = session."id" AND turn."userId" = session."userId"
           AND event."actor" = 'user' AND event."taskId" IS NULL AND event."itemId" IS NULL
           AND event."correlationId" = turn."id" AND event."causationId" IS NULL
           AND event."idempotencyKey" LIKE 'agent-session-control:%'
           AND event."payload"->>'turnId' = turn."id"
           AND ((session."status" = 'pausing' AND event."type" = 'session.pause_requested'
                 AND NOT EXISTS (
                   SELECT 1 FROM "agent_events" AS resumed
                   WHERE resumed."sessionId" = event."sessionId" AND resumed."turnId" = turn."id"
                     AND resumed."type" = 'session.resume_requested' AND resumed."actor" = 'user'
                     AND resumed."sequence" > event."sequence"
                 ))
             OR (session."status" = 'resuming' AND event."type" = 'session.resume_requested'))
         ORDER BY event."sequence" DESC, turn."id" ASC
         LIMIT 1
       ) AS control ON TRUE
       WHERE session."status" IN ('pausing', 'resuming')
       ORDER BY session."updatedAt" ASC, session."id" ASC
       LIMIT $1`,
      [SESSION_CONTROL_RECOVERY_MAX_BATCH],
    )
    candidates = result.rows
  } finally {
    client.release()
  }

  let reconciled = 0
  let failed = 0
  for (const candidate of candidates) {
    if (!candidate.userId?.trim() || !candidate.sessionId?.trim() || !candidate.turnId?.trim()) continue
    try {
      if (candidate.status === "pausing") {
        await reconcileSessionPause(pool, { userId: candidate.userId, sessionId: candidate.sessionId, turnId: candidate.turnId })
      } else if (candidate.status === "resuming") {
        await resumeSession(pool, { userId: candidate.userId, sessionId: candidate.sessionId, turnId: candidate.turnId })
      } else {
        continue
      }
      reconciled += 1
    } catch (error: unknown) {
      failed += 1
      console.error("[session-control-recovery] candidate reconciliation failed:", {
        sessionId: candidate.sessionId,
        status: candidate.status,
        error,
      })
    }
  }
  return { scanned: candidates.length, reconciled, failed }
}
