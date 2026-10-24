import { createHash } from "node:crypto"
import type { Queryable } from "./pg-store-persistence.js"
import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope, type GraphIdentityScope, type LoadedGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { scheduledGateCheckpointEvidence, scheduledGatePreparedJobIds, parseScheduledGateTaskEnvelope,
  SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_NODE_GOAL,
  SCHEDULED_GATE_NODE_CRITERIA,
  type ScheduledGateCompletionProof } from "./scheduled-gate-contract.js"
import { loadPersistedScheduledPrepareProof } from "./scheduled-gate-wait-match.js"
import { readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import { scheduledSnapshotMatches } from "./scheduled-taskgraph-continuation-receipt.js"
import { SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
  verifyScheduledPrepareTaskGraphEvidence } from "./scheduled-prepare-task-graph-verification.js"
import { validateScheduledGateTaskFinish } from "./scheduled-gate-task-finish.js"
import { scheduledGateAttemptLineageMatches } from "./scheduled-gate-attempt-lineage.js"
import type { TaskGraphScheduledGateCompletionInput, ScheduledGateTaskEnvelope } from "./scheduled-gate-contract.js"
import type { PreparedGraphTransition } from "./task-graph-pg-lifecycle.js"

type Row = Record<string, unknown>
type PreparedProof = NonNullable<Awaited<ReturnType<typeof loadPersistedScheduledPrepareProof>>>

/** Validates a Gate result before PgSubagentTaskStore persists its waiting or completed row. */
export async function validateScheduledGateTaskGraphFinish(client: Queryable, input: Readonly<{
  graph: PreparedGraphTransition
  taskId: string
  ownerId: string
  attemptCount: number
  status: "waiting_for_user" | "completed"
  result: unknown
}>): Promise<ScheduledGateTaskEnvelope | null> {
  const { graph, taskId, attemptCount, status } = input
  if (graph.duplicate || graph.taskId !== taskId || graph.event.type !== (status === "completed" ? "task.completed" : "task.waiting_for_user")
    || graph.event.nodeKey !== "gate" || graph.event.idempotencyKey !== taskGraphLifecycleKey(graph.scope.parentTaskId, "gate", attemptCount, graph.event.type)
    || graph.expectedRevision < 1 || graph.state.revision !== graph.expectedRevision + 1) return null
  const loaded = await loadTaskGraph(client, graph.scope, true)
  const node = loaded.snapshot?.nodes.find(value => value.key === "gate"), current = loaded.state && currentTaskGraph(loaded)
  const task = loaded.tasks.get(taskId), currentNode = current?.nodes.find(value => value.key === "gate")
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.state.revision !== graph.expectedRevision
    || canonicalTaskGraphJson(loaded.snapshot) !== canonicalTaskGraphJson(graph.snapshot)
    || loaded.snapshot.nodes.length !== 4 || !node || !task || !currentNode
    || node.taskId !== taskId || node.templateId !== "gate" || node.depth !== 4
    || node.verificationDisposition !== "specialized" || node.verification !== undefined
    || node.dependsOn.length !== 1 || node.dependsOn[0] !== "prepare"
    || node.goal !== SCHEDULED_GATE_NODE_GOAL || !same(node.successCriteria, SCHEDULED_GATE_NODE_CRITERIA)
    || task.id !== taskId || task.status !== "running" || task.role !== SCHEDULED_GATE_ROLE || task.taskType !== SCHEDULED_GATE_TASK_TYPE
    || !same(task.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) || !same(task.allowedActions, []) || task.contextIsEmpty !== true
    || task.attemptCount !== attemptCount || task.failureReason !== null || currentNode.status !== "running"
    || graph.state.nodes.find(value => value.key === "gate")?.status !== status) return null
  const gateLease = await client.query<Row>(`SELECT "status", "attemptCount", "maxAttempts", "role", "taskType",
      "expectedOutputSchema", "allowedActions", "context", "failureReason", "leaseOwner", "leaseExpiresAt",
      "leaseExpiresAt" > clock_timestamp() AS "leaseValid", "interruptRequestedAt" FROM "sub_agent_tasks"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4`,
  [taskId, graph.scope.sessionId, graph.scope.turnId, graph.scope.rootTaskId])
  const lease = record(gateLease.rows[0])
  if (gateLease.rows.length !== 1 || lease?.status !== "running" || Number(lease.attemptCount) !== attemptCount
    || !Number.isSafeInteger(lease.maxAttempts) || Number(lease.maxAttempts) < 1 || lease.role !== SCHEDULED_GATE_ROLE
    || lease.taskType !== SCHEDULED_GATE_TASK_TYPE || !same(lease.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA)
    || !same(lease.allowedActions, []) || !same(lease.context, {}) || lease.failureReason !== null
    || lease.leaseOwner !== input.ownerId || lease.leaseValid !== true || lease.interruptRequestedAt != null) return null
  const executionRows = await client.query<Row>(`SELECT "id", "status", "attemptCount", "state" FROM "agent_executions"
    WHERE "userId" = $1 AND "sessionId" = $2`, [graph.scope.userId, graph.scope.sessionId])
  if (executionRows.rows.length !== 1) return null
  const execution = record(executionRows.rows[0]), evidence = scheduledGateCheckpointEvidence(execution?.state)
  const turn = evidence && await readGateTurnSnapshot(client, graph.scope, evidence.owner.rootAttemptCount)
  if (!execution || execution.status !== "running" || !evidence
    || evidence.owner.executionId !== execution.id || evidence.owner.executionAttemptCount !== Number(execution.attemptCount)
    || !turn || !scheduledSnapshotMatches(turn, evidence.snapshotDigest)) return null
  const registrationOwner = { userId: graph.scope.userId, sessionId: graph.scope.sessionId, turnId: graph.scope.turnId,
    rootTaskId: graph.scope.rootTaskId, rootAttemptCount: evidence.owner.rootAttemptCount,
    executionId: evidence.owner.executionId, executionAttemptCount: evidence.owner.executionAttemptCount }
  const registration = await readScheduledGateRegistrationReceipt(client, { ...graph.scope, owner: registrationOwner, gateTaskId: taskId })
  const prepareNode = loaded.snapshot.nodes.find(value => value.key === "prepare"), prepare = prepareNode && loaded.tasks.get(prepareNode.taskId)
  if (!registration || !prepareNode || !prepare || prepare.status !== "completed"
    || registration.continuationKey !== evidence.continuationKey || registration.snapshotDigest !== evidence.snapshotDigest
    || registration.evidenceDigest !== evidence.evidenceDigest || registration.checkpointDigest !== evidence.checkpointDigest
    || registration.analyzeGraphRevision !== evidence.analyzeGraphRevision || registration.owner.rootAttemptCount !== evidence.owner.rootAttemptCount
    || !gateAppendRevisionMatches(loaded, taskId, registration.gateAppendRevision, graph.scope.rootTaskId)
    || !scheduledGateAttemptLineageMatches({ rootTaskId: graph.scope.rootTaskId, gateTaskId: taskId,
      maxAttempts: Number(lease.maxAttempts), requestAttemptCount: latestResumeRequest(loaded.state.appliedEvents),
      currentAttemptCount: attemptCount, currentStatus: "running", events: loaded.state.appliedEvents })) return null
  const proof = await loadPersistedScheduledPrepareProof(client, graph.scope, prepare.id, prepare.result,
    evidence.prepareWaitContinuationKey, registration.prepareWaitId)
  const expectedJobIds = proof && scheduledGatePreparedJobIds(proof)
  if (!proof || !expectedJobIds || registration.prepareWaitId !== proof.completion.wait.waitId
    || !await verifyPersistedScheduledPreparePrefix(client, graph.scope, loaded, proof)) return null
  if (status === "completed") return validateScheduledGateTaskFinish({ taskId, expectedTaskId: taskId,
    taskStatus: status, attemptCount, expectedAttemptCount: attemptCount, result: input.result, expectedJobIds })
  return parseScheduledGateTaskEnvelope(input.result, status, expectedJobIds)?.structuredResult.status === "question_required"
    ? parseScheduledGateTaskEnvelope(input.result, status, expectedJobIds) : null
}

