import { randomUUID } from "node:crypto"
import type { LeasePool } from "../turns/lease.js"
import { reconcileSessionPause, resumeSession } from "./pause-coordinator.js"

export const SESSION_CONTROL_RECOVERY_MAX_BATCH = 50
const SESSION_CONTROL_RECOVERY_CLAIM_TTL = "2 minutes"

type Candidate = {
  userId: string
  sessionId: string
  turnId: string
  status: "pausing" | "resuming"
  claimToken: string
}

export type SessionControlRecoveryReport = {
  scanned: number
  reconciled: number
  failed: number
}

async function updateClaim(pool: LeasePool, candidate: Candidate, action: "renew" | "clear"): Promise<boolean> {
  const client = await pool.connect()
  try {
    const result = action === "renew"
      ? await client.query(`UPDATE "agent_sessions" SET "sessionControlRecoveryClaimExpiresAt" = clock_timestamp() + INTERVAL '${SESSION_CONTROL_RECOVERY_CLAIM_TTL}'
          WHERE "id" = $1 AND "sessionControlRecoveryClaimToken" = $2 AND "sessionControlRecoveryClaimExpiresAt" > clock_timestamp()`, [candidate.sessionId, candidate.claimToken])
      : await client.query(`UPDATE "agent_sessions" SET "sessionControlRecoveryClaimToken" = NULL, "sessionControlRecoveryClaimExpiresAt" = NULL
          WHERE "id" = $1 AND "sessionControlRecoveryClaimToken" = $2`, [candidate.sessionId, candidate.claimToken])
    return result.rowCount === 1
  } finally {
    client.release()
  }
}

/** Finds bounded, event-backed pause/resume transitions and claims them without holding locks during reconciliation. */
export async function reconcilePendingSessionControls(pool: LeasePool): Promise<SessionControlRecoveryReport> {
  const client = await pool.connect()
  let candidates: Candidate[] = []
  let claimCommitted = false
  try {
    await client.query("BEGIN")
    const result = await client.query<Omit<Candidate, "claimToken">>(
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
         AND (session."sessionControlRecoveryClaimToken" IS NULL
           OR session."sessionControlRecoveryClaimExpiresAt" IS NULL
           OR session."sessionControlRecoveryClaimExpiresAt" <= clock_timestamp())
       ORDER BY COALESCE(session."sessionControlRecoveryAttemptedAt", session."createdAt"), session."id"
       LIMIT $1
       FOR UPDATE OF session SKIP LOCKED`,
      [SESSION_CONTROL_RECOVERY_MAX_BATCH],
    )
    if (result.rows.length > 0) {
      const claimTokens = result.rows.map(() => randomUUID())
      const claimed = await client.query(
        `UPDATE "agent_sessions" AS session
         SET "sessionControlRecoveryAttemptedAt" = NOW(),
             "sessionControlRecoveryClaimToken" = claim."claimToken",
             "sessionControlRecoveryClaimExpiresAt" = clock_timestamp() + INTERVAL '${SESSION_CONTROL_RECOVERY_CLAIM_TTL}'
         FROM UNNEST($1::text[], $2::text[]) AS claim("sessionId", "claimToken")
         WHERE session."id" = claim."sessionId"
           AND session."status" IN ('pausing', 'resuming')
           AND (session."sessionControlRecoveryClaimToken" IS NULL
             OR session."sessionControlRecoveryClaimExpiresAt" IS NULL
             OR session."sessionControlRecoveryClaimExpiresAt" <= clock_timestamp())`,
        [result.rows.map(candidate => candidate.sessionId), claimTokens],
      )
      if ((claimed.rowCount ?? 0) !== result.rows.length) {
        throw new Error("session_control_recovery_claim_conflict")
      }
      candidates = result.rows.map((candidate, index) => ({ ...candidate, claimToken: claimTokens[index]! }))
    }

    await client.query("COMMIT")
    claimCommitted = true
  } catch (error: unknown) {
    if (!claimCommitted) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  let reconciled = 0
  let failed = 0
  for (const candidate of candidates) {
    let succeeded = false
    try {
      if (!candidate.userId?.trim() || !candidate.sessionId?.trim() || !candidate.turnId?.trim()) throw new Error("session_control_recovery_candidate_invalid")
      if (!await updateClaim(pool, candidate, "renew")) throw new Error("session_control_recovery_claim_lost")
      if (candidate.status === "pausing") {
        await reconcileSessionPause(pool, { userId: candidate.userId, sessionId: candidate.sessionId, turnId: candidate.turnId, recoveryClaimToken: candidate.claimToken })
      } else if (candidate.status === "resuming") {
        await resumeSession(pool, { userId: candidate.userId, sessionId: candidate.sessionId, turnId: candidate.turnId, recoveryClaimToken: candidate.claimToken })
      } else {
        throw new Error("session_control_recovery_status_invalid")
      }
      succeeded = true
    } catch (error: unknown) {
      console.error("[session-control-recovery] candidate reconciliation failed:", {
        sessionId: candidate.sessionId,
        status: candidate.status,
        error,
      })
    } finally {
      try {
        await updateClaim(pool, candidate, "clear")
      } catch (error: unknown) {
        succeeded = false
        console.error("[session-control-recovery] candidate claim cleanup failed:", { sessionId: candidate.sessionId, error })
      }
    }
    if (succeeded) reconciled += 1
    else failed += 1
  }
  return { scanned: candidates.length, reconciled, failed }
}
