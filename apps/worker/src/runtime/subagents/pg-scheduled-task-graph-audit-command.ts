import { createHash } from "node:crypto"
import { appendTaskGraphProposal, TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TaskGraphCommandError, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { appendTaskGraphReceipt, writePlanReceipt } from "./task-graph-pg-events.js"
import { createSubagentTask } from "./pg-store-create.js"
import { policyFromTask } from "./manager-task-scope.js"
import { inheritSubagentPolicy, type SubagentTaskRecord } from "./types.js"
import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope, type GraphIdentityScope, type LoadedGraph } from "./task-graph-pg-state.js"
import { enqueueGraphTask } from "./task-graph-pg-create.js"
import type { Queryable } from "./pg-store-persistence.js"
import { canonicalTaskGraphJson, taskGraphFingerprint, taskGraphLifecycleKey, taskGraphProposalKey, taskGraphSnapshot } from "./task-graph-snapshot.js"
import { verifyScheduledGateCompletion as verifyPersistedScheduledGateCompletion } from "./pg-scheduled-task-graph-gate-verification.js"
import { createScheduledTaskGraphContinuationContract, scheduledSnapshotMatches,
  type ScheduledTaskGraphContinuationContract } from "./scheduled-taskgraph-continuation-receipt.js"
import { readScheduledAuditInvocationProof as readAuditInvocationProof,
  readScheduledAuditRegistration, verifyRegisteredScheduledAuditGate } from "./scheduled-audit-invocation.js"
import { SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA, type ScheduledGateCompletionProof,
  type TaskGraphScheduledGateCompletionInput } from "./scheduled-gate-contract.js"
import {
  parseScheduledAuditRegistrationReceipt,
  parseScheduledAuditTaskEnvelope,
  scheduledAuditProposal,
  scheduledAuditRegistrationReceiptKey,
  SCHEDULED_AUDIT_COMPLETION_PROOF_SCHEMA,
  SCHEDULED_AUDIT_NODE_CRITERIA,
  SCHEDULED_AUDIT_NODE_GOAL,
  SCHEDULED_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT,
  SCHEDULED_AUDIT_ROLE,
  SCHEDULED_AUDIT_TASK_TYPE,
  SCHEDULED_AUDIT_TEMPLATE_ID,
  type ScheduledAuditAppendReceipt,
  type ScheduledAuditCompletionProof,
  type ScheduledAuditOwner,
  type TaskGraphScheduledAuditCompletionInput,
  type TaskGraphScheduledAuditInvocationInput,
  type TaskGraphScheduledAuditInput,
} from "./scheduled-audit-contract.js"

type Row = Record<string, unknown>
type Registration = NonNullable<ReturnType<typeof parseScheduledAuditRegistrationReceipt>>
type AuditTaskRow = Row & { id: string; status: string; attemptCount: number }

