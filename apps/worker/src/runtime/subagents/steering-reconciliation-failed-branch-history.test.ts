import type { PoolClient } from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"
import { assertTaskGraphFailedBranchRepairHistory } from "./steering-reconciliation-failed-branch-history.js"
import { steeringReconciliationIdempotencyKey } from "./steering-reconciliation-contract.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION, parseTaskGraphFailedBranchRepairRelation,
  taskGraphFailedBranchRepairFingerprint, type TaskGraphFailedBranchRepairRelation } from "./task-graph-pg-failed-branch-relation.js"
import { executionKey } from "../turns/turn-execution-types.js"

const { prove } = vi.hoisted(() => ({ prove: vi.fn() }))
vi.mock("./task-graph-pg-failed-branch-evidence.js", () => ({ proveTaskGraphFailedBranchEvidence: prove }))

type Row = Record<string, unknown>
const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "decision-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}
const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 2 } }] }
const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
  criteria: [{ id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: "scout-old" } }] }
const before: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, rootSuccessCriteria: ["Preserve the original objective"], nodes: [
  { key: "scout-old", taskId: "scout-old-task", templateId: "scout", goal: "Old search", successCriteria: ["Find roles"],
    dependsOn: [], depth: 1, verificationDisposition: "typed", verification: scoutVerification },
  { key: "analyst-old", taskId: "analyst-old-task", templateId: "analyst", goal: "Old analysis", successCriteria: ["Rank roles"],
    dependsOn: ["scout-old"], depth: 2, verificationDisposition: "typed", verification: analystVerification },
] }
const branch = { root: { nodeKey: "scout-old", taskId: "scout-old-task" }, sources: [
  { nodeKey: "scout-old", taskId: "scout-old-task", replacementKey: "scout-new" },
  { nodeKey: "analyst-old", taskId: "analyst-old-task", replacementKey: "analyst-new" },
] }
const proposals: TaskGraphNodeProposal[] = [
  { key: "scout-new", templateId: "scout", goal: "Search again", successCriteria: ["Find current roles"], dependsOn: [], verification: scoutVerification },
  { key: "analyst-new", templateId: "analyst", goal: "Reassess current roles", successCriteria: ["Rank current roles"], dependsOn: ["scout-new"],
    verification: { ...analystVerification, criteria: [{ id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: "scout-new" } }] } },
]
const after: TaskGraphSnapshot = { ...before, nodes: [
  { ...proposals[0]!, taskId: "scout-new-task", depth: 1, verificationDisposition: "typed" },
  { ...proposals[1]!, taskId: "analyst-new-task", depth: 2, verificationDisposition: "typed" },
] }
const callId = "branch-plan-call", observedRevision = 5, failureSequence = "10", cancellationSequence = "11", callSequence = "12", planSequence = "13"
const failedIdentity = { id: "failed-event", sequence: failureSequence,
  idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "scout-old", 1, "task.failed") }
const cancellationIdentity = { id: "cancelled-event", sequence: cancellationSequence,
  idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "analyst-old", 0, "task.cancelled") }
const operationKey = steeringReconciliationIdempotencyKey(scope, callId)!
const input = { expectedRevision: observedRevision, replaceBranch: branch, nodes: proposals }
const requestFingerprint = taskGraphFailedBranchRepairFingerprint(input)
const receipt = { status: "accepted" as const, revision: 6, nodes: [
  { key: "scout-new", taskId: "scout-new-task", status: "queued" as const },
  { key: "analyst-new", taskId: "analyst-new-task", status: "waiting" as const },
], readyTaskIds: ["scout-new-task"] }
const relationValue = {
  schemaVersion: TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION, operationKey, graphRootTaskId: scope.rootTaskId,
  observedRevision, resultingRevision: 6, branchRoot: branch.root,
  sources: branch.sources.map(source => ({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey })),
  failedSource: { source: branch.root, attemptCount: 1, resultDigest: "a".repeat(64), reportDigest: "b".repeat(64), event: failedIdentity },
  cancellations: [{ source: { nodeKey: "analyst-old", taskId: "analyst-old-task" }, event: cancellationIdentity }],
  verifiedExternalDependencies: [],
  planEvent: { id: "plan-event", sequence: planSequence, idempotencyKey: taskGraphProposalKey(scope.rootTaskId, observedRevision) },
  requestFingerprint, agentPlanCall: { callId, stepId: scope.stepId, expectedRevision: observedRevision, replaceBranch: branch },
}
const relation = parseTaskGraphFailedBranchRepairRelation(relationValue)
if (!relation) throw new Error("failed branch history fixture relation must parse")

