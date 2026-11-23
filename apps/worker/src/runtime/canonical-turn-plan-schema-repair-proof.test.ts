import { describe, expect, it } from "vitest"
import { PLAN_SCHEMA_REPAIR_ERROR_CODE } from "./turns/turn-execution-plan-repair.js"
import { restorePlanSchemaRepair } from "./canonical-turn-plan-schema-repair-proof.js"

type Row = Record<string, unknown>
const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const sourceStep = { id: "repair-source", taskId: scope.rootTaskId, ordinal: 2, status: "completed",
  finishReason: "tool_calls", errorCode: PLAN_SCHEMA_REPAIR_ERROR_CODE, inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.002 }
const usage = { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.002 }
const provider = "requested-provider", model = "requested-model"
function event(type: string, id: string, sequence: string, payload: Row, extra: Row = {}): Row {
  return { id, type, actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, itemId: null, correlationId: "repair-source", causationId: null,
    idempotencyKey: `turn:${scope.turnId}:event:${type.replace(".", "-")}:repair-source`, sequence, payload, ...extra }
}
function sourceEvents(): Row[] {
  const started = event("model.started", "started", "1", { taskId: scope.rootTaskId, provider, model }, {
    idempotencyKey: `turn:${scope.turnId}:event:model-started:repair-source`,
  })
  const completed = event("model.completed", "completed", "2", {
    taskId: scope.rootTaskId, provider, model, toolCallCount: 0,
  }, { causationId: started.id, idempotencyKey: `turn:${scope.turnId}:event:model-completed:repair-source` })
  const usageEvent = event("model.usage", "usage", "3", {
    taskId: scope.rootTaskId, provider: "fallback-provider", model: "fallback-model", usage,
  }, { causationId: completed.id, idempotencyKey: `turn:${scope.turnId}:event:model-usage:repair-source` })
  const closed = event("step.completed", "closed", "4", {
    stepId: sourceStep.id, status: "completed", errorCode: PLAN_SCHEMA_REPAIR_ERROR_CODE, taskId: scope.rootTaskId,
  }, { causationId: usageEvent.id, idempotencyKey: `turn:${scope.turnId}:event:step-completed:repair-source` })
  return [started, completed, usageEvent, closed]
}
function input(overrides: { steps?: readonly Row[]; items?: readonly Row[]; events?: readonly Row[] } = {}) {
  return { scope, steps: overrides.steps ?? [sourceStep], items: overrides.items ?? [], events: overrides.events ?? sourceEvents() }
}
function laterStart(stepId: string, sequence: string, extra: Row = {}): Row {
  return { id: `${stepId}-started`, type: "model.started", actor: "orchestrator", userId: scope.userId,
    sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, itemId: null,
    correlationId: stepId, causationId: null, idempotencyKey: `turn:${scope.turnId}:event:model-started:${stepId}`,
    sequence, payload: { taskId: scope.rootTaskId, provider, model }, ...extra }
}

