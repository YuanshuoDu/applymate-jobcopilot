import { describe, expect, it, vi } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { executionKey } from "../turns/turn-execution-types.js"
import { parseTaskGraphOperationalFailureReplacement, type TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { assertTaskGraphOperationalFailedBranchHistory } from "./steering-reconciliation-operational-failed-branch-history.js"
import { TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION, taskGraphOperationalFailedBranchFingerprint,
  parseTaskGraphOperationalFailedBranchRelation, type TaskGraphOperationalFailedBranchRelation } from "./task-graph-pg-operational-failed-branch-relation.js"
import { steeringReconciliationIdempotencyKey, validSteeringReconciliationToolCall, type SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import { canonicalTaskGraphJson, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import type pg from "pg"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
const scope: SteeringReconciliationScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "root-owner", parentAttemptCount: 2, stepId: "root-step" }
const mode: TaskGraphOperationalFailureReplacement = { root: { nodeKey: "analyst", taskId: "analyst-1" }, sources: [
  { nodeKey: "analyst", taskId: "analyst-1", replacementKey: "analyst-fresh" },
] }
const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
  criteria: [{ id: "findings", check: { kind: "finding_count_gte" as const, minimum: 1 } }] }
const oldNode = { key: "analyst", templateId: "analyst", goal: "Review evidence", successCriteria: ["Rank findings"], dependsOn: [],
  depth: 1, taskId: "analyst-1", verificationDisposition: "typed" as const, verification }
const proposalNodes = [{ key: "analyst-fresh", templateId: "analyst", goal: "Review current evidence", successCriteria: ["Rank findings"],
  dependsOn: [], verification }]
const before = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [oldNode] }
const after = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ ...oldNode, ...proposalNodes[0], depth: 1, taskId: "analyst-2" }] }
const failureReason = "child_resume_unavailable" as const
const failedResult = { workerResult: null, taskGraphVerificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
  status: "unverified", reasonCode: "result_invalid", criteria: [{ criterionId: "findings", status: "unverified", reasonCode: "result_invalid" }],
  evidenceDigest: null, resultDigest: null } }
const failedDigest = taskGraphResultDigest(failedResult)
const callId = "plan-call"
const callInput = { expectedRevision: 8, nodes: proposalNodes, replaceOperationalFailure: mode }
const fingerprint = taskGraphOperationalFailedBranchFingerprint({ rootTaskId: scope.rootTaskId, expectedRevision: 8,
  replaceOperationalFailure: mode, nodes: proposalNodes })
const operationKey = steeringReconciliationIdempotencyKey({ ...scope, stepId: scope.stepId! }, callId)!
const failureKey = taskGraphLifecycleKey(scope.rootTaskId, "analyst", 2, "task.failed")
const failureEventId = "failure-event"
const planEventId = "plan-event"
const eventTime = "2026-01-01T00:00:00.000Z"
const planKey = taskGraphProposalKey(scope.rootTaskId, 8)
const planReceipt = { status: "accepted", revision: 9, nodes: [{ key: "analyst-fresh", taskId: "analyst-2", status: "queued" }], readyTaskIds: ["analyst-2"] }

function eventRow(id: string, sequence: string, itemId: string, taskId: string, type: string, actor: string, correlationId: string,
  causationId: string | null, idempotencyKey: string, payload: unknown): Row {
  const row = { id, sequence, sessionId: scope.sessionId, turnId: scope.turnId, itemId, taskId, type, actor, correlationId, causationId, idempotencyKey, payload }
  return { ...row, sessionUserId: scope.userId, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId,
    outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId, outboxIdempotencyKey: `agent-event:${id}`,
    outboxPayload: { eventId: id, sessionId: row.sessionId, turnId: row.turnId, itemId, taskId, sequence, type, actor,
      correlationId, causationId, idempotencyKey, payload } }
}

