import type pg from "pg"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Session = Readonly<{ id: string; userId: string }>
type Wait = Readonly<Record<string, unknown>>
type RetryKind = "waiting" | "ignored"

const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`
const ACTIVE_TURN = `turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`
const ACTIVE_ROOT = `root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`
const DUE = `COALESCE(wait."nextReconcileAt", wait."suspendedAt") <= ($2::timestamptz AT TIME ZONE 'UTC')`
const SESSION_WAIT_SCOPE = `JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId" AND parent."sessionId" = wait."sessionId" AND parent."turnId" = wait."turnId"
  JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
  JOIN "sub_agent_tasks" AS root ON root."id" = parent."rootTaskId" AND root."sessionId" = wait."sessionId" AND root."turnId" = wait."turnId"
  JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = parent."id"`
const ELIGIBLE_WAIT = `wait."status" = 'waiting' AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
  AND parent."parentTaskId" IS NOT NULL AND parent."status" = 'waiting' AND parent."leaseOwner" IS NULL AND parent."leaseExpiresAt" IS NULL
  AND parent."interruptRequestedAt" IS NULL AND (parent."absoluteDeadlineAt" IS NULL OR parent."absoluteDeadlineAt" > ($2::timestamptz AT TIME ZONE 'UTC'))
  AND step."attempt" = parent."attemptCount" AND step."status" = 'waiting_for_tool'
  AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId"
    AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt")
  AND ${OPEN_SESSION} AND ${ACTIVE_TURN} AND ${ACTIVE_ROOT}`

/** Locks a stable page of sessions by their earliest due child wait before limiting the page. */
export async function lockDueChildWaitSessions(client: Queryable, limit: number, checkedAt: Date): Promise<Row[]> {
  const result = await client.query<Row>(`SELECT session."id", session."userId"
    FROM "agent_sessions" AS session
    CROSS JOIN LATERAL (
      SELECT MIN(COALESCE(wait."nextReconcileAt", wait."suspendedAt")) AS "firstDue"
      FROM "agent_wait_conditions" AS wait ${SESSION_WAIT_SCOPE}
      WHERE wait."sessionId" = session."id" AND wait."userId" = session."userId" AND ${ELIGIBLE_WAIT} AND ${DUE}
    ) AS due
    WHERE ${OPEN_SESSION} AND due."firstDue" IS NOT NULL
    ORDER BY due."firstDue" ASC, session."id" ASC
    LIMIT $1 FOR UPDATE OF session SKIP LOCKED`, [limit, checkedAt])
  return result.rows
}

/** Locks one due child wait per session, rechecking all owner and latest-step fences. */
export async function lockDueChildWaitForSession(client: Queryable, session: Session, checkedAt: Date): Promise<Row[]> {
  const result = await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId",
      parent."rootTaskId" AS "rootTaskId", parent."attemptCount" AS "parentAttempt", wait."targetTaskIds", wait."mode", wait."status",
      wait."deadlineAt", to_char(wait."deadlineAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z' AS "deadlineAtUtc",
      wait."matchedTaskIds", wait."result"
    FROM "agent_wait_conditions" AS wait ${SESSION_WAIT_SCOPE}
    JOIN "agent_sessions" AS session ON session."id" = wait."sessionId" AND session."userId" = wait."userId"
    WHERE wait."sessionId" = $1 AND wait."userId" = $3 AND ${ELIGIBLE_WAIT} AND ${DUE}
    ORDER BY COALESCE(wait."nextReconcileAt", wait."suspendedAt") ASC, wait."createdAt" ASC, wait."id" ASC
    LIMIT 1 FOR UPDATE OF parent, step, wait SKIP LOCKED`, [session.id, checkedAt, session.userId])
  return result.rows
}