function toolStartKey(): string {
  const identity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner,
    leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  return `${executionKey(identity)}:event:tool-started:${callId}`
}
function eventRow(id: string, sequence: string, idempotencyKey: string, taskId: string, actor: string,
  payload: Row, fields: Partial<Row> = {}): Row {
  const row = { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId), taskId,
    sequence, type: "item.delta", actor, correlationId: scope.turnId, causationId: null, idempotencyKey, payload, ...fields }
  return { ...row, outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId,
    outboxIdempotencyKey: `agent-event:${id}`, outboxPayload: { eventId: id, sessionId: row.sessionId, turnId: row.turnId,
      itemId: row.itemId, taskId: row.taskId, sequence, type: row.type, actor: row.actor, correlationId: row.correlationId,
      causationId: row.causationId, idempotencyKey, payload } }
}
function proposalRow(id: string, sequence: string, key: string, revision: number, fingerprint: string,
  graph: TaskGraphSnapshot, planReceipt: typeof receipt): Row {
  const graphId = taskGraphItemId(scope.rootTaskId)
  const payload = { kind: "proposal", fingerprint, revision, receipt: planReceipt, content: graph,
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: graphId, sessionId: scope.sessionId, turnId: scope.turnId,
      stepId: scope.stepId, taskId: scope.rootTaskId, type: "task_graph", revision, content: graph } }
  return eventRow(id, sequence, key, scope.rootTaskId, "orchestrator", payload, { causationId: scope.stepId })
}
function fixture() {
  const graphId = taskGraphItemId(scope.rootTaskId)
  const failedPayload = { kind: "lifecycle", revision: 4,
    event: { type: "task.failed", nodeKey: "scout-old", expectedRevision: 3, idempotencyKey: failedIdentity.idempotencyKey },
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: graphId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
      type: "task_graph", revision: 4, content: before } }
  const cancelledPayload = { kind: "lifecycle", revision: 5,
    event: { type: "task.cancelled", nodeKey: "analyst-old", expectedRevision: 4, idempotencyKey: cancellationIdentity.idempotencyKey },
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: graphId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
      type: "task_graph", revision: 5, content: before } }
  const planPayload = { kind: "proposal", fingerprint: requestFingerprint, revision: 6, receipt, content: after,
    item: { id: graphId, sessionId: scope.sessionId, turnId: scope.turnId, stepId: scope.stepId, taskId: scope.rootTaskId,
      type: "task_graph", revision: 6, content: after } }
  const events = [
    eventRow(failedIdentity.id, failureSequence, failedIdentity.idempotencyKey, "scout-old-task", "system", failedPayload),
    eventRow(cancellationIdentity.id, cancellationSequence, cancellationIdentity.idempotencyKey, "analyst-old-task", "system", cancelledPayload),
    eventRow("plan-event", planSequence, relation.planEvent.idempotencyKey, scope.rootTaskId, "orchestrator", planPayload,
      { itemId: graphId, causationId: scope.stepId }),
  ]
  const callRow: Row = {
    eventId: "plan-call-event", eventSequence: callSequence, type: "tool_call.started", actor: "orchestrator",
    eventTaskId: scope.rootTaskId, eventItemId: "plan-call-item", correlationId: callId, idempotencyKey: toolStartKey(),
    payload: { toolCallId: callId, toolName: "agent.plan", taskId: scope.rootTaskId },
    callItemId: "plan-call-item", stepId: scope.stepId, itemTaskId: scope.rootTaskId, itemType: "tool_call",
    itemContent: { toolCallId: callId, toolName: "agent.plan", toolVersion: "1", input },
  }
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("tool_call.started")) return { rows: [callRow], rowCount: 1 }
    if (sql.includes('event."id" = ANY($5::text[])')) {
      const ids = values?.[4] as string[]
      const selected = events.filter(event => ids.includes(String(event.id))).map(event => ({ ...event,
        sessionUserId: scope.userId, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId }))
      return { rows: selected, rowCount: selected.length }
    }
    if (sql.includes('event."sequence" < $6::bigint')) {
      const latest = events.filter(event => BigInt(String(event.sequence)) < BigInt(String(values?.[5]))).sort((left, right) =>
        BigInt(String(right.sequence)) > BigInt(String(left.sequence)) ? 1 : -1)[0]
      return { rows: latest ? [{ ...latest, sessionUserId: scope.userId, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId }] : [], rowCount: latest ? 1 : 0 }
    }
    throw new Error("unexpected history query")
  })
  const client = { query } as unknown as Pick<PoolClient, "query">
  const evidence = { failedSource: relation.failedSource, cancellations: relation.cancellations,
    verifiedExternalDependencies: relation.verifiedExternalDependencies }
  prove.mockReset().mockResolvedValue(evidence)
  return { client, query, callRow, events, relation, receiptEvent: { id: "reconciliation-event", sequence: 14n,
    stepId: scope.stepId, idempotencyKey: operationKey } }
}