/** Appends exactly one fixed Audit child after fresh Gate proof verification in this transaction. */
export async function appendScheduledAudit(client: Queryable, input: TaskGraphScheduledAuditInput): Promise<ScheduledAuditAppendReceipt> {
  const proposal = scheduledAuditProposal(input.gateProof.graphRevision)
  const contractInput = { scope: input.scope, executionOwner: input.executionOwner, handoff: input.handoff, attestation: input.attestation, proposal }
  const contract = createScheduledTaskGraphContinuationContract(contractInput)
  if (!contract || input.scope.parentTaskId !== input.scope.rootTaskId || !validOptionalId(input.scheduledWaitId)) throw invalid("binding")
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  const parent = await lockTaskGraphScope(client, input.scope, true), scope = graphScope(input.scope)
  const turn = await readTurn(client, scope)
  if (!turn || !scheduledSnapshotMatches(turn, contract.binding.snapshotDigest)) throw invalid("snapshot")
  let loaded = await loadTaskGraph(client, scope, true)
  if (!loaded.snapshot || !loaded.state || !loaded.item) throw invalid("graph_missing")
  const existing = loaded.snapshot.nodes.find(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  if (existing) {
    const receipt = await readScheduledAuditRegistration(client, scope, existing.taskId, stableOwner(contract.binding.owner))
    if (!receipt || !sameRegistration(receipt, input, contract, input.gateProof) || loaded.snapshot.nodes.length !== 5) throw invalid("receipt_conflict")
    const gateProof = await verifyRegisteredScheduledAuditGate(client, scope, loaded, receipt, input.gateProof)
    if (!gateProof || !same(gateProof, input.gateProof)) throw invalid("gate_proof")
    const child = await lockAuditTask(client, scope, existing.taskId)
    loaded = await loadTaskGraph(client, scope, true)
    const task = loaded.tasks.get(existing.taskId), node = currentTaskGraph(loaded).nodes.find(value => value.key === SCHEDULED_AUDIT_TEMPLATE_ID)
    if (!task || !child || !node || node.taskId !== task.id || node.status !== task.status || node.failureReason !== task.failureReason
      || !validAuditNode(loaded, task.id) || !validAuditTaskRow(child, task)) throw invalid("task_policy")
    return appendReceipt(receipt, "duplicate", expectedAttempt(child))
  }
  if (loaded.snapshot.nodes.length !== 4 || await hasOrphanRegistration(client, scope, contract.receipt.continuationKey)) throw invalid("receipt_conflict")
  const gateProof = await verifyPersistedScheduledGateCompletion(client, { scope: input.scope,
    executionOwner: input.executionOwner, prepareProof: input.gateProof.prepareProof })
  if (!gateProof || !same(gateProof, input.gateProof) || gateProof.graphRevision !== loaded.state.revision
    || gateProof.gate.completedEventRevision !== loaded.state.revision) throw invalid("gate_proof")
  const current = currentTaskGraph(loaded), gate = current.nodes.find(node => node.key === "gate")
  if (!gate || gate.status !== "completed" || loaded.snapshot.nodes.length !== 4) throw invalid("gate_incomplete")
  const append = appendTaskGraphProposal(loaded.state, proposal, { registeredTemplateIds: new Set([SCHEDULED_AUDIT_TEMPLATE_ID]),
    maxNodes: TASK_GRAPH_LIMITS.maxNodes, maxDepth: TASK_GRAPH_LIMITS.maxDepth })
  if (!append.ok || append.state.revision !== loaded.state.revision + 1 || append.addedNodes.length !== 1) throw invalid("append")
  const added = append.addedNodes[0]!
  if (added.key !== SCHEDULED_AUDIT_TEMPLATE_ID || added.templateId !== SCHEDULED_AUDIT_TEMPLATE_ID || added.depth !== 5
    || added.status !== "queued" || added.dependsOn.length !== 1 || added.dependsOn[0] !== "gate") throw invalid("append")
  const policy = policyFromTask({ budgetSnapshot: parent.budgetSnapshot } as Pick<SubagentTaskRecord, "budgetSnapshot">)
  const child = await createSubagentTask(client, { userId: input.scope.userId, sessionId: input.scope.sessionId,
    turnId: input.scope.turnId, parentTaskId: input.scope.rootTaskId, role: SCHEDULED_AUDIT_ROLE, taskType: SCHEDULED_AUDIT_TASK_TYPE,
    goal: added.goal, constraints: [], successCriteria: added.successCriteria, allowedActions: [], context: {},
    expectedOutputSchema: SCHEDULED_AUDIT_OUTPUT_SCHEMA, policy: inheritSubagentPolicy(policy) }, true, { preserveEmptyAllowedActions: true })
  const nodes = append.state.nodes.map(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID
    ? { ...node, taskId: child.id, verificationDisposition: "legacy_unverified" as const } : node)
  const state = { ...append.state, nodes }, taskIds = new Map(loaded.snapshot.nodes.map(node => [node.key, node.taskId] as const))
  taskIds.set(SCHEDULED_AUDIT_TEMPLATE_ID, child.id)
  const snapshot = taskGraphSnapshot(state, taskIds, loaded.snapshot.rootSuccessCriteria)
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: state.revision,
    nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID, taskId: child.id, status: "queued" }], readyTaskIds: [child.id] }
  const proofDigest = digest(gateProof), registration = parseScheduledAuditRegistrationReceipt({
    schemaVersion: "agent-harness.v2.scheduled-taskgraph-audit-binding.v1", owner: stableOwner(contract.binding.owner),
    continuationKey: contract.receipt.continuationKey, snapshotDigest: contract.binding.snapshotDigest,
    evidenceDigest: contract.binding.evidenceDigest, checkpointDigest: contract.binding.checkpointDigest,
    analyzeGraphRevision: contract.binding.analyzeGraphRevision, prepareScheduleRevision: contract.binding.prepareScheduleRevision,
    prepareWaitId: gateProof.prepareProof.completion.wait.waitId, gateTaskId: gateProof.gate.taskId,
    gateAttemptCount: gateProof.gate.attemptCount, gateResultDigest: gateProof.gate.resultDigest,
    gateCompletedEventRevision: gateProof.gate.completedEventRevision, gateProofDigest: proofDigest,
    scheduledWaitId: input.scheduledWaitId ?? null, auditTaskId: child.id, gateGraphRevision: gateProof.graphRevision,
    auditAppendRevision: state.revision, expectedAttemptCount: 1,
  })
  if (!registration) throw invalid("registration")
  await writePlanReceipt(client, { scope: input.scope, state, snapshot, expectedRevision: loaded.state.revision, now: new Date(),
    idempotencyKey: taskGraphProposalKey(input.scope.rootTaskId, loaded.state.revision),
    fingerprint: taskGraphFingerprint({ proposal, gateProofDigest: proofDigest, scheduledWaitId: input.scheduledWaitId ?? null }), receipt })
  await enqueueGraphTask(client, input.scope.sessionId, child)
  await appendTaskGraphReceipt(client, { scope: input.scope, itemId: null, taskId: null,
    type: SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT,
    idempotencyKey: scheduledAuditRegistrationReceiptKey(registration.continuationKey, child.id), payload: registration,
    actor: "system", outbox: false })
  return { ...receipt, auditTaskId: child.id, expectedAttemptCount: 1 }
}