/** Advances only the exact still-owned wait's scheduler field after a no-progress pass. */
export async function advanceChildWaitSchedule(client: Queryable, wait: Wait, kind: RetryKind): Promise<boolean> {
  const nextSchedule = kind === "waiting"
    ? `LEAST(timezone('UTC', clock_timestamp()) + INTERVAL '5 seconds', wait."deadlineAt")`
    : `timezone('UTC', clock_timestamp()) + INTERVAL '5 seconds'`
  const result = await client.query(`UPDATE "agent_wait_conditions" AS wait SET "nextReconcileAt" = ${nextSchedule}
    WHERE wait."id" = $1 AND wait."userId" = $2 AND wait."sessionId" = $3 AND wait."turnId" = $4
      AND wait."parentTaskId" = $5 AND wait."stepId" = $6 AND wait."status" = 'waiting'
      AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
      AND COALESCE(wait."nextReconcileAt", wait."suspendedAt") <= timezone('UTC', clock_timestamp())
      AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS parent
        JOIN "agent_turns" AS turn ON turn."id" = parent."turnId" AND turn."sessionId" = parent."sessionId"
        JOIN "sub_agent_tasks" AS root ON root."id" = parent."rootTaskId" AND root."sessionId" = parent."sessionId" AND root."turnId" = parent."turnId"
        JOIN "agent_sessions" AS session ON session."id" = parent."sessionId" AND session."userId" = wait."userId"
        JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId"
          AND step."turnId" = wait."turnId" AND step."taskId" = parent."id"
        WHERE parent."id" = wait."parentTaskId" AND parent."sessionId" = wait."sessionId" AND parent."turnId" = wait."turnId"
          AND parent."rootTaskId" = $7 AND parent."attemptCount" = $8 AND parent."parentTaskId" IS NOT NULL
          AND parent."status" = 'waiting' AND parent."leaseOwner" IS NULL AND parent."leaseExpiresAt" IS NULL
          AND parent."interruptRequestedAt" IS NULL AND (parent."absoluteDeadlineAt" IS NULL OR parent."absoluteDeadlineAt" > timezone('UTC', clock_timestamp()))
          AND step."attempt" = parent."attemptCount" AND step."status" = 'waiting_for_tool'
          AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId"
            AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt")
          AND session."status" NOT IN ('aborted', 'archived') AND ${ACTIVE_TURN} AND ${ACTIVE_ROOT})
    RETURNING wait."id"`, [wait.id, wait.userId, wait.sessionId, wait.turnId, wait.parentTaskId, wait.stepId, wait.rootTaskId, wait.parentAttempt])
  return result.rowCount === 1
}

/** Confirms an exact locked candidate is skipped only because its parent deadline elapsed. */
export async function childWaitParentDeadlineElapsed(client: Queryable, wait: Wait): Promise<boolean> {
  const rows = (await client.query<{ expired: unknown }>(`SELECT parent."absoluteDeadlineAt" IS NOT NULL
      AND parent."absoluteDeadlineAt" <= timezone('UTC', clock_timestamp()) AS "expired"
    FROM "agent_wait_conditions" AS wait ${SESSION_WAIT_SCOPE}
    JOIN "agent_sessions" AS session ON session."id" = wait."sessionId" AND session."userId" = wait."userId"
    WHERE wait."id" = $1 AND wait."userId" = $2 AND wait."sessionId" = $3 AND wait."turnId" = $4
      AND wait."parentTaskId" = $5 AND wait."stepId" = $6 AND wait."status" = 'waiting'
      AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
      AND parent."rootTaskId" = $7 AND parent."attemptCount" = $8 AND parent."parentTaskId" IS NOT NULL
      AND parent."status" = 'waiting' AND parent."leaseOwner" IS NULL AND parent."leaseExpiresAt" IS NULL
      AND parent."interruptRequestedAt" IS NULL AND step."attempt" = parent."attemptCount"
      AND step."status" = 'waiting_for_tool'
      AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId"
        AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt")
      AND ${OPEN_SESSION} AND ${ACTIVE_TURN} AND ${ACTIVE_ROOT}`,
  [wait.id, wait.userId, wait.sessionId, wait.turnId, wait.parentTaskId, wait.stepId, wait.rootTaskId, wait.parentAttempt])).rows
  if (rows.length !== 1 || typeof rows[0]?.expired !== "boolean") throw new Error("Child wait parent deadline scope could not be revalidated")
  return rows[0].expired
}