function fixture(inputOverrides: Partial<typeof callInput> = {}, callSequence = "21", taskOverrides: Row = {}) {
  const failedPayload = { kind: "lifecycle", revision: 8,
    event: { type: "task.failed", nodeKey: "analyst", expectedRevision: 7, idempotencyKey: failureKey, failureReason },
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId, turnId: scope.turnId,
      stepId: "source-step", taskId: scope.rootTaskId, type: "task_graph", status: "streaming", phase: null, revision: 8, content: before,
      startedAt: eventTime, completedAt: null, createdAt: eventTime, updatedAt: eventTime } }
  const planItem = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
    turnId: scope.turnId, stepId: scope.stepId, taskId: scope.rootTaskId, type: "task_graph", revision: 9, content: after }
  const planPayload = { kind: "proposal", fingerprint, receipt: planReceipt, revision: 9, item: planItem, content: after }
  const rows = [eventRow(failureEventId, "20", taskGraphItemId(scope.rootTaskId), "analyst-1", "item.delta", "system", scope.turnId, null, failureKey, failedPayload),
    eventRow(planEventId, "22", taskGraphItemId(scope.rootTaskId), scope.rootTaskId, "item.delta", "orchestrator", scope.turnId, scope.stepId!, planKey, planPayload)]
  const callContent = { toolCallId: callId, toolName: "agent.plan", toolVersion: "1",
    input: { ...callInput, ...inputOverrides } }
  const callRow = { sequence: callSequence, type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId,
    eventItemId: "call-item", correlationId: callId, idempotencyKey: `${executionKey({ kind: "turn", userId: scope.userId,
      sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId,
      ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) })}:event:tool-started:${callId}`,
    payload: { toolCallId: callId, taskId: scope.rootTaskId, toolName: "agent.plan" }, id: "call-item", stepId: scope.stepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", content: callContent }
  const taskRow = { id: "analyst-1", status: "failed", role: "analyst", taskType: "job_analysis", attemptCount: 2, leaseOwner: null, leaseExpiresAt: null,
    nextAttemptAt: null, startedAt: new Date("2026-01-01T00:00:00Z"), completedAt: new Date("2026-01-01T00:01:00Z"),
    closedAt: null, interruptRequestedAt: null, failureReason, result: failedResult, outputArtifactIds: [],
    sessionUserId: scope.userId, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId, ...taskOverrides }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("tool_call.started")) return { rows: [callRow] }
    if (sql.includes('FROM "sub_agent_tasks" task') && sql.includes('task."taskType"')) return { rows: [taskRow] }
    if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [] }
    if (sql.includes(`event."payload"->>'revision'`)) return { rows: [{ ...rows[0], currentItemId: taskGraphItemId(scope.rootTaskId),
      currentSessionId: scope.sessionId, currentTurnId: scope.turnId, currentTaskId: scope.rootTaskId,
      currentType: "task_graph", currentRevision: 8, currentContent: before }] }
    if (sql.includes('JOIN "agent_sessions"')) return { rows }
    throw new Error("unexpected operational history query")
  })
  const relationRaw = { schemaVersion: TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION, operationKey,
    graphRootTaskId: scope.rootTaskId, observedRevision: 8, resultingRevision: 9,
    failedSource: { source: mode.root, attemptCount: 2, failureReason, resultDigest: failedDigest,
      event: { id: failureEventId, sequence: "20", idempotencyKey: failureKey } },
    observedGraphEvent: { id: failureEventId, sequence: "20", idempotencyKey: failureKey },
    sources: [{ source: mode.root, replacementKey: "analyst-fresh" }], priorCancellations: [], cancellations: [], verifiedExternalDependencies: [],
    planEvent: { id: planEventId, sequence: "22", idempotencyKey: planKey }, requestFingerprint: fingerprint,
    agentPlanCall: { callId, stepId: scope.stepId, expectedRevision: 8, replaceOperationalFailure: mode } }
  const parsedMode = parseTaskGraphOperationalFailureReplacement(mode)
  if (!parsedMode.ok) throw new Error("test operational mode invalid")
  const relation = relationRaw as TaskGraphOperationalFailedBranchRelation
  const receiptEvent = { id: "receipt-event", sequence: 23n, stepId: scope.stepId!, idempotencyKey: operationKey }
  return { client: { query } as unknown as Client, query, relation, receiptEvent, callRow }
}

describe("operational failed-branch history", () => {
  it("revalidates the exact failed source, persisted plan call, and accepted proposal", async () => {
    const test = fixture()
    const parsed = parseTaskGraphOperationalFailedBranchRelation(test.relation)
    if (!parsed) throw new Error("test relation did not parse")
    expect(test.callRow.stepId).toBe(test.relation.agentPlanCall.stepId)
    expect(test.callRow.itemType).toBe("tool_call")
    expect(test.callRow.content.input.expectedRevision).toBe(test.relation.observedRevision)
    expect(canonicalTaskGraphJson(test.callRow.content.input.replaceOperationalFailure))
      .toBe(canonicalTaskGraphJson(test.relation.agentPlanCall.replaceOperationalFailure))
    expect(BigInt(test.callRow.sequence)).toBeGreaterThan(BigInt(test.relation.failedSource.event.sequence))
    expect(validSteeringReconciliationToolCall({ type: test.callRow.type, actor: test.callRow.actor,
      taskId: test.callRow.eventTaskId, itemId: test.callRow.eventItemId, correlationId: test.callRow.correlationId,
      idempotencyKey: test.callRow.idempotencyKey, payload: test.callRow.payload },
    { id: test.callRow.eventItemId, stepId: test.callRow.stepId, taskId: test.callRow.itemTaskId, type: test.callRow.itemType,
      content: test.callRow.content }, scope, scope.stepId!, "revise", 8, undefined, undefined,
      parsed.agentPlanCall.replaceOperationalFailure)).toBe(true)
    await expect(assertTaskGraphOperationalFailedBranchHistory(test.client, scope, test.relation, test.receiptEvent))
      .resolves.toEqual(planReceipt)
    expect(test.query).toHaveBeenCalledTimes(5)
  })

  it("rejects a persisted agent.plan call whose public proposal no longer matches its fingerprint", async () => {
    const changed = fixture({ nodes: [{ ...proposalNodes[0]!, goal: "Changed after the call" }] })
    await expect(assertTaskGraphOperationalFailedBranchHistory(changed.client, scope, changed.relation, changed.receiptEvent))
      .rejects.toThrow("steering_reconciliation_operational_failure_event_invalid")
  })

  it("requires the current failure to precede the recovery call and the plan to follow it", async () => {
    const beforeFailure = fixture({}, "19")
    await expect(assertTaskGraphOperationalFailedBranchHistory(beforeFailure.client, scope, beforeFailure.relation, beforeFailure.receiptEvent))
      .rejects.toThrow("steering_reconciliation_operational_failure_event_invalid")
  })

  it("rejects a failed row whose task type no longer matches the typed source", async () => {
    const mismatch = fixture({}, "21", { taskType: "job_discovery" })
    await expect(assertTaskGraphOperationalFailedBranchHistory(mismatch.client, scope, mismatch.relation, mismatch.receiptEvent))
      .rejects.toThrow("steering_reconciliation_operational_failure_event_invalid")
  })
})
