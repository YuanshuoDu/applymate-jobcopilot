import { appendTaskGraphProposal, TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { canonicalTaskGraphJson, taskGraphFingerprint, taskGraphLifecycleKey, taskGraphProposalKey, taskGraphSnapshot } from "./task-graph-snapshot.js"
import type { TaskGraphScheduledGateInput, TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { TaskGraphCommandError } from "./task-graph-command-port.js"
import { appendTaskGraphReceipt, writePlanReceipt } from "./task-graph-pg-events.js"
import { createSubagentTask } from "./pg-store-create.js"
import { policyFromTask } from "./manager-task-scope.js"
import { inheritSubagentPolicy, type SubagentTaskRecord } from "./types.js"
import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope, type LoadedGraph } from "./task-graph-pg-state.js"
import { enqueueGraphTask } from "./task-graph-pg-create.js"
import { type Queryable } from "./pg-store-persistence.js"
import { scheduledGatePreparedJobIds, scheduledGateProposal, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { loadPersistedScheduledPrepareProof } from "./scheduled-gate-wait-match.js"
import { SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"
import { readScheduledGateRegistrationReceipt, scheduledGateRegistrationReceiptKey,
  SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT, type ScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import { createScheduledTaskGraphContinuationContract, scheduledSnapshotMatches, scheduledTaskGraphClaimMatches,
  scheduledTaskGraphContinuationReceiptMatches, type ScheduledTaskGraphContinuationBinding } from "./scheduled-taskgraph-continuation-receipt.js"
import { verifyPersistedScheduledPreparePrefix } from "./pg-scheduled-task-graph-gate-verification.js"

type Row = Record<string, unknown>
type PreparedProof = Awaited<ReturnType<typeof loadPersistedScheduledPrepareProof>>
const GATE_TEMPLATE = Object.freeze({ role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE,
  allowedActions: Object.freeze([] as string[]), expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA })

/** Atomically appends the one server-owned Gate after the exact persisted Prepare proof. */
export async function appendScheduledGate(client: Queryable, input: TaskGraphScheduledGateInput): Promise<TaskGraphScheduleReceipt> {
  const contract = createScheduledTaskGraphContinuationContract(input)
  const proofRevision = input.prepareProof.completion.graphRevision
  if (!contract || input.scope.parentTaskId !== input.scope.rootTaskId || !Number.isSafeInteger(proofRevision)
    || canonicalTaskGraphJson(input.proposal) !== canonicalTaskGraphJson(scheduledGateProposal(proofRevision))) throw invalid("binding")
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  const parent = await lockTaskGraphScope(client, input.scope, true), owner = contract.binding.owner
  const turn = await client.query(`SELECT "source", "executionMode", "input" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [input.scope.turnId, input.scope.sessionId, input.scope.userId])
  if (turn.rows.length !== 1 || !scheduledSnapshotMatches(turn.rows[0], contract.binding.snapshotDigest)) throw invalid("snapshot")
  const loaded = await loadTaskGraph(client, input.scope, true)
  if (!loaded.snapshot || !loaded.state || !loaded.item) throw invalid("graph_missing")
  const prep = await requirePrepareProof(client, input, contract.binding.continuationKey, loaded)
  const gateNode = loaded.snapshot.nodes.find(node => node.key === "gate")
  if (gateNode) {
    const prior = await readScheduledGateRegistrationReceipt(client, { userId: input.scope.userId,
      sessionId: input.scope.sessionId, turnId: input.scope.turnId, owner: stableOwner(owner), gateTaskId: gateNode.taskId })
    if (!prior || !sameRegistration(prior, input, contract.binding, contract.receipt.continuationKey, prep.proof)
      || !(await verifyPersistedScheduledPreparePrefix(client, input.scope, loaded, prep.proof))) throw invalid("receipt_conflict")
    await verifyGateReplayPolicy(client, input.scope, loaded, gateNode.taskId, prior.gateAppendRevision)
    await requireClaim(client, input, contract.binding, contract.claimTokenDigest, true)
    return replay(loaded, gateNode.taskId)
  }
  if (await hasOrphanRegistration(client, input.scope, contract.receipt.continuationKey)) throw invalid("receipt_conflict")
  if (loaded.snapshot.nodes.length !== 3 || loaded.state.revision !== proofRevision
    || !(await verifyPersistedScheduledPreparePrefix(client, input.scope, loaded, prep.proof))) throw invalid("prepare_mismatch")
  await requireClaim(client, input, contract.binding, contract.claimTokenDigest)
  const current = currentTaskGraph(loaded)
  const append = appendTaskGraphProposal(loaded.state, input.proposal, { registeredTemplateIds: new Set(["gate"]),
    maxNodes: TASK_GRAPH_LIMITS.maxNodes, maxDepth: TASK_GRAPH_LIMITS.maxDepth })
  if (!append.ok || append.state.revision !== loaded.state.revision + 1 || append.addedNodes.length !== 1) throw invalid("append")
  const node = append.addedNodes[0]!
  if (node.key !== "gate" || node.templateId !== "gate" || node.depth !== 4 || node.status !== "queued"
    || node.dependsOn.length !== 1 || node.dependsOn[0] !== "prepare" || current.nodes.find(item => item.key === "prepare")?.status !== "completed") throw invalid("append")
  const policy = policyFromTask({ budgetSnapshot: parent.budgetSnapshot } as Pick<SubagentTaskRecord, "budgetSnapshot">)
  const child = await createSubagentTask(client, { userId: input.scope.userId, sessionId: input.scope.sessionId,
    turnId: input.scope.turnId, parentTaskId: input.scope.rootTaskId, role: GATE_TEMPLATE.role, taskType: GATE_TEMPLATE.taskType,
    goal: node.goal, constraints: [], successCriteria: node.successCriteria, allowedActions: [], context: {},
    expectedOutputSchema: GATE_TEMPLATE.expectedOutputSchema, policy: inheritSubagentPolicy(policy) }, true,
  { preserveEmptyAllowedActions: true, taskGraphChildDeadline: true })
  const nodes = append.state.nodes.map(value => value.key === "gate" ? { ...value, taskId: child.id } : value)
  const state = { ...append.state, nodes }, taskIds = new Map(loaded.snapshot.nodes.map(value => [value.key, value.taskId] as const))
  taskIds.set("gate", child.id)
  const snapshot = taskGraphSnapshot(state, taskIds, loaded.snapshot.rootSuccessCriteria)
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: state.revision,
    nodes: [{ key: "gate", taskId: child.id, status: "queued" }], readyTaskIds: [child.id] }
  await writePlanReceipt(client, { scope: input.scope, state, snapshot, expectedRevision: loaded.state.revision, now: new Date(),
    idempotencyKey: taskGraphProposalKey(input.scope.rootTaskId, proofRevision),
    fingerprint: taskGraphFingerprint({ proposal: input.proposal, prepareWaitId: prep.proof.completion.wait.waitId,
      continuationKey: contract.receipt.continuationKey }), receipt })
  await enqueueGraphTask(client, input.scope.sessionId, child)
  const binding: ScheduledGateRegistrationReceipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-binding.v1",
    owner: stableOwner(owner), continuationKey: contract.receipt.continuationKey, snapshotDigest: contract.binding.snapshotDigest,
    evidenceDigest: contract.binding.evidenceDigest, checkpointDigest: contract.binding.checkpointDigest,
    analyzeGraphRevision: contract.binding.analyzeGraphRevision, prepareScheduleRevision: contract.binding.prepareScheduleRevision,
    prepareWaitId: prep.proof.completion.wait.waitId, gateTaskId: child.id, gateAppendRevision: state.revision }
  await appendTaskGraphReceipt(client, { scope: input.scope, itemId: null, taskId: null,
    type: SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT,
    idempotencyKey: scheduledGateRegistrationReceiptKey(binding.continuationKey, child.id), payload: binding,
    actor: "system", outbox: false })
  return receipt
}

async function requireClaim(client: Queryable, input: TaskGraphScheduledGateInput, binding: ScheduledTaskGraphContinuationBinding, digest: string, allowExpiredReplay = false): Promise<void> {
  const execution = await client.query(`SELECT "id", "status", "attemptCount", "state", clock_timestamp() AS "now"
    FROM "agent_executions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 FOR UPDATE`,
  [binding.owner.executionId, input.scope.userId, input.scope.sessionId])
  const row = asRow(execution.rows[0])
  const replayClaim = allowExpiredReplay ? asRow(asRow(row?.state)?.scheduledTaskGraphClaim) : null
  const claimCheckTime = replayClaim?.claimedAt ?? row?.now
  const claimBinding = row && claimBindingAtPersistedLease(row.state, binding)
  if (execution.rows.length !== 1 || !row || row.status !== "running"
    || Number(row.attemptCount) !== binding.owner.executionAttemptCount
    || !claimBinding || !scheduledTaskGraphClaimMatches(row.state, claimBinding, digest, claimCheckTime)) throw invalid("claim_stale")
}

/** Gate append runs under the current Root lease; only the stored claim's transient lease fields may be older. */
function claimBindingAtPersistedLease(state: unknown, binding: ScheduledTaskGraphContinuationBinding): ScheduledTaskGraphContinuationBinding | null {
  const claim = asRow(asRow(state)?.scheduledTaskGraphClaim), owner = asRow(claim?.owner)
  if (!owner || typeof owner.turnLeaseOwnerId !== "string" || !Number.isSafeInteger(owner.turnLeaseVersion)) return null
  return { ...binding, owner: { ...binding.owner, turnLeaseOwnerId: owner.turnLeaseOwnerId,
    turnLeaseVersion: Number(owner.turnLeaseVersion) } }
}

async function requirePrepareProof(client: Queryable, input: TaskGraphScheduledGateInput, continuationKey: string,
  loaded: LoadedGraph): Promise<{ proof: NonNullable<PreparedProof> }> {
  const node = loaded.snapshot?.nodes.find(value => value.key === "prepare"), task = node && loaded.tasks.get(node.taskId)
  const facts = asRow(asRow(task?.result)?.taskGraphScheduledPrepareProofFacts)
  const proof = node && task && task.status === "completed" ? await loadPersistedScheduledPrepareProof(client,
    input.scope, node.taskId, task.result, continuationKey, input.prepareProof.completion.wait.waitId) : null
  const expectedFacts = proof && { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt: proof.receipt,
    completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: proof.completion.graphRevision,
      nodes: proof.completion.nodes }, result: proof.result }
  const matching = !!proof && canonicalTaskGraphJson(proof) === canonicalTaskGraphJson(input.prepareProof)
    && canonicalTaskGraphJson(facts) === canonicalTaskGraphJson(expectedFacts)
    && scheduledTaskGraphPrepared(proof)
  if (!matching || !node || !task) throw invalid("prepare_proof")
  const sameReceipt = scheduledTaskGraphContinuationReceiptMatches(proof.receipt, input.prepareProof.receipt)
  if (!sameReceipt) throw invalid("prepare_receipt")
  return { proof }
}

function scheduledTaskGraphPrepared(proof: NonNullable<PreparedProof>): boolean {
  return Array.isArray(scheduledGatePreparedJobIds(proof))
}

async function hasOrphanRegistration(client: Queryable, scope: TaskGraphScheduledGateInput["scope"], continuationKey: string): Promise<boolean> {
  const result = await client.query(`SELECT event."id" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND event."payload"->>'continuationKey' = $4 AND session."userId" = $5 AND turn."userId" = $5 LIMIT 2`,
  [scope.sessionId, scope.turnId, SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT, continuationKey, scope.userId])
  return result.rows.length !== 0
}

async function verifyGateReplayPolicy(client: Queryable, scope: TaskGraphScheduledGateInput["scope"], loaded: LoadedGraph,
  taskId: string, appendRevision: number): Promise<void> {
  const task = loaded.tasks.get(taskId), node = loaded.snapshot?.nodes.find(value => value.taskId === taskId)
  const row = (await client.query(`SELECT "context", "allowedActions", "status", "attemptCount", "leaseOwner", "leaseExpiresAt",
      "result", "maxAttempts" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
      AND "rootTaskId" = $4 AND "parentTaskId" = $4 FOR UPDATE`, [taskId, scope.sessionId, scope.turnId, scope.rootTaskId])).rows[0]
  if (!task || !node || !row || node.templateId !== "gate" || node.depth !== 4 || node.verificationDisposition !== "specialized"
    || node.dependsOn.length !== 1 || node.dependsOn[0] !== "prepare" || node.goal !== scheduledGateProposal(0).nodes[0]!.goal
    || canonicalTaskGraphJson(node.successCriteria) !== canonicalTaskGraphJson(scheduledGateProposal(0).nodes[0]!.successCriteria)
    || task.role !== SCHEDULED_GATE_ROLE || task.taskType !== SCHEDULED_GATE_TASK_TYPE
    || canonicalTaskGraphJson(task.expectedOutputSchema) !== canonicalTaskGraphJson(SCHEDULED_GATE_OUTPUT_SCHEMA)
    || !Array.isArray(row.allowedActions) || canonicalTaskGraphJson(row.allowedActions) !== "[]"
    || canonicalTaskGraphJson(asRow(row.context)) !== "{}"
    || Number(task.attemptCount) < 0 || Number(row.attemptCount) !== task.attemptCount
    || !["queued", "running", "retrying", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"].includes(String(row.status))) throw invalid("task_policy")
  const firstStarts = loaded.state?.appliedEvents.filter(event => event.nodeKey === "gate" && event.type === "task.started"
    && event.idempotencyKey === taskGraphLifecycleKey(scope.rootTaskId, "gate", 1, "task.started")) ?? []
  if (Number(task.attemptCount) === 0) {
    if (row.status !== "queued" || firstStarts.length !== 0 || loaded.state?.revision !== appendRevision) throw invalid("task_policy")
  } else if (firstStarts.length !== 1 || firstStarts[0]?.expectedRevision !== appendRevision) throw invalid("task_policy")
}

function replay(loaded: LoadedGraph, taskId: string): TaskGraphScheduleReceipt {
  const current = loaded.state && currentTaskGraph(loaded)
  const gate = current?.nodes.find(node => node.key === "gate")
  if (!loaded.state || !gate || gate.taskId !== taskId) throw invalid("replay")
  const ready = gate.status === "queued" && gate.readiness === "ready"
  return { status: "duplicate", revision: loaded.state.revision,
    nodes: [{ key: "gate", taskId, status: ready ? "queued" : "waiting" }], readyTaskIds: ready ? [taskId] : [] }
}

function sameRegistration(prior: ScheduledGateRegistrationReceipt, input: TaskGraphScheduledGateInput,
  binding: NonNullable<ReturnType<typeof createScheduledTaskGraphContinuationContract>>["binding"],
  stableContinuationKey: string, proof: NonNullable<PreparedProof>): boolean {
  return canonicalTaskGraphJson(prior.owner) === canonicalTaskGraphJson(stableOwner(binding.owner))
    && prior.continuationKey === stableContinuationKey && prior.snapshotDigest === binding.snapshotDigest
    && prior.evidenceDigest === binding.evidenceDigest && prior.checkpointDigest === binding.checkpointDigest
    && prior.analyzeGraphRevision === binding.analyzeGraphRevision && prior.prepareScheduleRevision === binding.prepareScheduleRevision
    && prior.prepareWaitId === proof.completion.wait.waitId && input.proposal.expectedRevision === proof.completion.graphRevision
}
function stableOwner(owner: { userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number;
  executionId: string; executionAttemptCount: number }) {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }
}
function asRow(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function invalid(reason: string): TaskGraphCommandError { return new TaskGraphCommandError(`scheduled_gate_${reason}`, "Scheduled Gate proof or transition is invalid") }