/** Reloads the exact completed Audit child and verifies its current report before root completion. */
export async function verifyScheduledAuditCompletion(client: Queryable,
  input: TaskGraphScheduledAuditCompletionInput): Promise<ScheduledAuditCompletionProof | null> {
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1) return null
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  await lockTaskGraphScope(client, input.scope)
  const scope = graphScope(input.scope), before = await loadTaskGraph(client, scope, false)
  const node = before.snapshot?.nodes.find(value => value.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  if (!node || node.taskId !== input.auditTaskId) return null
  const row = await lockAuditTask(client, scope, input.auditTaskId), loaded = await loadTaskGraph(client, scope, true)
  const registration = await readScheduledAuditRegistration(client, scope, input.auditTaskId,
    stableOwnerForScope(input.scope, input.executionOwner))
  const task = loaded.tasks.get(input.auditTaskId), current = loaded.state && currentTaskGraph(loaded)
  if (!registration || !sameRegistrationForCompletion(registration, input) || !loaded.state || !loaded.snapshot || !task || !row
    || !validAuditNode(loaded, input.auditTaskId) || !validAuditTaskRow(row, task) || row.status !== "completed"
    || row.attemptCount !== input.attemptCount || task.attemptCount !== input.attemptCount || task.status !== "completed"
    || task.failureReason !== null || row.failureReason !== null || row.leaseOwner !== null || row.leaseExpiresAt !== null) return null
  const gateProof = await verifyRegisteredScheduledAuditGate(client, scope, loaded, registration, input.gateProof)
  const report = parseScheduledAuditTaskEnvelope(row.result, row.status)?.structuredResult
  if (!gateProof || !same(gateProof, input.gateProof) || !report || !current) return null
  const audit = current.nodes.find(value => value.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  const completed = loaded.state.appliedEvents.filter(event => event.nodeKey === SCHEDULED_AUDIT_TEMPLATE_ID
    && event.type === "task.completed" && event.idempotencyKey === taskGraphLifecycleKey(scope.rootTaskId,
      SCHEDULED_AUDIT_TEMPLATE_ID, input.attemptCount, "task.completed"))
  const completedEventRevision = completed[0] && completed[0].expectedRevision + 1
  if (!audit || audit.taskId !== input.auditTaskId || audit.status !== "completed" || audit.failureReason !== null
    || completed.length !== 1 || !Number.isSafeInteger(completedEventRevision) || completedEventRevision! < 1
    || completedEventRevision! > loaded.state.revision) return null
  const digestValue = digest(row.result)
  if (!digestValue || !Number.isSafeInteger(loaded.state.revision)) return null
  return { schemaVersion: SCHEDULED_AUDIT_COMPLETION_PROOF_SCHEMA, owner: registration.owner,
    snapshotDigest: registration.snapshotDigest, graphRevision: loaded.state.revision, gateProof,
    audit: { taskId: input.auditTaskId, attemptCount: input.attemptCount, resultDigest: digestValue,
      completedEventRevision: completedEventRevision! }, report }
}

/** Returns freshly rebound Gate/Prepare evidence to the model-free Audit runtime while its root waits. */
export function readScheduledAuditInvocationProof(client: Queryable, input: TaskGraphScheduledAuditInvocationInput) {
  return readAuditInvocationProof(client, input)
}

/** Keeps the canonical four-node Gate verifier and admits only its privately registered Audit replay. */
export async function verifyScheduledGateCompletionWithAuditReplay(client: Queryable,
  input: TaskGraphScheduledGateCompletionInput): Promise<ScheduledGateCompletionProof | null> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  await lockTaskGraphScope(client, input.scope)
  const scope = graphScope(input.scope), loaded = await loadTaskGraph(client, scope, true), nodes = loaded.snapshot?.nodes
  if (nodes?.length === 4) return verifyPersistedScheduledGateCompletion(client, input)
  if (!loaded.item || !loaded.snapshot || !loaded.state || nodes?.length !== 5 || nodes[4]?.key !== SCHEDULED_AUDIT_TEMPLATE_ID) return null
  const audits = nodes.filter(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID), audit = audits.length === 1 ? audits[0] : undefined
  if (!audit || !validAuditNode(loaded, audit.taskId)) return null
  const task = loaded.tasks.get(audit.taskId), current = currentTaskGraph(loaded).nodes.find(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  if (!task || task.id !== audit.taskId || task.role !== SCHEDULED_AUDIT_ROLE || task.taskType !== SCHEDULED_AUDIT_TASK_TYPE
    || !same(task.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA) || !same(task.allowedActions, []) || task.contextIsEmpty !== true
    || !Number.isSafeInteger(task.attemptCount) || task.attemptCount! < 0 || !current || current.taskId !== task.id
    || current.status !== task.status || current.failureReason !== task.failureReason) return null
  const registration = await readScheduledAuditRegistration(client, scope, audit.taskId,
    stableOwnerForScope(input.scope, input.executionOwner))
  if (!registration || registration.auditTaskId !== audit.taskId) return null
  const expected: ScheduledGateCompletionProof = { schemaVersion: SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA,
    graphRevision: registration.gateGraphRevision, prepareProof: input.prepareProof,
    gate: { taskId: registration.gateTaskId, attemptCount: registration.gateAttemptCount,
      resultDigest: registration.gateResultDigest, completedEventRevision: registration.gateCompletedEventRevision } }
  return verifyRegisteredScheduledAuditGate(client, scope, loaded, registration, expected)
}

async function hasOrphanRegistration(client: Queryable, scope: GraphIdentityScope, continuationKey: string): Promise<boolean> {
  const rows = await client.query(`SELECT event."id" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND event."payload"->>'continuationKey' = $4 AND session."userId" = $5 AND turn."userId" = $5 LIMIT 2`,
  [scope.sessionId, scope.turnId, SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, continuationKey, scope.userId])
  return rows.rows.length !== 0
}

async function lockAuditTask(client: Queryable, scope: GraphIdentityScope, taskId: string): Promise<AuditTaskRow | null> {
  const result = await client.query(`SELECT "id", "status", "attemptCount", "role", "taskType", "expectedOutputSchema", "allowedActions",
      "context", "result", "failureReason", "leaseOwner", "leaseExpiresAt" FROM "sub_agent_tasks"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4 FOR UPDATE`,
  [taskId, scope.sessionId, scope.turnId, scope.rootTaskId])
  const row = result.rows.length === 1 ? record(result.rows[0]) : null
  return row && typeof row.id === "string" && typeof row.status === "string" && Number.isSafeInteger(row.attemptCount)
    ? { ...row, id: row.id, status: row.status, attemptCount: Number(row.attemptCount) } : null
}

function validAuditNode(loaded: LoadedGraph, taskId: string): boolean {
  const node = loaded.snapshot?.nodes.find(value => value.key === SCHEDULED_AUDIT_TEMPLATE_ID)
  return !!node && node.taskId === taskId && node.templateId === SCHEDULED_AUDIT_TEMPLATE_ID && node.depth === 5
    && node.verificationDisposition === "legacy_unverified" && node.goal === SCHEDULED_AUDIT_NODE_GOAL
    && same(node.successCriteria, SCHEDULED_AUDIT_NODE_CRITERIA) && node.dependsOn.length === 1 && node.dependsOn[0] === "gate"
}

function validAuditTaskRow(row: AuditTaskRow, task: NonNullable<LoadedGraph["tasks"] extends ReadonlyMap<string, infer T> ? T : never>): boolean {
  return Number.isSafeInteger(row.attemptCount) && row.attemptCount >= 0 && (row.status === "queued" || row.attemptCount >= 1)
    && row.id === task.id && row.status === task.status && row.attemptCount === task.attemptCount
    && row.role === SCHEDULED_AUDIT_ROLE && row.taskType === SCHEDULED_AUDIT_TASK_TYPE
    && same(row.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA) && same(row.allowedActions, [])
    && same(record(row.context), {}) && task.role === SCHEDULED_AUDIT_ROLE && task.taskType === SCHEDULED_AUDIT_TASK_TYPE
    && same(task.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA) && same(task.allowedActions, []) && task.contextIsEmpty === true
}

function expectedAttempt(row: AuditTaskRow): number {
  const value = row.status === "queued" || row.status === "retrying" ? row.attemptCount + 1 : row.attemptCount
  if (!Number.isSafeInteger(value) || value < 1) throw invalid("attempt")
  return value
}

function appendReceipt(receipt: Registration, status: "accepted" | "duplicate", expectedAttemptCount: number): ScheduledAuditAppendReceipt {
  return { status, revision: receipt.auditAppendRevision, nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID,
    taskId: receipt.auditTaskId, status: "queued" }], readyTaskIds: [receipt.auditTaskId], auditTaskId: receipt.auditTaskId, expectedAttemptCount }
}

