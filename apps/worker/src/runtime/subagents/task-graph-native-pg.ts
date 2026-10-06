import { materializeTaskGraphDependencyContext, isTaskGraphDependencyContextError } from "./task-graph-dependency-context.js"
import { createSubagentTask } from "./pg-store-create.js"
import { json, type Queryable } from "./pg-store-persistence.js"
import { getSubagentRolePolicy } from "./role-policy.js"
import { appendTaskGraphNativeNode, TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { loadTaskGraphDependencyResults } from "./task-graph-pg-dependency-context-loader.js"
import { enqueueGraphTask } from "./task-graph-pg-create.js"
import type { GraphParent, LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_LIMITS, type TaskGraphState } from "../planning/task-graph.js"
import { parseTaskGraphSnapshot, taskGraphItemId, taskGraphSnapshot } from "./task-graph-snapshot.js"
import { appendTaskGraphReceipt, writeTaskGraphSnapshot } from "./task-graph-pg-events.js"
import { policyFromTask } from "./manager-task-scope.js"
import { inheritSubagentPolicy, type SubagentTaskRecord, type SubagentTaskStatus } from "./types.js"
import { TaskGraphCommandError, type TaskGraphNativeCommandInput, type TaskGraphNativeCommandReceipt, type TaskGraphNativeSourceProvenance } from "./task-graph-command-port.js"
import { nativeContextMetrics, type NormalizedNativeCommand } from "./task-graph-native-request.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { parsePersistedTaskGraphNativeReceipt } from "./task-graph-native-command.js"
import { taskGraphNativeResultReceipt } from "./task-graph-native-result.js"
import { waitResult } from "../tools/coordination-executor-support.js"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

type Row = Record<string, unknown>
type Source = Row & { provenance: TaskGraphNativeSourceProvenance }
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
  const event = result.rows[0] as Row, payload = object(event.payload)
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
  if (!rolePolicy || rolePolicy.actorRole !== "subagent" || rolePolicy.canManageChildren || rolePolicy.externalWritesEnabled) {
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
    ? intersect(taskActions(source.allowedActions), taskActions(parent.allowedActions))
    : [...(operation.kind === "spawn" ? operation.allowedActions ?? [] : [])]
  const child = await createSubagentTask(client, {
    userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
    parentTaskId: input.scope.parentTaskId, role, taskType, goal: operation.goal,
    constraints: operation.constraints, successCriteria: operation.successCriteria,
    allowedActions, context, expectedOutputSchema, policy,
  }, true)
  if (child.status === "queued") await enqueueGraphTask(client, input.scope.sessionId, child)
  if (source) await persistFollowupActions(client, input, child.id, allowedActions)
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

async function followupSource(client: Queryable, input: TaskGraphNativeCommandInput, taskId: string, loaded: LoadedGraph): Promise<Source> {
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
      status: row.status as TaskGraphNativeSourceProvenance["status"], attemptCount: Number(row.attemptCount),
      resultDigest: taskGraphResultDigest(row.result ?? null), graphNodeKey: graphNode?.key ?? null,
      origin: graphNode ? "task_graph" : "native_legacy",
    },
  }
}

async function withVerifiedDependencyContext(
  client: Queryable, input: TaskGraphNativeCommandInput, loaded: LoadedGraph,
  source: Source | undefined, context: unknown,
): Promise<{ context: unknown; verifiedNodeKey?: string }> {
  const node = source?.provenance.origin === "task_graph" && source.provenance.status === "completed"
    ? loaded.snapshot?.nodes.find(candidate => candidate.key === source.provenance.graphNodeKey) : undefined
  if (!node || node.verificationDisposition !== "typed") return { context }
  const dependencies = await loadTaskGraphDependencyResults(client, input.scope, [node.key], loaded.snapshot!.nodes)
  try { return { context: materializeTaskGraphDependencyContext(context, input.scope, [node.key], dependencies), verifiedNodeKey: node.key } }
  catch (error) {
    if (isTaskGraphDependencyContextError(error)) return { context }
    throw error
  }
}

function followupContext(callerContext: unknown, source: Source): unknown {
  return {
    callerContext: callerContext ?? null,
    sourceContext: source.context ?? {},
    provenance: {
      kind: "agent.followup", sourceTaskId: source.provenance.taskId,
      sourceStatus: source.provenance.status, sourceAttemptCount: source.provenance.attemptCount,
      priorResult: waitResult(source.result), source: source.provenance,
    },
  }
}

async function persistFollowupActions(client: Queryable, input: TaskGraphNativeCommandInput, taskId: string, actions: readonly string[]): Promise<void> {
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $6::jsonb
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $5`,
  [taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.parentTaskId, json(actions, [], "native_allowed_actions")])
  if (updated.rowCount !== 1) throw new Error("native_followup_policy_persist_failed")
}

function taskActions(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || !item.trim())) throw commandError("native_policy_invalid")
  return parsed as string[]
}
function intersect(left: readonly string[], right: readonly string[]): string[] { return [...new Set(left.filter(item => right.includes(item)))] }

function graphItem(input: TaskGraphNativeCommandInput, itemId: string, content: unknown, revision: number, now: Date) {
  const timestamp = now.toISOString()
  return {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
    stepId: input.scope.stepId ?? null, taskId: input.scope.parentTaskId, type: "task_graph",
    status: "streaming", phase: null, revision, content,
    startedAt: timestamp, completedAt: null, createdAt: timestamp, updatedAt: timestamp,
  }
}

function commandError(code: string): TaskGraphCommandError { return new TaskGraphCommandError(code, code) }

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { return Object.getPrototypeOf(parsed) === Object.prototype ? parsed as Row : null } catch { return null }
}

