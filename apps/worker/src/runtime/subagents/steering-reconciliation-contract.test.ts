import { describe, expect, it } from "vitest"
import { executionKey } from "../turns/turn-execution-types.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"
import { TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION, taskGraphBranchRepairFingerprint } from "./task-graph-pg-branch-repair-relation.js"
import { taskGraphProposalKey } from "./task-graph-snapshot.js"
import {
  parseSteeringReconciliationReceipt,
  steeringReconciliationIdempotencyKey,
  steeringReconciliationRevision,
  steeringReconciliationSequence,
  validSteeringReconciliationToolCall,
  STEERING_RECONCILIATION_EVENT_TYPE,
  STEERING_RECONCILIATION_SCHEMA_VERSION,
  STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
  STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION,
  STEERING_RECONCILIATION_BLOCKER,
  STEERING_RECONCILIATION_FEEDBACK,
  type SteeringReconciliationReceipt,
} from "./steering-reconciliation-contract.js"

const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-2", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}
function toolStartKey(callId: string, turnId = scope.turnId): string {
  const identity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId, taskId: scope.rootTaskId,
    rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  return `${executionKey(identity)}:event:tool-started:${callId}`
}
function receipt(patch: Partial<SteeringReconciliationReceipt> = {}): SteeringReconciliationReceipt {
  return {
    schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, stepId: scope.stepId, decision: "keep", observedRevision: 0,
    resultingRevision: 0, steerInputIds: ["steer-1", "steer-2"], inputCheckpoint: { throughSequence: "9" }, ...patch,
  }
}
function supersession() {
  return {
    schemaVersion: "agent-harness.v2.task-graph-supersession.v2",
    operationKey: steeringReconciliationIdempotencyKey(scope, "call-revise"),
    observedRevision: 0, cancellationRevision: 1, resultingRevision: 2,
    source: { nodeKey: "stale-scout", taskId: "source-task" }, replacement: { nodeKey: "fresh-scout", taskId: "replacement-task" },
    cancellationEvent: { id: "cancel-event", sequence: "41" }, planEvent: { id: "plan-event", sequence: "42", idempotencyKey: taskGraphSupersessionProposalKey(scope.rootTaskId, 0) },
    replacementFingerprint: "a".repeat(64),
    agentPlanCall: { callId: "call-revise", stepId: scope.stepId, expectedRevision: 0, replaceUnstarted: { nodeKey: "stale-scout" } },
  }
}
function v2Receipt(relation: unknown = supersession()) {
  return { ...receipt({ decision: "revise", observedRevision: 0, resultingRevision: 2 }),
    schemaVersion: STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION, supersession: relation }
}
function branchRepair() {
  const replaceBranch = {
    root: { nodeKey: "scout-old", taskId: "scout-old-task" },
    sources: [
      { nodeKey: "scout-old", taskId: "scout-old-task", replacementKey: "scout-new" },
      { nodeKey: "analyst-old", taskId: "analyst-old-task", replacementKey: "analyst-new" },
    ],
  }
  const call = { expectedRevision: 4, replaceBranch, nodes: [{ key: "scout-new" }, { key: "analyst-new" }] }
  const callId = "call-branch-repair"
  return {
    schemaVersion: TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
    operationKey: steeringReconciliationIdempotencyKey(scope, callId), graphRootTaskId: scope.rootTaskId,
    observedRevision: 4, resultingRevision: 7, root: replaceBranch.root,
    sources: [
      { source: { nodeKey: "scout-old", taskId: "scout-old-task" }, replacementKey: "scout-new", cancellationEvent: { id: "cancel-scout", sequence: "41" } },
      { source: { nodeKey: "analyst-old", taskId: "analyst-old-task" }, replacementKey: "analyst-new", cancellationEvent: { id: "cancel-analyst", sequence: "42" } },
    ],
    planEvent: { id: "plan-branch", sequence: "43", idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 6) },
    replacementFingerprint: taskGraphBranchRepairFingerprint(call),
    agentPlanCall: { callId, stepId: scope.stepId, expectedRevision: 4, replaceBranch },
  }
}
function v3Receipt(patch: Record<string, unknown> = {}) {
  return {
    ...receipt({ decision: "revise", observedRevision: 4, resultingRevision: 7, steerInputIds: [],
      inputCheckpoint: { throughSequence: "47" } }),
    schemaVersion: STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION, branchRepair: branchRepair(), ...patch,
  }
}