function sameRegistration(receipt: Registration, input: TaskGraphScheduledAuditInput,
  contract: ScheduledTaskGraphContinuationContract, proof: ScheduledGateCompletionProof): boolean {
  return same(receipt.owner, stableOwner(contract.binding.owner)) && receipt.continuationKey === contract.receipt.continuationKey
    && receipt.snapshotDigest === contract.binding.snapshotDigest && receipt.evidenceDigest === contract.binding.evidenceDigest
    && receipt.checkpointDigest === contract.binding.checkpointDigest && receipt.analyzeGraphRevision === contract.binding.analyzeGraphRevision
    && receipt.prepareScheduleRevision === contract.binding.prepareScheduleRevision
    && receipt.prepareWaitId === proof.prepareProof.completion.wait.waitId && receipt.gateTaskId === proof.gate.taskId
    && receipt.gateAttemptCount === proof.gate.attemptCount && receipt.gateResultDigest === proof.gate.resultDigest
    && receipt.gateCompletedEventRevision === proof.gate.completedEventRevision && receipt.gateProofDigest === digest(proof)
    && receipt.scheduledWaitId === (input.scheduledWaitId ?? null)
}

function sameRegistrationForCompletion(receipt: Registration, input: TaskGraphScheduledAuditCompletionInput): boolean {
  return receipt.auditTaskId === input.auditTaskId && receipt.owner.userId === input.scope.userId
    && receipt.owner.sessionId === input.scope.sessionId && receipt.owner.turnId === input.scope.turnId
    && receipt.owner.rootTaskId === input.scope.rootTaskId && receipt.owner.executionId === input.executionOwner.executionId
    && receipt.owner.executionAttemptCount === input.executionOwner.executionAttemptCount
    && receipt.gateProofDigest === digest(input.gateProof) && receipt.gateTaskId === input.gateProof.gate.taskId
    && receipt.gateGraphRevision === input.gateProof.graphRevision
}

