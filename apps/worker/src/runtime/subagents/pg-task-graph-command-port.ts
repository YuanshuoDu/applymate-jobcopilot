import type { PoolClient } from "pg"
import type { TaskGraphCommandPort, TaskGraphScheduleInput, TaskGraphScheduleReceipt, TaskGraphReadScope, TaskGraphCurrentState, TaskGraphNativeCommandInput, TaskGraphNativeCommandReceipt } from "./task-graph-command-port.js"
import { TaskGraphCommandError } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"
import { transaction, type Queryable } from "./pg-store-persistence.js"
import { lockTaskGraphScope, loadTaskGraph, currentTaskGraph } from "./task-graph-pg-state.js"
import { buildTaskGraphPlanningFacts } from "./task-graph-planning-facts.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { writePlanReceipt } from "./task-graph-pg-events.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { normalizeNativeCommand } from "./task-graph-native-request.js"
import { appendNativeGraphCommand, findNativeCommandReplay } from "./task-graph-native-pg.js"
import { replaceUnstartedNativeFollowup } from "./task-graph-native-pending-replacement.js"
import { assertPlanningRootHasNoUnresolvedSteering } from "./pg-store-create.js"
import { prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import type { TaskGraphResultPageRequest } from "./task-graph-result-page-contract.js"
import { projectTaskGraphResultPage } from "./task-graph-result-page.js"

const MAX_REVISION = 2_147_483_646
type Row = Record<string, unknown>

export function createPgTaskGraphCommandPort(pool: PgSubagentPool): TaskGraphCommandPort {
  return {
    async appendAndSchedule(input: TaskGraphScheduleInput): Promise<TaskGraphScheduleReceipt> {
      return transaction(pool, client => schedule(client, input))
    },
    async appendAndScheduleWithReconciliation(input, operation) {
      if (operation.decision !== "revise" || operation.expectedRevision !== input.proposal.expectedRevision
        || !sameExecutionScope(input.scope, operation.scope)) throw new TaskGraphCommandError("steering_reconciliation_operation_invalid", "Plan reconciliation scope is invalid")
      return transaction(pool, client => schedule(client, input, operation))
    },
    async reconcileSteering(operation) {
      if (operation.decision !== "keep") throw new TaskGraphCommandError("steering_reconciliation_operation_invalid", "Keep reconciliation scope is invalid")
      return transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [operation.scope.userId])
        await lockTaskGraphScope(client, operation.scope, true)
        const prepared = await prepareSteeringReconciliation(client, operation)
        if (prepared) await writeSteeringReconciliationReceipt(client, prepared, operation.expectedRevision)
        return { decision: "keep", revision: operation.expectedRevision, reconciledInputCount: prepared?.steerInputIds.length ?? 0 }
      })
    },
    async appendNativeCoordination(input: TaskGraphNativeCommandInput): Promise<TaskGraphNativeCommandReceipt> {
      const command = normalizeNativeCommand(input)
      return transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
        const parent = await lockTaskGraphScope(client, input.scope, true)
        if (await hasPersistedPlanReceipt(client, input.scope) && !await hasCurrentGraphItem(client, input.scope)) {
          throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
        }
        const replay = await findNativeCommandReplay(client, input, command)
        if (replay) return replay
        const loaded = await loadTaskGraph(client, input.scope)
        if (!loaded.item && await hasPersistedPlanReceipt(client, input.scope)) {
          throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
        }
        currentTaskGraph(loaded)
        if (command.request.kind === "followup" && "mode" in command.request && command.request.mode === "replace_unstarted") {
          return replaceUnstartedNativeFollowup(client, input, command, parent, loaded)
        }
        return appendNativeGraphCommand(client, input, command, parent, loaded)
      })
    },
    async readCurrent(scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> {
      return transaction(pool, client => readCurrentWithClient(client, scope))
    },
    async readCurrentResultPage(scope, request) {
      return transaction(pool, client => readCurrentResultPageWithClient(client, scope, request))
    },
    readCurrentWithClient(client, scope) { return readCurrentWithClient(client, scope) },
  }
}

