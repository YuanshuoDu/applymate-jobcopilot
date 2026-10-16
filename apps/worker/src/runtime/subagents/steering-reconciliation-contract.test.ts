import { describe, expect, it } from "vitest"
import { executionKey } from "../turns/turn-execution-types.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import {
  parseSteeringReconciliationReceipt,
  steeringReconciliationIdempotencyKey,
  steeringReconciliationRevision,
  steeringReconciliationSequence,
  validSteeringReconciliationToolCall,
  STEERING_RECONCILIATION_EVENT_TYPE,
  STEERING_RECONCILIATION_SCHEMA_VERSION,
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
})
