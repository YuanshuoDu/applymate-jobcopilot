import type pg from "pg"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { lockTaskGraphScope } from "./subagents/task-graph-pg-state.js"
export { STEERING_RECONCILIATION_BLOCKER, STEERING_RECONCILIATION_FEEDBACK } from "./subagents/steering-reconciliation-contract.js"
import { readSteeringReconciliationState, readSteeringReconciliationStateForTerminal } from "./subagents/steering-reconciliation-read.js"
import { assertSessionTerminalAdmission, isSessionPauseRequestedError, revokeSessionTerminalAdmissionsForClient, SessionPauseRequestedError,
  type SessionTerminalAdmission } from "./session-gate.js"

type Client = Pick<pg.PoolClient, "query">
type Pool = Pick<pg.Pool, "connect">
type Row = Record<string, unknown>

function rootHasPlanningAction(root: Row): boolean {
  const actions: unknown = root.allowedActions
  if (!Array.isArray(actions) || actions.length > 256
    || !actions.every(action => typeof action === "string" && action.trim() === action && action.length > 0)
    || new Set(actions).size !== actions.length) throw new Error("steering_reconciliation_planning_root_invalid")
  return actions.includes("agent.plan")
}

function exactPlannerRoot(root: Row, scope: TaskGraphExecutionScope): boolean {
  return root.id === scope.rootTaskId && root.rootTaskId === scope.rootTaskId && root.parentTaskId === null
    && root.role === "orchestrator" && root.taskType === "root" && rootHasPlanningAction(root)
}

async function lockPlannerStep(client: Client, scope: TaskGraphExecutionScope, admissionDenied: SessionPauseRequestedError): Promise<void> {
  const result = await client.query<Row>(`SELECT "id" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4
      AND "status" = 'streaming' AND "attempt" = $5 FOR UPDATE`,
  [scope.stepId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentAttemptCount])
  if (result.rows.length !== 1) throw admissionDenied
}

async function terminalAdmissionForLockedPlanner(client: Client, scope: TaskGraphExecutionScope,
  admissionDenied: SessionPauseRequestedError): Promise<SessionTerminalAdmission> {
  const turn = await client.query<Row>(`SELECT "source", "executionMode" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
      AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "status" = 'in_progress' FOR UPDATE`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion])
  const row = turn.rows.length === 1 ? turn.rows[0] : null
  if (!row || typeof row.source !== "string" || !(row.executionMode === null || typeof row.executionMode === "string")) {
    throw admissionDenied
  }
  return assertSessionTerminalAdmission(client, { sessionId: scope.sessionId, userId: scope.userId,
    turnId: scope.turnId, rootTaskId: scope.rootTaskId, source: row.source, executionMode: row.executionMode })
}

/** Reads the owned current-Step ledger before native proof checks; terminal commit repeats the guard atomically. */
export async function hasUnresolvedPlanningSteering(pool: Pool, scope: TaskGraphExecutionScope): Promise<boolean> {
  const client = await pool.connect()
  let committed = false
  let admission: SessionTerminalAdmission | undefined
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    let root: Row
    let hasPlannerRoot: boolean
    try {
      root = await lockTaskGraphScope(client, scope, true)
      hasPlannerRoot = rootHasPlanningAction(root)
    }
    catch (error: unknown) {
      if (!isSessionPauseRequestedError(error)) throw error
      root = await lockTaskGraphScope(client, scope, false)
      let plannerRoot = false
      try { plannerRoot = exactPlannerRoot(root, scope) } catch { throw error }
      if (!plannerRoot) throw error
      await lockPlannerStep(client, scope, error)
      admission = await terminalAdmissionForLockedPlanner(client, scope, error)
      hasPlannerRoot = true
    }
    if (!hasPlannerRoot) {
      await client.query("COMMIT")
      committed = true
      return false
    }
    const state = admission
      ? await readSteeringReconciliationStateForTerminal(client, scope, admission)
      : await readSteeringReconciliationState(client, scope)
    await client.query("COMMIT")
    committed = true
    return state.unresolvedInputs.length > 0
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    revokeSessionTerminalAdmissionsForClient(client)
    client.release()
  }
}

/** The terminal verifier uses its already-locked transaction client for this raw pending-input check. */
export async function hasPendingSteerOrInvalidResult(client: Client, scope: TaskGraphReadScope): Promise<boolean> {
  const result = await client.query<{ hasPendingSteer: unknown }>(`SELECT EXISTS (
    SELECT 1 FROM "agent_inputs"
    WHERE "sessionId" = $1 AND "userId" = $2 AND "targetTurnId" = $3
      AND "delivery" = 'steer' AND "status" IN ('accepted', 'queued')
      AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL
  ) AS "hasPendingSteer"`, [scope.sessionId, scope.userId, scope.turnId])
  const rows: unknown = result?.rows
  if (!Array.isArray(rows) || rows.length !== 1) return true
  const row = rows[0]
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 1 || !Object.hasOwn(row, "hasPendingSteer")) return true
  return (row as Row).hasPendingSteer !== false
}