/** Re-verifies the immutable three-node prefix from its stored, exact Prepare proof. */
export async function verifyPersistedScheduledPreparePrefix(client: Queryable, scope: GraphIdentityScope,
  loaded: LoadedGraph, proof: PreparedProof): Promise<boolean> {
  const snapshot = loaded.snapshot, state = loaded.state
  if (!snapshot || !state || (snapshot.nodes.length !== 3 && snapshot.nodes.length !== 4)) return false
  const nodes = snapshot.nodes.slice(0, 3), currentNodes = currentTaskGraph(loaded).nodes.filter(node => nodes.some(prefix => prefix.key === node.key))
  const expectedRoles = ["scout", "analyst", "prepare"] as const
  if (nodes.length !== 3 || currentNodes.length !== 3 || nodes.some((node, index) => {
    const certified = proof.completion.nodes[index], current = currentNodes.find(value => value.key === node.key)
    return !certified || !current || certified.role !== expectedRoles[index] || node.templateId !== expectedRoles[index]
      || index === 2 && node.key !== "prepare"
      || node.taskId !== certified.taskId || node.depth !== index + 1 || current.taskId !== node.taskId
      || current.status !== "completed" || node.verificationDisposition !== (index === 2 ? "specialized" : "typed")
      || node.dependsOn.length !== (index === 0 ? 0 : 1) || index > 0 && node.dependsOn[0] !== nodes[index - 1]?.key
  })) return false
  const prefix = { ...snapshot, nodes }, prefixCurrent = { revision: proof.completion.graphRevision, nodes: currentNodes }
  const prepare = nodes[2]!, task = loaded.tasks.get(prepare.taskId)
  if (!task || task.status !== "completed" || task.attemptCount !== proof.completion.nodes[2].attemptCount) return false
  const verified = await verifyScheduledPrepareTaskGraphEvidence(client, { scope: { ...scope,
    taskId: prepare.taskId, attemptCount: task.attemptCount ?? 0 }, snapshot: prefix, current: prefixCurrent,
    tasks: loaded.tasks, structuredResult: record(task.result)?.structuredResult,
    completionGraphRevision: proof.completion.graphRevision, referenceVerificationMode: { phase: "persisted_gate" }, checkpointStage: "gate" })
  const facts = record(task.result)?.taskGraphScheduledPrepareProofFacts
  return verified.verified && canonicalTaskGraphJson(verified.facts) === canonicalTaskGraphJson(facts)
    && canonicalTaskGraphJson(verified.facts) === canonicalTaskGraphJson({ schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
      receipt: proof.receipt, completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA,
        graphRevision: proof.completion.graphRevision, nodes: proof.completion.nodes }, result: proof.result })
}

