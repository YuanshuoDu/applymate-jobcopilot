import type pg from "pg"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { scheduledPrepareGateApprovalWitnessIds, type ScheduledPrepareGateWaitWitness } from "./scheduled-prepare-gate-wait-witness.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Scope = GraphIdentityScope

/** Reads the live Gate Turn snapshot and binds approval waits to the Root's current lease or exact suspension. */
export async function readScheduledGateTurnSnapshot(client: Queryable, scope: Scope, rootAttemptCount: number,
  finishStatus: "waiting_for_user" | "completed", witness: ScheduledPrepareGateWaitWitness): Promise<unknown | null> {
  const allowed = finishStatus === "completed" ? ["in_progress", "waiting_for_dependency", "waiting_for_approval"]
    : ["in_progress", "waiting_for_dependency"]
  const result = await client.query<Row>(`SELECT session."id" AS "sessionId", session."userId" AS "sessionUserId", session."status" AS "sessionStatus",
      turn."id" AS "turnId", turn."sessionId" AS "turnSessionId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId",
      turn."status" AS "turnStatus", turn."source", turn."executionMode", turn."input", turn."leaseOwnerId" AS "turnLeaseOwnerId",
      turn."leaseVersion" AS "turnLeaseVersion", turn."leaseExpiresAt" AS "turnLeaseExpiresAt",
      turn."leaseExpiresAt" > clock_timestamp() AS "turnLeaseValid", root."id" AS "rootId", root."sessionId" AS "rootSessionId",
      root."turnId" AS "rootTurnId", root."status" AS "rootStatus", root."attemptCount" AS "rootAttemptCount",
      root."interruptRequestedAt" AS "rootInterruptRequestedAt", root."closedAt" AS "rootClosedAt"
    FROM "agent_sessions" AS session
    JOIN "agent_turns" AS turn ON turn."sessionId" = session."id" AND turn."userId" = session."userId"
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId" AND root."turnId" = turn."id"
    WHERE session."id" = $1 AND session."userId" = $2 AND session."status" NOT IN ('aborted', 'archived')
      AND turn."id" = $3 AND turn."rootTaskId" = $4 AND turn."status" = ANY($5::text[])
      AND root."id" = $4 AND root."status" IN ('running', 'waiting', 'waiting_for_user')
      AND root."interruptRequestedAt" IS NULL AND root."closedAt" IS NULL`,
  [scope.sessionId, scope.userId, scope.turnId, scope.rootTaskId, allowed])
  const row = result.rows[0]
  if (result.rows.length !== 1 || !row || row.sessionId !== scope.sessionId || row.sessionUserId !== scope.userId
    || ["aborted", "archived"].includes(String(row.sessionStatus)) || row.turnId !== scope.turnId
    || row.turnSessionId !== scope.sessionId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || !allowed.includes(String(row.turnStatus)) || row.rootId !== scope.rootTaskId || row.rootSessionId !== scope.sessionId
    || row.rootTurnId !== scope.turnId || !["running", "waiting", "waiting_for_user"].includes(String(row.rootStatus))
    || !Number.isSafeInteger(row.rootAttemptCount) || Number(row.rootAttemptCount) !== rootAttemptCount
    || Number(row.rootAttemptCount) < 1 || row.rootInterruptRequestedAt != null || row.rootClosedAt != null) return null
  if (row.turnStatus === "waiting_for_approval") {
    const runningLease = row.rootStatus === "running" && validId(row.turnLeaseOwnerId)
      && Number.isSafeInteger(row.turnLeaseVersion) && Number(row.turnLeaseVersion) > 0 && row.turnLeaseValid === true
    const suspendedUnleased = row.rootStatus === "waiting" && row.turnLeaseOwnerId === null && row.turnLeaseExpiresAt === null
    if (!runningLease && !suspendedUnleased) return null
    if (!(await scheduledPrepareGateApprovalWitnessIds(client, scope, witness)).length) return null
  }
  return { source: row.source, executionMode: row.executionMode, input: row.input }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
