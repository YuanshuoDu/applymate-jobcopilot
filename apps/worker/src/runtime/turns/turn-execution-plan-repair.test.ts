import { describe, expect, it, vi } from "vitest"
import type { StepContextSnapshot } from "../context/step-context-builder.js"

import { schedulePlanSchemaRepair, PLAN_SCHEMA_REPAIR_ERROR_CODE, PLAN_SCHEMA_REPAIR_INSTRUCTION, withPlanSchemaRepairSnapshot } from "./turn-execution-plan-repair.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"

const identity = { kind: "turn" as const, userId: "user", sessionId: "session", turnId: "turn", taskId: "root", rootTaskId: "root",
  ownerId: "worker", leaseVersion: 4, leaseExpiresAt: new Date(1) }

describe("Root plan schema repair receipts", () => {
  it("adds only a fixed correction to the pending Step's ordinary system snapshot", () => {
    const snapshot: StepContextSnapshot = { system: [{ id: "base", content: "base policy" }], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }
    const repaired = withPlanSchemaRepairSnapshot(snapshot, "step-2")
    expect(repaired.system).toEqual([
      { id: "base", content: "base policy" },
      { id: "plan-schema-repair:step-2", content: PLAN_SCHEMA_REPAIR_INSTRUCTION },
    ])
    expect(snapshot.system).toHaveLength(1)
  })

  it("persists the fixed rejection code with the actual model usage and no model arguments", async () => {
    const usage = { inputTokens: 19, outputTokens: 11, estimatedCostUsd: 0.025 }
    const secret = "untrusted malformed arguments"
    const output: ModelStepResult = { text: "", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model",
      finishReason: "tool_calls", usage, continuation: null, planSchemaRejection: "invalid_arguments" }
    const updateStep = vi.fn(async () => undefined), append = vi.fn(async () => "event-id"), onStepClosed = vi.fn()
    const marker = await schedulePlanSchemaRepair({ identity, store: { updateStep } as unknown as Pick<TurnExecutionOptions["store"], "updateStep">,
      writer: { append }, step: { id: "step-1", ordinal: 2 }, output: { ...output, text: secret }, now: new Date(0), alreadyUsed: false, onStepClosed })

    expect(marker).toEqual({ sourceStepId: "step-1", sourceStepOrdinal: 2, retryPending: true })
    expect(updateStep).toHaveBeenCalledWith(expect.objectContaining({ identity, stepId: "step-1", status: "completed",
      finishReason: "tool_calls", errorCode: PLAN_SCHEMA_REPAIR_ERROR_CODE, ...usage }))
    expect(append).toHaveBeenCalledWith("step.completed", "step-1", null,
      { stepId: "step-1", status: "completed", errorCode: PLAN_SCHEMA_REPAIR_ERROR_CODE, taskId: "root" }, "step-completed:step-1")
    expect(JSON.stringify({ update: updateStep.mock.calls, append: append.mock.calls })).not.toContain(secret)
    expect(onStepClosed).toHaveBeenCalledOnce()
  })

  it("refuses to create a repair receipt outside the canonical Root or for a non-rejection output", async () => {
    const updateStep = vi.fn(async () => undefined), append = vi.fn(async () => "event-id")
    const output: ModelStepResult = { text: "", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model",
      finishReason: "tool_calls", usage: null, continuation: null }
    await expect(schedulePlanSchemaRepair({ identity: { kind: "task", userId: identity.userId, sessionId: identity.sessionId, turnId: identity.turnId,
      taskId: "child", rootTaskId: identity.rootTaskId, ownerId: identity.ownerId, attemptCount: 1, leaseExpiresAt: identity.leaseExpiresAt },
      store: { updateStep } as unknown as Pick<TurnExecutionOptions["store"], "updateStep">, writer: { append },
      step: { id: "step-1", ordinal: 2 }, output, now: new Date(0), alreadyUsed: false, onStepClosed: vi.fn() }))
      .rejects.toMatchObject({ code: "invalid_output", message: "Root agent.plan arguments remained invalid after the single repair attempt" })
    expect(updateStep).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })
})
