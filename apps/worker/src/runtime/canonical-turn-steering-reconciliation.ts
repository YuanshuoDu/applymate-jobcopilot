import type pg from "pg"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { lockTaskGraphScope } from "./subagents/task-graph-pg-state.js"
export { STEERING_RECONCILIATION_BLOCKER, STEERING_RECONCILIATION_FEEDBACK } from "./subagents/steering-reconciliation-contract.js"
import { readSteeringReconciliationState } from "./subagents/steering-reconciliation-read.js"

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

/** Reads the owned current-Step ledger before native proof checks; terminal commit repeats the guard atomically. */
export async function hasUnresolvedPlanningSteering(pool: Pool, scope: TaskGraphExecutionScope): Promise<boolean> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const root = await lockTaskGraphScope(client, scope, true)
    if (!rootHasPlanningAction(root)) {
      await client.query("COMMIT")
      committed = true
      return false
    }
    const state = await readSteeringReconciliationState(client, scope)
    await client.query("COMMIT")
    committed = true
    return state.unresolvedInputs.length > 0
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
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
