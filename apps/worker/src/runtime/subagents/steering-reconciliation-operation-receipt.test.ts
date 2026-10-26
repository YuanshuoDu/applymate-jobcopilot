import { describe, expect, it } from "vitest"
import { steeringReconciliationIdempotencyKey, STEERING_RECONCILIATION_EVENT_TYPE, STEERING_RECONCILIATION_OPERATIONAL_FAILURE_SCHEMA_VERSION,
  STEERING_RECONCILIATION_SCHEMA_VERSION } from "./steering-reconciliation-contract.js"
import { matchSteeringReconciliationOperationReceipt, operationalFailureReceipt } from "./steering-reconciliation-operation-receipt.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import { TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION, parseTaskGraphOperationalFailedBranchRelation,
  taskGraphOperationalFailedBranchFingerprint } from "./task-graph-pg-operational-failed-branch-relation.js"
import { taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"

const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}

function operationalFailure() {
  const callId = "call-operational"
  const replaceOperationalFailure: TaskGraphOperationalFailureReplacement = { root: { nodeKey: "analyst-old", taskId: "analyst-task" },
    sources: [{ nodeKey: "analyst-old", taskId: "analyst-task", replacementKey: "analyst-fresh" }] }
  const nodes = [{ key: "analyst-fresh", templateId: "analyst", goal: "Review evidence", successCriteria: ["Rank findings"], dependsOn: [],
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
      criteria: [{ id: "findings", check: { kind: "finding_count_gte" as const, minimum: 1 } }] } }]
  const failedEvent = { id: "failed-event", sequence: "41",
    idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "analyst-old", 2, "task.failed") }
  return parseTaskGraphOperationalFailedBranchRelation({
    schemaVersion: TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION,
    operationKey: steeringReconciliationIdempotencyKey(scope, callId), graphRootTaskId: scope.rootTaskId,
    observedRevision: 4, resultingRevision: 5,
    failedSource: { source: replaceOperationalFailure.root, attemptCount: 2, failureReason: "child_resume_evidence_unavailable",
      resultDigest: "a".repeat(64), event: failedEvent },
    observedGraphEvent: failedEvent,
    sources: [{ source: replaceOperationalFailure.root, replacementKey: "analyst-fresh" }], priorCancellations: [], cancellations: [],
    verifiedExternalDependencies: [], planEvent: { id: "operational-plan", sequence: "43", idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 4) },
    requestFingerprint: taskGraphOperationalFailedBranchFingerprint({ rootTaskId: scope.rootTaskId, expectedRevision: 4,
      replaceOperationalFailure, nodes }),
    agentPlanCall: { callId, stepId: scope.stepId, expectedRevision: 4, replaceOperationalFailure },
  })
}

describe("steering reconciliation operation receipt matching", () => {
  it("accepts the exact persisted receipt for a keep operation", () => {
    const operation = { scope, decision: "keep" as const, expectedRevision: 2, callId: "call-1" }
    const key = steeringReconciliationIdempotencyKey(scope, operation.callId)!
    const receipt = {
      schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, stepId: scope.stepId, decision: "keep", observedRevision: 2, resultingRevision: 2,
      steerInputIds: ["steer-1"], inputCheckpoint: { throughSequence: "7" },
    }
    const row = {
      payload: receipt, turnId: scope.turnId, type: STEERING_RECONCILIATION_EVENT_TYPE, itemId: null, taskId: scope.rootTaskId,
      actor: "orchestrator", correlationId: scope.turnId, causationId: scope.stepId, idempotencyKey: key, hasOutbox: false,
    }
    expect(matchSteeringReconciliationOperationReceipt(row, operation, key)).toEqual(receipt)
  })

  it("rejects a receipt whose persisted event identity differs", () => {
    const operation = { scope, decision: "keep" as const, expectedRevision: 2, callId: "call-1" }
    const key = steeringReconciliationIdempotencyKey(scope, operation.callId)!
    const row = {
      payload: {
        schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
        rootTaskId: scope.rootTaskId, stepId: scope.stepId, decision: "keep", observedRevision: 2, resultingRevision: 2,
        steerInputIds: ["steer-1"], inputCheckpoint: { throughSequence: "7" },
      },
      turnId: scope.turnId, type: STEERING_RECONCILIATION_EVENT_TYPE, itemId: null, taskId: scope.rootTaskId,
      actor: "orchestrator", correlationId: scope.turnId, causationId: scope.stepId, idempotencyKey: key, hasOutbox: true,
    }
    expect(() => matchSteeringReconciliationOperationReceipt(row, operation, key)).toThrow("steering_reconciliation_idempotency_conflict")
  })

  it("binds an operational-failure replay to the v5 relation and exact replacement request", () => {
    const relation = operationalFailure()
    if (!relation) throw new Error("valid operational failure fixture required")
    const operation = { scope, decision: "revise" as const, expectedRevision: 4, callId: "call-operational",
      replaceOperationalFailure: relation.agentPlanCall.replaceOperationalFailure }
    const key = steeringReconciliationIdempotencyKey(scope, operation.callId)!
    const base = {
      schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, stepId: scope.stepId, decision: "revise" as const, observedRevision: 4, resultingRevision: 4,
      steerInputIds: [], inputCheckpoint: { throughSequence: "47" },
    }
    const receipt = operationalFailureReceipt(base, relation)
    expect(receipt.schemaVersion).toBe(STEERING_RECONCILIATION_OPERATIONAL_FAILURE_SCHEMA_VERSION)
    const row = {
      payload: receipt, turnId: scope.turnId, type: STEERING_RECONCILIATION_EVENT_TYPE, itemId: null, taskId: scope.rootTaskId,
      actor: "orchestrator", correlationId: scope.turnId, causationId: scope.stepId, idempotencyKey: key, hasOutbox: false,
    }
    expect(matchSteeringReconciliationOperationReceipt(row, operation, key, relation.requestFingerprint)).toEqual(receipt)
    expect(() => matchSteeringReconciliationOperationReceipt(row, { ...operation, replaceOperationalFailure: {
      ...operation.replaceOperationalFailure, sources: [],
    } }, key, relation.requestFingerprint)).toThrow("steering_reconciliation_idempotency_conflict")
  })
})