describe("persisted failed-branch repair history", () => {
  it("reconstructs the accepted receipt from matching failure, automatic cancellation, original call, and public plan rows", async () => {
    const f = fixture()
    await expect(assertTaskGraphFailedBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent))
      .resolves.toEqual(receipt)
    expect(f.query).toHaveBeenCalledTimes(3)
    expect(prove).toHaveBeenCalledWith(f.client, expect.objectContaining({ snapshot: before, sourceNodes: expect.any(Array) }))
  })

  it("retires a failed branch after an unrelated graph append without requiring an immediate revision", async () => {
    const f = fixture(), unrelated = { key: "unrelated", taskId: "unrelated-task", templateId: "scout", goal: "Independent work",
      successCriteria: ["Find one role"], dependsOn: [], depth: 1, verificationDisposition: "typed" as const, verification: scoutVerification }
    const observedGraph: TaskGraphSnapshot = { ...before, nodes: [...before.nodes, unrelated] }
    const finalGraph: TaskGraphSnapshot = { ...after, nodes: [...after.nodes, unrelated] }
    const inputAtObserved = { ...input, expectedRevision: 6 }
    const fingerprint = taskGraphFailedBranchRepairFingerprint(inputAtObserved)
    const resultReceipt = { ...receipt, revision: 7 }
    const unrelatedReceipt = { status: "accepted" as const, revision: 6,
      nodes: [{ key: unrelated.key, taskId: unrelated.taskId, status: "queued" as const }], readyTaskIds: [unrelated.taskId] }
    f.events.splice(2, 0, proposalRow("unrelated-plan", "12", taskGraphProposalKey(scope.rootTaskId, 5), 6,
      "c".repeat(64), observedGraph, unrelatedReceipt))
    const planIndex = f.events.findIndex(row => row.id === "plan-event")
    f.events[planIndex] = proposalRow("plan-event", "14", taskGraphProposalKey(scope.rootTaskId, 6), 7,
      fingerprint, finalGraph, resultReceipt)
    const laterNode = { ...unrelated, key: "later-independent", taskId: "later-independent-task" }
    const laterGraph: TaskGraphSnapshot = { ...finalGraph, nodes: [...finalGraph.nodes, laterNode] }
    f.events.push(proposalRow("later-plan", "16", taskGraphProposalKey(scope.rootTaskId, 7), 8,
      "d".repeat(64), laterGraph, { status: "accepted", revision: 8,
        nodes: [{ key: laterNode.key, taskId: laterNode.taskId, status: "queued" }], readyTaskIds: [laterNode.taskId] }))
    f.callRow.eventSequence = "13"
    const callItem = f.callRow.itemContent as Row
    f.callRow.itemContent = { ...callItem, input: inputAtObserved }
    const nextRelation = parseTaskGraphFailedBranchRepairRelation({ ...relationValue, observedRevision: 6, resultingRevision: 7,
      requestFingerprint: fingerprint,
      planEvent: { id: "plan-event", sequence: "14", idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 6) },
      agentPlanCall: { ...relationValue.agentPlanCall, expectedRevision: 6 } })
    if (!nextRelation) throw new Error("delayed retirement fixture relation must parse")
    f.relation = nextRelation
    f.receiptEvent = { id: "reconciliation-event", sequence: 15n, stepId: scope.stepId, idempotencyKey: operationKey }
    prove.mockReset().mockResolvedValue({ failedSource: nextRelation.failedSource, cancellations: nextRelation.cancellations,
      verifiedExternalDependencies: nextRelation.verifiedExternalDependencies })
    await expect(assertTaskGraphFailedBranchRepairHistory(f.client, scope, nextRelation, f.receiptEvent)).resolves.toEqual(resultReceipt)
  })

  it("rejects an extant original call whose full request no longer matches its fingerprint", async () => {
    const f = fixture(), content = f.callRow.itemContent as Row
    f.callRow.itemContent = { ...content, input: { ...input, nodes: [{ ...proposals[0]!, goal: "Changed after persistence" }, proposals[1]] } }
    await expect(assertTaskGraphFailedBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent))
      .rejects.toThrow("steering_reconciliation_failed_branch_event_invalid")
  })

  it("rejects an extant cancellation whose graph revision does not continue the failed event", async () => {
    const f = fixture(), row = f.events[1]!, payload = row.payload as Row
    row.payload = { ...payload, revision: 6, event: { ...(payload.event as Row), expectedRevision: 5 } }
    await expect(assertTaskGraphFailedBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent))
      .rejects.toThrow("steering_reconciliation_failed_branch_event_invalid")
  })

  it("rejects a replacement snapshot that differs from the persisted typed proposal", async () => {
    const f = fixture(), row = f.events[2]!, payload = row.payload as Row
    const tampered: TaskGraphSnapshot = { ...after, nodes: after.nodes.map(node => node.key === "analyst-new" ? { ...node, goal: "Unrecorded goal" } : node) }
    const item = payload.item as Row
    row.payload = { ...payload, content: tampered, item: { ...item, content: tampered } }
    const outbox = row.outboxPayload as Row
    row.outboxPayload = { ...outbox, payload: row.payload }
    await expect(assertTaskGraphFailedBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent))
      .rejects.toThrow("steering_reconciliation_failed_branch_event_invalid")
  })

  it("rejects lifecycle evidence that is present but bound to another source task", async () => {
    const f = fixture(), row = f.events[0]!
    row.taskId = "different-task"
    const outbox = row.outboxPayload as Row
    row.outboxPayload = { ...outbox, taskId: "different-task" }
    const evidence = { ...relation.failedSource, source: { nodeKey: "scout-old", taskId: "different-task" } }
    prove.mockResolvedValueOnce({ failedSource: evidence, cancellations: relation.cancellations,
      verifiedExternalDependencies: relation.verifiedExternalDependencies })
    await expect(assertTaskGraphFailedBranchRepairHistory(f.client, scope, f.relation, f.receiptEvent))
      .rejects.toThrow("steering_reconciliation_failed_branch_event_invalid")
  })
})
