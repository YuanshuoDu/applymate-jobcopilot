import { assertPlanningRootHasNoUnresolvedSteering, createSubagentTask } from "./pg-store-create.js"
import { json, type Queryable } from "./pg-store-persistence.js"
import { getSubagentRolePolicy, isHarnessSubagentRole } from "./role-policy.js"
import { appendTaskGraphNativeNode, TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { enqueueGraphTask } from "./task-graph-pg-create.js"
import type { GraphParent, LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_LIMITS, type TaskGraphState } from "../planning/task-graph.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_ITEM_TYPE, taskGraphItemId, taskGraphSnapshot } from "./task-graph-snapshot.js"
import { appendTaskGraphReceipt, writeTaskGraphSnapshot } from "./task-graph-pg-events.js"
import { policyFromTask } from "./manager-task-scope.js"
import { inheritSubagentPolicy, type SubagentTaskRecord, type SubagentTaskStatus } from "./types.js"
import { TaskGraphCommandError, type TaskGraphNativeCommandInput, type TaskGraphNativeCommandReceipt } from "./task-graph-command-port.js"
import { nativeContextMetrics, type NormalizedNativeCommand } from "./task-graph-native-request.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { parsePersistedTaskGraphNativeReceipt } from "./task-graph-native-command.js"
import { taskGraphNativeResultReceipt } from "./task-graph-native-result.js"
import {
  parseSteeringReconciliationReceipt, steeringReconciliationId, steeringReconciliationSequence,
  STEERING_RECONCILIATION_EVENT_TYPE, STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
  STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION, STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION,
  type SteeringReconciliationScope,
} from "./steering-reconciliation-contract.js"
import { assertTaskGraphBranchRepairHistory } from "./steering-reconciliation-branch-repair-history.js"
import { assertTaskGraphFailedBranchRepairHistory } from "./steering-reconciliation-failed-branch-history.js"
import {
  followupContext, graphItem, intersectTaskActions, nativePgObject, taskActions, withVerifiedDependencyContext,
  type TaskGraphNativeSource,
} from "./task-graph-native-pg-context.js"

type Row = Record<string, unknown>
const TERMINAL = new Set<SubagentTaskStatus>(["completed", "failed", "interrupted", "cancelled", "closed"])

export async function findNativeCommandReplay(
  client: Queryable, input: TaskGraphNativeCommandInput, command: NormalizedNativeCommand,
): Promise<TaskGraphNativeCommandReceipt | null> {
  const itemId = taskGraphItemId(input.scope.parentTaskId)
  const result = await client.query(`SELECT event."type", event."itemId", event."taskId", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."idempotencyKey" = $4
      AND session."userId" = $5 AND turn."userId" = $5`,
  [input.scope.sessionId, input.scope.turnId, itemId, command.eventIdempotencyKey, input.scope.userId])
  if (result.rows.length === 0) return null
  if (result.rows.length !== 1) throw new Error("task_graph_native_receipt_invalid")
  const event = result.rows[0] as Row, payload = nativePgObject(event.payload)
  if (!payload || payload.kind !== "native_command" || payload.requestFingerprint !== command.requestFingerprint) throw commandError("idempotency_conflict")
  const revision = Number(payload.revision), snapshot = parseTaskGraphSnapshot(payload.content)
  const receipt = parsePersistedTaskGraphNativeReceipt(payload, {
    type: event.type, itemId: event.itemId, taskId: event.taskId, idempotencyKey: event.idempotencyKey,
  }, { id: itemId, revision }, snapshot, input.scope)
  if (receipt.operationId !== command.operationId || snapshot.nodes.find(node => node.key === receipt.nodeKey)?.nativeDelegation?.operationKind !== command.request.kind) {
    throw commandError("idempotency_conflict")
  }
  return { ...receipt, status: "duplicate", replay: true }
}

export async function appendNativeGraphCommand(
  client: Queryable, input: TaskGraphNativeCommandInput, command: NormalizedNativeCommand,
  parent: GraphParent, loaded: LoadedGraph,
): Promise<TaskGraphNativeCommandReceipt> {
  if (input.request.kind === "spawn" && input.request.parentTaskId !== undefined
    && input.request.parentTaskId !== input.scope.parentTaskId) throw commandError("native_parent_invalid")
  const source = input.request.kind === "followup" ? await followupSource(client, input, input.request.sourceTaskId, loaded) : undefined
  const operation = command.request
  const role = source?.provenance.role ?? (operation.kind === "spawn" ? operation.role : "")
  const taskType = source?.provenance.taskType ?? (operation.kind === "spawn" ? operation.taskType : "")
  const rolePolicy = getSubagentRolePolicy(role)
  if (!isHarnessSubagentRole(role) || !rolePolicy || rolePolicy.actorRole !== "subagent" || rolePolicy.canManageChildren || rolePolicy.externalWritesEnabled) {
    throw commandError("native_role_not_allowed")
  }
  const baseContext = source ? followupContext(command.request.context, source) : command.request.context
  const enriched = await withVerifiedDependencyContext(client, input, loaded, source, baseContext)
  const context = enriched.context
  const contextMetrics = nativeContextMetrics(context)
  const sourcePolicy = source ? policyFromTask({ budgetSnapshot: source.budgetSnapshot } as Pick<SubagentTaskRecord, "budgetSnapshot">) : undefined
  const parentPolicy = policyFromTask({ budgetSnapshot: parent.budgetSnapshot } as Pick<SubagentTaskRecord, "budgetSnapshot">)
  const policy = sourcePolicy ? inheritSubagentPolicy(parentPolicy, sourcePolicy) : parentPolicy
  const expectedOutputSchema = source ? source.expectedOutputSchema ?? {} : command.outputSchemaMarker ?? {}
  const allowedActions = source
    ? intersectTaskActions(taskActions(source.allowedActions), taskActions(parent.allowedActions))
    : [...(operation.kind === "spawn" ? operation.allowedActions ?? [] : [])]
  if (input.scope.parentTaskId === input.scope.rootTaskId) {
    await assertPlanningRootHasNoUnresolvedSteering(client, parent.allowedActions, input.scope)
  }
  const child = await createSubagentTask(client, {
    userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
    parentTaskId: input.scope.parentTaskId, role, taskType, goal: operation.goal,
    constraints: operation.constraints, successCriteria: operation.successCriteria,
    allowedActions, context, expectedOutputSchema, policy,
  }, true, { preserveEmptyAllowedActions: Boolean(source), taskGraphChildDeadline: true })
  if (child.status === "queued") await enqueueGraphTask(client, input.scope.sessionId, child)
  const graphState: TaskGraphState = loaded.state ?? { revision: 0, nodes: [], appliedEvents: [] }
  const dependencyKeys = enriched.verifiedNodeKey ? [enriched.verifiedNodeKey] : []
  const key = `native-${command.operationId.slice("native-".length)}`
  let appended: ReturnType<typeof appendTaskGraphNativeNode>
  try {
    appended = appendTaskGraphNativeNode({
      state: graphState, maxDepth: Math.min(TASK_GRAPH_LIMITS.maxDepth, parentPolicy.maxDepth), key,
      goal: operation.goal, successCriteria: operation.successCriteria, dependsOn: dependencyKeys,
      metadata: {
        schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: operation.kind,
        operationId: command.operationId, requestFingerprint: command.requestFingerprint,
        callerTaskId: input.scope.parentTaskId, role, taskType,
        contextDigest: contextMetrics.contextDigest, contextBytes: contextMetrics.contextBytes,
        ...(source ? { source: source.provenance } : {}),
      },
      verifiedSource: dependencyKeys.length === 1,
    })
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "native_graph_node_invalid"
    throw commandError(code)
  }
  const taskIds = new Map(loaded.snapshot?.nodes.map(node => [node.key, node.taskId] as const) ?? [])
  taskIds.set(key, child.id)
  const state = { ...appended.state, nodes: appended.state.nodes.map(node => node.key === key ? { ...node, status: child.status } : node) }
  const snapshot = taskGraphSnapshot(state, taskIds, loaded.snapshot?.rootSuccessCriteria)
  const itemId = taskGraphItemId(input.scope.parentTaskId)
  const receipt: TaskGraphNativeCommandReceipt = {
    status: "accepted", replay: false, operationId: command.operationId,
    requestFingerprint: command.requestFingerprint, graphRevision: state.revision, nodeKey: key,
    dispatchDisposition: child.status === "queued" ? "pending" : "not_ready",
    child: {
      taskId: child.id, rootTaskId: child.rootTaskId, parentTaskId: child.parentTaskId ?? input.scope.parentTaskId,
      path: child.path, depth: child.depth, role: child.role, taskType: child.taskType,
      status: child.status as "queued" | "waiting",
    },
    ...(source ? { source: source.provenance } : {}),
  }
  const now = new Date()
  await writeTaskGraphSnapshot(client, input.scope, snapshot, graphState.revision, now)
  await appendTaskGraphReceipt(client, {
    scope: input.scope, itemId, taskId: input.scope.parentTaskId,
    type: graphState.revision === 0 ? "item.started" : "item.delta",
    idempotencyKey: command.eventIdempotencyKey, causationId: input.scope.stepId,
    payload: {
      kind: "native_command", requestFingerprint: command.requestFingerprint,
      revision: state.revision, receipt, item: graphItem(input, itemId, snapshot, state.revision, now), content: snapshot,
    },
    outbox: true,
  })
  return receipt
}

async function followupSource(client: Queryable, input: TaskGraphNativeCommandInput, taskId: string, loaded: LoadedGraph): Promise<TaskGraphNativeSource> {
  const result = await client.query(`SELECT task."id", task."rootTaskId", task."parentTaskId", task."turnId", task."role", task."taskType",
      task."status", task."attemptCount", task."result", task."context", task."expectedOutputSchema", task."allowedActions", task."budgetSnapshot"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."id" <> $4 AND session."userId" = $5 AND turn."userId" = $5 FOR UPDATE OF task`,
  [taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.userId])
  const row = result.rows[0] as Row | undefined
  if (!row || typeof row.id !== "string" || typeof row.rootTaskId !== "string" || row.rootTaskId !== input.scope.rootTaskId
    || typeof row.turnId !== "string" || row.turnId !== input.scope.turnId || typeof row.role !== "string" || typeof row.taskType !== "string"
    || !Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 0 || !TERMINAL.has(row.status as SubagentTaskStatus)) {
    throw commandError("native_source_unavailable")
  }
  taskGraphNativeResultReceipt(row.role, row.status as SubagentTaskStatus, row.result ?? null, row.expectedOutputSchema)
  const graphNode = loaded.snapshot?.nodes.find(node => node.taskId === taskId)
  await assertNotSupersededSource(client, input, taskId, !graphNode)
  const currentNode = loaded.state?.nodes.find(node => node.taskId === taskId)
  if (graphNode && (!currentNode || currentNode.status !== row.status || loaded.tasks.get(taskId)?.id !== taskId)) {
    throw commandError("native_source_graph_invalid")
  }
  return {
    ...row,
    provenance: {
      taskId, rootTaskId: input.scope.rootTaskId,
      parentTaskId: typeof row.parentTaskId === "string" ? row.parentTaskId : null,
      turnId: input.scope.turnId, role: row.role, taskType: row.taskType,
      status: row.status as TaskGraphNativeSource["provenance"]["status"], attemptCount: Number(row.attemptCount),
      resultDigest: taskGraphResultDigest(row.result ?? null), graphNodeKey: graphNode?.key ?? null,
      origin: graphNode ? "task_graph" : "native_legacy",
    },
  }
}

async function assertNotSupersededSource(client: Queryable, input: TaskGraphNativeCommandInput, taskId: string, requireHistoryCheck: boolean): Promise<void> {
  const scope: SteeringReconciliationScope = {
    userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
    rootTaskId: input.scope.rootTaskId, parentTaskId: input.scope.rootTaskId,
    turnLeaseOwner: input.scope.turnLeaseOwner, turnLeaseVersion: input.scope.turnLeaseVersion,
    parentLeaseOwner: input.scope.parentLeaseOwner, parentAttemptCount: input.scope.parentAttemptCount,
  }
  const result = await client.query<Row>(`SELECT event."id", event."itemId", event."taskId", event."type", event."actor",
      event."correlationId", event."causationId", event."sequence", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3 AND event."type" = $4
      AND (event."payload"->'supersession'->'source'->>'taskId' = $5 OR EXISTS (SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(event."payload"->'branchRepair'->'sources') = 'array' THEN event."payload"->'branchRepair'->'sources'
          WHEN jsonb_typeof(event."payload"->'failedBranch'->'sources') = 'array' THEN event."payload"->'failedBranch'->'sources' ELSE '[]'::jsonb END
      ) AS binding(value) WHERE binding.value->'source'->>'taskId' = $5))
      AND session."userId" = $6 AND turn."userId" = $6 LIMIT 2`,
  [input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, STEERING_RECONCILIATION_EVENT_TYPE, taskId, input.scope.userId])
  if (result.rows.length === 0) {
    if (requireHistoryCheck) await assertNoTaskGraphHistory(client, input, taskId)
    return
  }
  if (result.rows.length !== 1) throw commandError("native_source_unavailable")
  const event = result.rows[0]!, receipt = parseSteeringReconciliationReceipt(event.payload, scope)
  const relation = receipt?.supersession, branch = receipt?.branchRepair, failedBranch = receipt?.failedBranch
  const eventSequence = steeringReconciliationSequence(event.sequence)
  if (!steeringReconciliationId(event.id) || event.itemId !== null || event.taskId !== input.scope.rootTaskId
    || event.type !== STEERING_RECONCILIATION_EVENT_TYPE || event.actor !== "orchestrator"
    || event.correlationId !== input.scope.turnId || event.causationId !== receipt?.stepId
    || event.hasOutbox !== false || eventSequence === null
    || typeof event.idempotencyKey !== "string" || !receipt
    || receipt.schemaVersion === STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION
      && (!relation || relation.source.taskId !== taskId || event.idempotencyKey !== relation.operationKey)
    || receipt.schemaVersion === STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION
      && (!branch || !branch.sources.some(source => source.source.taskId === taskId) || event.idempotencyKey !== branch.operationKey)
    || receipt.schemaVersion === STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION
      && (!failedBranch || !failedBranch.sources.some(source => source.source.taskId === taskId) || event.idempotencyKey !== failedBranch.operationKey)
    || receipt.schemaVersion !== STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION
      && receipt.schemaVersion !== STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION
      && receipt.schemaVersion !== STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION) {
    throw commandError("native_source_unavailable")
  }
  if (branch) try { await assertTaskGraphBranchRepairHistory(client, scope, branch,
    { id: event.id, sequence: eventSequence, stepId: receipt!.stepId, idempotencyKey: event.idempotencyKey as string }) }
  catch { throw commandError("native_source_unavailable") }
  if (failedBranch) try { await assertTaskGraphFailedBranchRepairHistory(client, scope, failedBranch,
    { id: event.id, sequence: eventSequence, stepId: receipt!.stepId, idempotencyKey: event.idempotencyKey as string }) }
  catch { throw commandError("native_source_unavailable") }
  throw commandError("native_source_superseded")
}

async function assertNoTaskGraphHistory(client: Queryable, input: TaskGraphNativeCommandInput, taskId: string): Promise<void> {
  const result = await client.query<{ hasMembership: boolean }>(`SELECT (
      EXISTS (SELECT 1 FROM "agent_items" AS item JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
        JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
        WHERE item."id" = $3 AND item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $4 AND item."type" = $5
          AND item."content"->'nodes' @> jsonb_build_array(jsonb_build_object('taskId', $6::text))
          AND session."userId" = $7 AND turn."userId" = $7)
      OR EXISTS (SELECT 1 FROM "agent_events" AS history JOIN "agent_sessions" AS session ON session."id" = history."sessionId"
        JOIN "agent_turns" AS turn ON turn."id" = history."turnId" AND turn."sessionId" = history."sessionId"
        WHERE history."sessionId" = $1 AND history."turnId" = $2 AND history."itemId" = $3
          AND (history."payload"->'content'->'nodes' @> jsonb_build_array(jsonb_build_object('taskId', $6::text))
            OR history."payload"->'item'->'content'->'nodes' @> jsonb_build_array(jsonb_build_object('taskId', $6::text)))
          AND session."userId" = $7 AND turn."userId" = $7)) AS "hasMembership"`,
  [input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.rootTaskId), input.scope.rootTaskId,
    TASK_GRAPH_ITEM_TYPE, taskId, input.scope.userId])
  if (result.rows.length !== 1 || result.rows[0]?.hasMembership !== false) throw commandError("native_source_unavailable")
}

function commandError(code: string): TaskGraphCommandError { return new TaskGraphCommandError(code, code) }