describe("plan schema repair restore proof", () => {
  it("restores the exact rejected Root Step and permits usage provider fallback", () => {
    expect(restorePlanSchemaRepair(input())).toEqual({ sourceStepId: "repair-source", sourceStepOrdinal: 2, retryPending: true })
  })

  it("accepts positive bigint event sequences from a database projection", () => {
    const events = sourceEvents().map(row => ({ ...row, sequence: BigInt(String(row.sequence)) }))
    expect(restorePlanSchemaRepair(input({ events }))?.retryPending).toBe(true)
  })

  it("compares model cost after Decimal(12,8) database rounding", () => {
    const events = sourceEvents().map(row => row.type === "model.usage"
      ? { ...row, payload: { ...row.payload as Row, usage: { ...usage, estimatedCostUsd: 0.0020000049 } } } : row)
    expect(restorePlanSchemaRepair(input({ events }))?.retryPending).toBe(true)
    const tooFar = sourceEvents().map(row => row.type === "model.usage"
      ? { ...row, payload: { ...row.payload as Row, usage: { ...usage, estimatedCostUsd: 0.0020000051 } } } : row)
    expect(() => restorePlanSchemaRepair(input({ events: tooFar }))).toThrow("plan_schema_repair_proof_invalid")
  })

  it.each([10_000, 9_999.999999995])("rejects costs outside Decimal(12,8) after rounding (%s)", cost => {
    const events = sourceEvents().map(row => row.type === "model.usage"
      ? { ...row, payload: { ...row.payload as Row, usage: { ...usage, estimatedCostUsd: cost } } } : row)
    expect(() => restorePlanSchemaRepair(input({ steps: [{ ...sourceStep, estimatedCostUsd: cost }], events })))
      .toThrow("plan_schema_repair_proof_invalid")
  })

  it.each([
    ["missing source Step", () => ({ steps: [], events: sourceEvents() })],
    ["foreign Root", () => ({ steps: [{ ...sourceStep, taskId: "other-root" }] })],
    ["noncompleted source Step", () => ({ steps: [{ ...sourceStep, status: "failed" }] })],
    ["different finish reason", () => ({ steps: [{ ...sourceStep, finishReason: "stop" }] })],
    ["different Step error", () => ({ steps: [{ ...sourceStep, errorCode: "other_error" }] })],
    ["duplicate marked source Steps", () => ({ steps: [sourceStep, { ...sourceStep, id: "another-source", ordinal: 3 }] })],
    ["duplicate marked close", () => ({ events: [...sourceEvents(), { ...sourceEvents()[3], id: "duplicate-close", sequence: "5" }] })],
    ["missing exact close error", () => ({ events: sourceEvents().map(row => {
      if (row.type !== "step.completed") return row
      const payload = { ...row.payload as Row }
      delete payload.errorCode
      return { ...row, payload }
    }) })],
    ["extra close payload field", () => ({ events: sourceEvents().map(row => row.type === "step.completed"
      ? { ...row, payload: { ...row.payload as Row, privateField: true } } : row) })],
    ["wrong close correlation", () => ({ events: sourceEvents().map(row => row.type === "step.completed"
      ? { ...row, correlationId: "another-step" } : row) })],
    ["missing model start", () => ({ events: sourceEvents().filter(row => row.type !== "model.started") })],
    ["missing model completion", () => ({ events: sourceEvents().filter(row => row.type !== "model.completed") })],
    ["missing usage", () => ({ events: sourceEvents().filter(row => row.type !== "model.usage") })],
    ["duplicate model start", () => ({ events: [...sourceEvents(), { ...sourceEvents()[0], id: "duplicate-start", sequence: "2" }] })],
    ["tool call model completion", () => ({ events: sourceEvents().map(row => row.type === "model.completed"
      ? { ...row, payload: { ...row.payload as Row, toolCallCount: 1 } } : row) })],
    ["requested model mismatch", () => ({ events: sourceEvents().map(row => row.type === "model.completed"
      ? { ...row, payload: { ...row.payload as Row, model: "other-model" } } : row) })],
    ["broken event ownership", () => ({ events: sourceEvents().map(row => row.type === "model.usage"
      ? { ...row, userId: "other-user" } : row) })],
    ["broken causal chain", () => ({ events: sourceEvents().map(row => row.type === "model.usage"
      ? { ...row, causationId: "unrelated-event" } : row) })],
    ["out of order close", () => ({ events: sourceEvents().map(row => row.type === "step.completed"
      ? { ...row, sequence: "2" } : row) })],
    ["usage provider missing", () => ({ events: sourceEvents().map(row => row.type === "model.usage"
      ? { ...row, payload: { ...row.payload as Row, provider: "" } } : row) })],
    ["step usage mismatch", () => ({ steps: [{ ...sourceStep, inputTokens: 8 }] })],
    ["model usage malformed", () => ({ events: sourceEvents().map(row => row.type === "model.usage"
      ? { ...row, payload: { ...row.payload as Row, usage: { ...usage, outputTokens: -1 } } } : row) })],
    ["source tool call item", () => ({ items: [{ id: "call", type: "tool_call", stepId: sourceStep.id }] })],
    ["source tool result item", () => ({ items: [{ id: "result", type: "tool_result", stepId: sourceStep.id }] })],
    ["failed model event", () => ({ events: [...sourceEvents(), event("model.failed", "failed", "5", {})] })],
  ])("rejects %s marked evidence", (_name, makeOverrides) => {
    expect(() => restorePlanSchemaRepair(input(makeOverrides()))).toThrow("plan_schema_repair_proof_invalid")
  })

  it("keeps an allocated Root Step pending until its exact model.started admission", () => {
    const allocated = { id: "repair-attempt", taskId: scope.rootTaskId, ordinal: 3, status: "streaming",
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    expect(restorePlanSchemaRepair(input({ steps: [sourceStep, allocated] }))).toEqual({
      sourceStepId: sourceStep.id, sourceStepOrdinal: sourceStep.ordinal, retryPending: true,
    })

    const consumed = restorePlanSchemaRepair(input({ steps: [sourceStep, allocated], events: [...sourceEvents(), laterStart(allocated.id, "5")] }))
    expect(consumed).toEqual({ sourceStepId: sourceStep.id, sourceStepOrdinal: sourceStep.ordinal, retryPending: false })
  })

  it.each([
    ["mismatched owner", { userId: "other-user" }],
    ["missing standard key", { idempotencyKey: "wrong-key" }],
  ])("rejects a malformed later admission (%s)", (_name, mutation) => {
    const allocated = { id: "repair-attempt", taskId: scope.rootTaskId, ordinal: 3, status: "streaming",
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    expect(() => restorePlanSchemaRepair(input({ steps: [sourceStep, allocated],
      events: [...sourceEvents(), laterStart(allocated.id, "5", mutation)] }))).toThrow("plan_schema_repair_proof_invalid")
  })

  it.each([
    ["no matching Step", "unknown-step", [sourceStep]],
    ["same ordinal", "same-ordinal", [sourceStep, { id: "same-ordinal", taskId: scope.rootTaskId, ordinal: 2,
      status: "streaming", finishReason: null, errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }]],
  ])("rejects post-close Root admission with %s", (_name, stepId, steps) => {
    expect(() => restorePlanSchemaRepair(input({ steps, events: [...sourceEvents(), laterStart(stepId, "5")] })))
      .toThrow("plan_schema_repair_proof_invalid")
  })
})