/** Re-loads the full persisted Gate envelope and canonical lifecycle result for Execute admission. */
export async function verifyScheduledGateCompletion(client: Queryable,
  input: TaskGraphScheduledGateCompletionInput): Promise<ScheduledGateCompletionProof | null> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  await lockTaskGraphScope(client, input.scope)
  const graphScope: GraphIdentityScope = { userId: input.scope.userId, sessionId: input.scope.sessionId,
    turnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId, parentTaskId: input.scope.rootTaskId }
  const before = await loadTaskGraph(client, graphScope, false), gateNode = before.snapshot?.nodes.find(node => node.key === "gate")
  if (!gateNode) return null
  const gateLock = await client.query(`SELECT task."id", task."status", task."attemptCount", task."maxAttempts", task."role",
      task."taskType", task."expectedOutputSchema", task."allowedActions", task."context", task."result", task."failureReason",
      task."leaseOwner", task."leaseExpiresAt" FROM "sub_agent_tasks" AS task
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 FOR UPDATE`, [gateNode.taskId, graphScope.sessionId, graphScope.turnId, graphScope.rootTaskId])
  const executionRows = await client.query(`SELECT "id", "status", "attemptCount", "state" FROM "agent_executions"
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 FOR UPDATE`,
  [input.executionOwner.executionId, input.scope.userId, input.scope.sessionId])
  if (gateLock.rows.length !== 1 || executionRows.rows.length !== 1) return null
  const loaded = await loadTaskGraph(client, graphScope, true), gate = loaded.tasks.get(gateNode.taskId)
  const row = record(gateLock.rows[0]), execution = record(executionRows.rows[0]), evidence = scheduledGateCheckpointEvidence(execution?.state)
  if (!loaded.snapshot || !loaded.state || !gate || !row || !execution || !evidence
    || execution.status !== "running" || Number(execution.attemptCount) !== input.executionOwner.executionAttemptCount
    || evidence.owner.executionId !== input.executionOwner.executionId
    || evidence.owner.executionAttemptCount !== input.executionOwner.executionAttemptCount
    || !scheduledSnapshotMatches(await readTurnSnapshot(client, input), evidence.snapshotDigest)
    || row.id !== gateNode.taskId || row.status !== "completed" || gate.status !== "completed"
    || Number(row.attemptCount) < 1 || Number(row.attemptCount) !== gate.attemptCount || row.failureReason !== null
    || row.leaseOwner !== null || row.leaseExpiresAt !== null || row.role !== SCHEDULED_GATE_ROLE
    || row.taskType !== SCHEDULED_GATE_TASK_TYPE || !same(row.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA)
    || !same(row.allowedActions, []) || !same(row.context, {})) return null
  const receipt = await readScheduledGateRegistrationReceipt(client, { userId: input.scope.userId,
    sessionId: input.scope.sessionId, turnId: input.scope.turnId, owner: evidence.owner, gateTaskId: gate.id })
  const prepareNode = loaded.snapshot.nodes.find(node => node.key === "prepare"), prepareTask = prepareNode && loaded.tasks.get(prepareNode.taskId)
  if (!receipt || !prepareNode || !prepareTask || prepareTask.status !== "completed"
    || receipt.continuationKey !== evidence.continuationKey || receipt.snapshotDigest !== evidence.snapshotDigest
    || receipt.evidenceDigest !== evidence.evidenceDigest || receipt.checkpointDigest !== evidence.checkpointDigest
    || receipt.analyzeGraphRevision !== evidence.analyzeGraphRevision || receipt.owner.rootAttemptCount !== evidence.owner.rootAttemptCount) return null
  const proof = await loadPersistedScheduledPrepareProof(client, graphScope, prepareTask.id, prepareTask.result,
    evidence.prepareWaitContinuationKey, receipt.prepareWaitId)
  if (!proof || !same(input.prepareProof, proof)) return null
  const expectedJobIds = proof && scheduledGatePreparedJobIds(proof)
  const envelope = expectedJobIds && parseScheduledGateTaskEnvelope(gate.result, gate.status, expectedJobIds)
  if (!proof || !expectedJobIds || !envelope || envelope.structuredResult.status !== "completed"
    || receipt.prepareWaitId !== proof.completion.wait.waitId || !await verifyPersistedScheduledPreparePrefix(client, graphScope, loaded, proof)
    || loaded.snapshot.nodes.length !== 4 || gateNode.depth !== 4 || gateNode.templateId !== "gate"
    || gateNode.verificationDisposition !== "specialized" || gateNode.dependsOn.length !== 1 || gateNode.dependsOn[0] !== "prepare"
    || gateNode.goal !== "Review the exact server-prepared applications and return the fixed pending or skip decisions required by the scheduled Gate policy."
    || !same(gateNode.successCriteria, ["Return only the strict scheduled Gate result for the exact server-prepared job set; never mark a job approved.",
      "Ask only the fixed-choice question produced by the scheduled Gate policy when required.", "Never submit applications, contact employers, or expose private job material."])) return null
  const completed = loaded.state.appliedEvents.filter(event => event.nodeKey === "gate" && event.type === "task.completed"
    && event.idempotencyKey === taskGraphLifecycleKey(graphScope.rootTaskId, "gate", gate.attemptCount!, "task.completed"))
  if (completed.length !== 1 || completed[0]?.expectedRevision + 1 !== loaded.state.revision) return null
  const digest = scheduledGateResultDigest(gate.result)
  return digest ? { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1",
    graphRevision: loaded.state.revision, prepareProof: proof,
    gate: { taskId: gate.id, attemptCount: gate.attemptCount!, resultDigest: digest, completedEventRevision: loaded.state.revision } } : null
}