async function readTurn(client: Queryable, scope: GraphIdentityScope): Promise<Row | null> {
  const result = await client.query(`SELECT "source", "executionMode", "input" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [scope.turnId, scope.sessionId, scope.userId])
  return result.rows.length === 1 ? record(result.rows[0]) : null
}

function graphScope(scope: Pick<GraphIdentityScope, "userId" | "sessionId" | "turnId" | "rootTaskId">): GraphIdentityScope {
  return { ...scope, parentTaskId: scope.rootTaskId }
}
function stableOwner(owner: { userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number; executionId: string; executionAttemptCount: number }): ScheduledAuditOwner {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }
}
function stableOwnerForScope(scope: TaskGraphScheduledAuditCompletionInput["scope"], executionOwner: TaskGraphScheduledAuditCompletionInput["executionOwner"]): ScheduledAuditOwner {
  return { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: scope.parentAttemptCount, executionId: executionOwner.executionId,
    executionAttemptCount: executionOwner.executionAttemptCount }
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function digest(value: unknown): string | null {
  try { return `sha256:${createHash("sha256").update(canonicalTaskGraphJson(value), "utf8").digest("hex")}` } catch { return null }
}
function same(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function validOptionalId(value: unknown): boolean { return value === undefined || typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function invalid(reason: string): TaskGraphCommandError { return new TaskGraphCommandError(`scheduled_audit_${reason}`, "Scheduled Audit proof or transition is invalid") }