describe("steering reconciliation receipt contract", () => {
  it("defines fixed redacted recovery vocabulary in the pure contract", () => {
    expect(STEERING_RECONCILIATION_BLOCKER).toBe("steering_reconciliation_pending")
    expect(STEERING_RECONCILIATION_FEEDBACK).toBe("Accepted user steering must be reconciled against the current TaskGraph before completion. Review current input and plan, then use agent.reconcile to keep the current revision or agent.plan to revise it.")
    expect(STEERING_RECONCILIATION_FEEDBACK).not.toMatch(/inputId|PASS|control-id/i)
  })

  it("binds a strict private decision to its owned root and step", () => {
    const value = receipt()
    expect(STEERING_RECONCILIATION_EVENT_TYPE).toBe("agent.plan.reconciliation")
    expect(parseSteeringReconciliationReceipt(value, scope)).toEqual(value)
    expect(parseSteeringReconciliationReceipt({ ...value, stepId: "foreign-step" }, scope)).toBeNull()
    expect(parseSteeringReconciliationReceipt({ ...value, rationale: "private user text" }, scope)).toBeNull()
  })

  it("requires exact sorted unique input IDs and coherent keep or revise revisions", () => {
    expect(parseSteeringReconciliationReceipt(receipt({ steerInputIds: ["steer-2", "steer-1"] }))).toBeNull()
    expect(parseSteeringReconciliationReceipt(receipt({ steerInputIds: ["steer-1", "steer-1"] }))).toBeNull()
    expect(parseSteeringReconciliationReceipt(receipt({ steerInputIds: [] }))).toBeNull()
    expect(parseSteeringReconciliationReceipt(receipt({ decision: "revise", resultingRevision: 0 }))).toBeNull()
    expect(parseSteeringReconciliationReceipt(receipt({ decision: "revise", observedRevision: 0, resultingRevision: 1 }))).not.toBeNull()
    expect(parseSteeringReconciliationReceipt({ ...receipt(), supersession: supersession() })).toBeNull()
  })

  it("parses the closed v2 supersession relation while preserving the v1 R-to-R+1 contract", () => {
    const value = v2Receipt()
    expect(parseSteeringReconciliationReceipt(value, scope)).toEqual(value)
    expect(parseSteeringReconciliationReceipt(receipt({ decision: "revise", observedRevision: 0, resultingRevision: 1 }), scope)).not.toBeNull()
    expect(parseSteeringReconciliationReceipt(receipt({ decision: "revise", observedRevision: 0, resultingRevision: 2 }), scope)).toBeNull()
    expect(parseSteeringReconciliationReceipt(receipt({ resultingRevision: 1 }), scope)).toBeNull()
  })

  it("accepts a no-steer v3 receipt at the persisted decision-step cursor and keeps real steer IDs when present", () => {
    const persistedDecisionStep = { inputThroughSequence: 47n }
    const noSteer = v3Receipt({ inputCheckpoint: { throughSequence: persistedDecisionStep.inputThroughSequence.toString() } })
    expect(noSteer.steerInputIds).toEqual([])
    expect(parseSteeringReconciliationReceipt(noSteer, scope)).toEqual(noSteer)

    const steered = v3Receipt({ steerInputIds: ["steer-10", "steer-11"] })
    expect(parseSteeringReconciliationReceipt(steered, scope)).toEqual(steered)
  })

  it.each([
    ["wrong graph root", v3Receipt({ branchRepair: { ...branchRepair(), graphRootTaskId: "foreign-root" } })],
    ["wrong branch root identity", v3Receipt({ branchRepair: { ...branchRepair(), root: { nodeKey: "other", taskId: "scout-old-task" } } })],
    ["wrong plan event key", v3Receipt({ branchRepair: { ...branchRepair(), planEvent: { ...branchRepair().planEvent, idempotencyKey: "wrong-key" } } })],
    ["wrong resulting revision", v3Receipt({ resultingRevision: 8 })],
    ["wrong step binding", v3Receipt({ branchRepair: { ...branchRepair(), agentPlanCall: { ...branchRepair().agentPlanCall, stepId: "foreign-step" } } })],
    ["missing steer checkpoint", v3Receipt({ inputCheckpoint: {} })],
    ["unknown v3 field", { ...v3Receipt(), debug: true }],
  ] as const)("rejects malformed v3 %s claims", (_name, value) => {
    expect(parseSteeringReconciliationReceipt(value, scope)).toBeNull()
  })

  it.each([
    ["outer schema", { ...v2Receipt(), schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION }],
    ["unknown relation field", v2Receipt({ ...supersession(), unexpected: true })],
    ["wrong relation schema", v2Receipt({ ...supersession(), schemaVersion: "agent-harness.v1" })],
    ["wrong source", v2Receipt({ ...supersession(), source: { nodeKey: "other", taskId: "source-task" } })],
    ["wrong call source key", v2Receipt({ ...supersession(), agentPlanCall: { ...supersession().agentPlanCall, replaceUnstarted: { nodeKey: "other" } } })],
    ["wrong call revision", v2Receipt({ ...supersession(), agentPlanCall: { ...supersession().agentPlanCall, expectedRevision: 1 } })],
    ["wrong event order", v2Receipt({ ...supersession(), cancellationEvent: { id: "cancel-event", sequence: "43" } })],
    ["wrong observed revision", v2Receipt({ ...supersession(), observedRevision: 1, cancellationRevision: 2, resultingRevision: 3 })],
    ["wrong resulting revision", { ...v2Receipt(), resultingRevision: 3 }],
    ["wrong operation key", v2Receipt({ ...supersession(), operationKey: `agent.plan.reconciliation:sha256:${"0".repeat(64)}` })],
    ["wrong fingerprint", v2Receipt({ ...supersession(), replacementFingerprint: "not-a-sha256" })],
  ] as const)("rejects malformed v2 %s claims", (_name, value) => {
    expect(parseSteeringReconciliationReceipt(value, scope)).toBeNull()
  })

  it("bounds revisions and PostgreSQL cursors without lossy number conversion", () => {
    expect(steeringReconciliationRevision(0)).toBe(true)
    expect(steeringReconciliationRevision(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(steeringReconciliationRevision(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(steeringReconciliationSequence("9223372036854775807")).toBe(9_223_372_036_854_775_807n)
    expect(steeringReconciliationSequence("9223372036854775808")).toBeNull()
    expect(steeringReconciliationSequence("01")).toBeNull()
    expect(parseSteeringReconciliationReceipt(receipt({ inputCheckpoint: { throughSequence: "-1" } }))).toBeNull()
  })

  it("derives a stable operation key from the owned lifecycle identity", () => {
    const first = steeringReconciliationIdempotencyKey(scope, "tool-call-7")
    expect(first).toMatch(/^agent\.plan\.reconciliation:sha256:[a-f0-9]{64}$/)
    expect(steeringReconciliationIdempotencyKey(scope, "tool-call-7")).toBe(first)
    expect(steeringReconciliationIdempotencyKey(scope, "tool-call-8")).not.toBe(first)
    expect(steeringReconciliationIdempotencyKey(scope, "bad\ncall")).toBeNull()
  })

  it("binds a private receipt to the persisted root tool call and exact decision revision", () => {
    const callId = "call-keep"
    const event = { type: "tool_call.started", actor: "orchestrator", taskId: scope.rootTaskId, itemId: "call-item",
      correlationId: callId, idempotencyKey: toolStartKey(callId),
      payload: { toolCallId: callId, toolName: "agent.reconcile", taskId: scope.rootTaskId } }
    const item = { id: "call-item", stepId: scope.stepId, taskId: scope.rootTaskId, type: "tool_call",
      content: { toolCallId: callId, toolName: "agent.reconcile", toolVersion: "1", input: { decision: "keep", expectedRevision: 0 } } }
    expect(validSteeringReconciliationToolCall(event, item, scope, scope.stepId, "keep", 0)).toBe(true)
    expect(validSteeringReconciliationToolCall({ ...event, actor: "subagent" }, item, scope, scope.stepId, "keep", 0)).toBe(false)
    expect(validSteeringReconciliationToolCall({ ...event, idempotencyKey: steeringReconciliationIdempotencyKey(scope, callId) }, item, scope, scope.stepId, "keep", 0)).toBe(false)
    expect(validSteeringReconciliationToolCall({ ...event, idempotencyKey: toolStartKey(callId, "foreign-turn") }, item, scope, scope.stepId, "keep", 0)).toBe(false)
    expect(validSteeringReconciliationToolCall({ ...event, idempotencyKey: toolStartKey("other-call") }, item, scope, scope.stepId, "keep", 0)).toBe(false)
    expect(validSteeringReconciliationToolCall(event, item, scope, scope.stepId, "keep", 1)).toBe(false)
    expect(validSteeringReconciliationToolCall(event, item, scope, scope.stepId, "revise", 0)).toBe(false)
  })

  it("accepts bounded optional root criteria on reconciled agent.plan calls and preserves the stored input", () => {
    const callId = "call-revise"
    const event = { type: "tool_call.started", actor: "orchestrator", taskId: scope.rootTaskId, itemId: "plan-item",
      correlationId: callId, idempotencyKey: toolStartKey(callId),
      payload: { toolCallId: callId, toolName: "agent.plan", taskId: scope.rootTaskId } }
    const makeItem = (input: Record<string, unknown>) => ({ id: "plan-item", stepId: scope.stepId, taskId: scope.rootTaskId, type: "tool_call",
      content: { toolCallId: callId, toolName: "agent.plan", toolVersion: "1", input } })
    const criteria = ["  Include evidence for each role  ", "Include evidence for each role", "Keep the full search scope", "Keep the timeline"]
    const item = makeItem({ expectedRevision: 0, nodes: [{ key: "research" }], rootSuccessCriteria: criteria })

    expect(validSteeringReconciliationToolCall(event, item, scope, scope.stepId, "revise", 0)).toBe(true)
    expect(item.content.input.rootSuccessCriteria).toEqual(criteria)
    expect(validSteeringReconciliationToolCall(event, makeItem({ expectedRevision: 0, nodes: [{ key: "research" }] }), scope, scope.stepId, "revise", 0)).toBe(true)

    const invalidCriteria: unknown[] = [[], Array.from({ length: 5 }, () => "criterion"), ["  "], ["x".repeat(513)], ["💼".repeat(129)]]
    for (const rootSuccessCriteria of invalidCriteria) {
      expect(validSteeringReconciliationToolCall(event, makeItem({ expectedRevision: 0, nodes: [{ key: "research" }], rootSuccessCriteria }),
        scope, scope.stepId, "revise", 0)).toBe(false)
    }
    expect(validSteeringReconciliationToolCall(event, makeItem({ expectedRevision: 0, nodes: [{ key: "research" }], rootSuccessCriteria: ["💼".repeat(128)] }),
      scope, scope.stepId, "revise", 0)).toBe(true)
  })

  it("requires the exact source key and a single node on a supersession agent.plan call", () => {
    const callId = "call-revise"
    const event = { type: "tool_call.started", actor: "orchestrator", taskId: scope.rootTaskId, itemId: "call-item",
      correlationId: callId, idempotencyKey: toolStartKey(callId),
      payload: { toolCallId: callId, toolName: "agent.plan", taskId: scope.rootTaskId } }
    const item = { id: "call-item", stepId: scope.stepId, taskId: scope.rootTaskId, type: "tool_call",
      content: { toolCallId: callId, toolName: "agent.plan", toolVersion: "1", input: {
        expectedRevision: 0, nodes: [{ key: "fresh-scout" }], replaceUnstarted: { nodeKey: "stale-scout" },
        rootSuccessCriteria: ["Include evidence for each role"],
      } } }
    expect(validSteeringReconciliationToolCall(event, item, scope, scope.stepId, "revise", 0, "stale-scout")).toBe(true)
    expect(validSteeringReconciliationToolCall(event, item, scope, scope.stepId, "revise", 0)).toBe(false)
    expect(validSteeringReconciliationToolCall(event, item, scope, scope.stepId, "revise", 0, "other-node")).toBe(false)
    const multiNode = { ...item, content: { ...item.content, input: { ...item.content.input, nodes: [{ key: "a" }, { key: "b" }] } } }
    expect(validSteeringReconciliationToolCall(event, multiNode, scope, scope.stepId, "revise", 0, "stale-scout")).toBe(false)
    const malformedCriteria = { ...item, content: { ...item.content, input: { ...item.content.input, rootSuccessCriteria: [] } } }
    expect(validSteeringReconciliationToolCall(event, malformedCriteria, scope, scope.stepId, "revise", 0, "stale-scout")).toBe(false)
    const missingSource = { ...item, content: { ...item.content, input: { ...item.content.input, replaceUnstarted: undefined } } }
    expect(validSteeringReconciliationToolCall(event, missingSource, scope, scope.stepId, "revise", 0, "stale-scout")).toBe(false)
  })
})