function sameExecutionScope(left: TaskGraphScheduleInput["scope"], right: SteeringReconciliationOperation["scope"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.stepId === right.stepId && left.rootTaskId === right.rootTaskId && left.parentTaskId === right.parentTaskId
    && left.turnLeaseOwner === right.turnLeaseOwner && left.turnLeaseVersion === right.turnLeaseVersion
    && left.parentLeaseOwner === right.parentLeaseOwner && left.parentAttemptCount === right.parentAttemptCount
}

async function schedule(client: Queryable, input: TaskGraphScheduleInput, operation?: SteeringReconciliationOperation): Promise<TaskGraphScheduleReceipt> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  const parent = await lockTaskGraphScope(client, input.scope, true)
  const loaded = await loadTaskGraph(client, input.scope)
  const current = loaded.state, revision = current?.revision ?? 0
  const key = taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision)
  const fingerprint = taskGraphFingerprint(input.proposal)
  const replay = await findPlanReplay(client, input, key, fingerprint, taskGraphItemId(input.scope.parentTaskId))
  if (replay) return replay
  const prepared = operation ? await prepareSteeringReconciliation(client, operation) : null
  if (!loaded.item && await hasPersistedPlanReceipt(client, input.scope)) throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
  if (!operation && input.scope.parentTaskId === input.scope.rootTaskId) {
    await assertPlanningRootHasNoUnresolvedSteering(client, parent.allowedActions, input.scope)
  }
  if (input.proposal.expectedRevision !== revision) throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", revision)
  if (revision >= MAX_REVISION) throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", revision)
  const created = await createGraphTasks(client, input, parent, current ?? { revision: 0, nodes: [], appliedEvents: [] }, new Map(loaded.snapshot?.nodes.map(node => [node.key, node.taskId]) ?? []))
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: created.state.revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  await writePlanReceipt(client, { scope: input.scope, state: created.state, snapshot: created.snapshot, expectedRevision: revision,
    now: new Date(), idempotencyKey: key, fingerprint, receipt })
  if (prepared) await writeSteeringReconciliationReceipt(client, prepared, created.state.revision)
  return receipt
}

async function readCurrentWithClient(client: Pick<PoolClient, "query">, scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> {
  const loaded = await loadCurrentWithClient(client, scope)
  const current = currentTaskGraph(loaded)
  const planningFacts = buildTaskGraphPlanningFacts(loaded)
  return planningFacts ? { ...current, planningFacts } : current
}

async function readCurrentResultPageWithClient(client: Pick<PoolClient, "query">, scope: TaskGraphReadScope, request: TaskGraphResultPageRequest) {
  const loaded = await loadCurrentWithClient(client, scope)
  currentTaskGraph(loaded)
  return projectTaskGraphResultPage(loaded, request)
}

async function loadCurrentWithClient(client: Pick<PoolClient, "query">, scope: TaskGraphReadScope) {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  await lockTaskGraphScope(client, scope)
  const loaded = await loadTaskGraph(client, scope, false)
  if (!loaded.item && await hasPersistedPlanReceipt(client, scope)) {
    throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
  }
  return loaded
}

async function hasPersistedPlanReceipt(client: Queryable, scope: TaskGraphReadScope): Promise<boolean> {
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'kind' IN ('proposal', 'native_command')
      AND session."userId" = $4 AND turn."userId" = $4
  ) AS "exists"`, [scope.sessionId, scope.turnId, taskGraphItemId(scope.parentTaskId), scope.userId])
  return (result.rows[0] as Row | undefined)?.exists === true
}

async function hasCurrentGraphItem(client: Queryable, scope: TaskGraphReadScope): Promise<boolean> {
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM "agent_items" AS item
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = 'task_graph' AND turn."userId" = $5 AND session."userId" = $5
  ) AS "exists"`, [taskGraphItemId(scope.parentTaskId), scope.sessionId, scope.turnId, scope.parentTaskId, scope.userId])
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