export function scheduledGateResultDigest(value: unknown): string | null {
  try { return `sha256:${createHash("sha256").update(canonicalTaskGraphJson(value), "utf8").digest("hex")}` } catch { return null }
}

function gateAppendRevisionMatches(loaded: LoadedGraph, gateTaskId: string, appendRevision: number, rootTaskId: string): boolean {
  const starts = loaded.state?.appliedEvents.filter(event => event.nodeKey === "gate" && event.type === "task.started"
    && event.idempotencyKey === taskGraphLifecycleKey(rootTaskId, "gate", 1, "task.started")) ?? []
  return starts.length === 1 && starts[0]?.expectedRevision === appendRevision
    && loaded.snapshot?.nodes.some(node => node.key === "gate" && node.taskId === gateTaskId) === true
}

function latestResumeRequest(events: readonly unknown[]): number {
  return events.reduce<number>((latest, value) => {
    const row = record(value)
    return row?.nodeKey === "gate" && row.type === "task.gate_choice_resumed"
      && Number.isSafeInteger(row.requestAttemptCount) && Number(row.requestAttemptCount) > latest
      ? Number(row.requestAttemptCount) : latest
  }, 0)
}

async function readGateTurnSnapshot(client: Queryable, scope: GraphIdentityScope, expectedRootAttemptCount: number): Promise<unknown | null> {
  const result = await client.query<Row>(`SELECT session."id" AS "sessionId", session."userId" AS "sessionUserId", session."status" AS "sessionStatus",
      turn."id" AS "turnId", turn."sessionId" AS "turnSessionId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId",
      turn."status" AS "turnStatus", turn."source", turn."executionMode", turn."input",
      root."id" AS "rootId", root."sessionId" AS "rootSessionId", root."turnId" AS "rootTurnId", root."status" AS "rootStatus",
      root."attemptCount" AS "rootAttemptCount", root."interruptRequestedAt" AS "rootInterruptRequestedAt", root."closedAt" AS "rootClosedAt"
    FROM "agent_sessions" AS session
    JOIN "agent_turns" AS turn ON turn."sessionId" = session."id" AND turn."userId" = session."userId"
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId" AND root."turnId" = turn."id"
    WHERE session."id" = $1 AND session."userId" = $2 AND session."status" NOT IN ('aborted', 'archived')
      AND turn."id" = $3 AND turn."rootTaskId" = $4 AND turn."status" IN ('in_progress', 'waiting_for_dependency')
      AND root."id" = $4 AND root."status" IN ('running', 'waiting', 'waiting_for_user')
      AND root."interruptRequestedAt" IS NULL AND root."closedAt" IS NULL`,
  [scope.sessionId, scope.userId, scope.turnId, scope.rootTaskId])
  const row = record(result.rows[0])
  if (result.rows.length !== 1 || !row || row.sessionId !== scope.sessionId || row.sessionUserId !== scope.userId
    || row.sessionStatus === "aborted" || row.sessionStatus === "archived" || row.turnId !== scope.turnId
    || row.turnSessionId !== scope.sessionId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || !["in_progress", "waiting_for_dependency"].includes(String(row.turnStatus)) || row.rootId !== scope.rootTaskId
    || row.rootSessionId !== scope.sessionId || row.rootTurnId !== scope.turnId
    || !["running", "waiting", "waiting_for_user"].includes(String(row.rootStatus))
    || Number(row.rootAttemptCount) !== expectedRootAttemptCount || !Number.isSafeInteger(row.rootAttemptCount)
    || Number(row.rootAttemptCount) < 1 || row.rootInterruptRequestedAt != null || row.rootClosedAt != null) return null
  return { source: row.source, executionMode: row.executionMode, input: row.input }
}

async function readTurnSnapshot(client: Queryable, input: TaskGraphScheduledGateCompletionInput): Promise<unknown> {
  const result = await client.query(`SELECT "source", "executionMode", "input" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [input.scope.turnId, input.scope.sessionId, input.scope.userId])
  return result.rows[0] ?? null
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
