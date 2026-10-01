import type { PoolClient } from "pg"
import type { TaskGraphCommandPort, TaskGraphScheduleInput, TaskGraphScheduleReceipt, TaskGraphReadScope, TaskGraphCurrentState } from "./task-graph-command-port.js"
import { TaskGraphCommandError } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"
import { transaction, type Queryable } from "./pg-store-persistence.js"
import { lockTaskGraphScope, loadTaskGraph, currentTaskGraph } from "./task-graph-pg-state.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { writePlanReceipt } from "./task-graph-pg-events.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"

const MAX_REVISION = 2_147_483_646
type Row = Record<string, unknown>

export function createPgTaskGraphCommandPort(pool: PgSubagentPool): TaskGraphCommandPort {
  return {
    async appendAndSchedule(input: TaskGraphScheduleInput): Promise<TaskGraphScheduleReceipt> {
      return transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
        const parent = await lockTaskGraphScope(client, input.scope)
        const loaded = await loadTaskGraph(client, input.scope)
        const current = loaded.state
        const revision = current?.revision ?? 0
        const key = taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision)
        const fingerprint = taskGraphFingerprint(input.proposal)
        const replay = await findPlanReplay(client, input, key, fingerprint, taskGraphItemId(input.scope.parentTaskId))
        if (replay) return replay
        if (!loaded.item && await hasPersistedPlanReceipt(client, input.scope)) {
          throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
        }
        if (input.proposal.expectedRevision !== revision) throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", revision)
        if (revision >= MAX_REVISION) throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", revision)
        const created = await createGraphTasks(client, input, parent, current ?? { revision: 0, nodes: [], appliedEvents: [] }, new Map(loaded.snapshot?.nodes.map(node => [node.key, node.taskId]) ?? []))
        const receipt: TaskGraphScheduleReceipt = {
          status: "accepted", revision: created.state.revision, nodes: created.created, readyTaskIds: created.readyTaskIds,
        }
        await writePlanReceipt(client, {
          scope: input.scope, state: created.state, snapshot: created.snapshot, expectedRevision: revision,
          now: new Date(), idempotencyKey: key, fingerprint, receipt,
        })
        return receipt
      })
    },
    async readCurrent(scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> {
      return transaction(pool, client => readCurrentWithClient(client, scope))
    },
    readCurrentWithClient(client, scope) { return readCurrentWithClient(client, scope) },
  }
}

async function readCurrentWithClient(client: Pick<PoolClient, "query">, scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  await lockTaskGraphScope(client, scope)
  const loaded = await loadTaskGraph(client, scope, false)
  if (!loaded.item && await hasPersistedPlanReceipt(client, scope)) {
    throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
  }
  return currentTaskGraph(loaded)
}

async function hasPersistedPlanReceipt(client: Queryable, scope: TaskGraphReadScope): Promise<boolean> {
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'kind' = 'proposal'
      AND session."userId" = $4 AND turn."userId" = $4
  ) AS "exists"`, [scope.sessionId, scope.turnId, taskGraphItemId(scope.parentTaskId), scope.userId])
  return (result.rows[0] as Row | undefined)?.exists === true
}

async function findPlanReplay(client: Queryable, input: TaskGraphScheduleInput, key: string, fingerprint: string, itemId: string | null): Promise<TaskGraphScheduleReceipt | null> {
  if (!itemId) return null
  const result = await client.query(`SELECT event."payload" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."idempotencyKey" = $4 AND session."userId" = $5 AND turn."userId" = $5`,
  [input.scope.sessionId, input.scope.turnId, itemId, key, input.scope.userId])
  if (!result.rows[0]) return null
  const payload = object((result.rows[0] as Row).payload)
  if (payload?.kind !== "proposal" || payload.fingerprint !== fingerprint) throw new TaskGraphCommandError("idempotency_conflict", "TaskGraph proposal key was already used", undefined)
  const receipt = parseReceipt(payload.receipt)
  if (!receipt) throw new Error("task_graph_receipt_invalid")
  return { ...receipt, status: "duplicate" }
}

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}

function parseReceipt(value: unknown): Omit<TaskGraphScheduleReceipt, "status"> | null {
  const row = object(value)
  if (!row || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Array.isArray(row.nodes) || !Array.isArray(row.readyTaskIds)) return null
  const nodes: Array<{ key: string; taskId: string; status: "queued" | "waiting" }> = []
  for (const value of row.nodes) {
    const node = object(value)
    if (!node || typeof node.key !== "string" || typeof node.taskId !== "string" || (node.status !== "queued" && node.status !== "waiting")) return null
    nodes.push({ key: node.key, taskId: node.taskId, status: node.status })
  }
  if (row.readyTaskIds.some(id => typeof id !== "string") || nodes.length === 0) return null
  return { revision: Number(row.revision), nodes, readyTaskIds: [...row.readyTaskIds] as string[] }
}
