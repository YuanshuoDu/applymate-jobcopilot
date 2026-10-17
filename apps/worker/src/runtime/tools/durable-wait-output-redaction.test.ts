import { describe, expect, it } from "vitest"
import { redactSensitiveValue } from "@jobcopilot/shared"

import { NATIVE_VERIFICATION_REPORT_SCHEMA } from "../subagents/native-verification-contract.js"
import { redactDurableWaitOutput } from "./durable-wait-output-redaction.js"

const waitId = "wait-12345678-1234-4234-9234-123456789012"
const taskId = "subagent-12345678-1234-4234-9234-123456789012"
const otherTaskId = "subagent-00000000-0000-4000-8000-000000000001"

function validOutput() {
  return {
    waitId,
    status: "ready",
    taskIds: [taskId],
    deadlineAt: "2026-10-04T12:00:00.000Z",
    matchedTaskIds: [taskId],
    tasks: [{
      taskId,
      status: "completed",
      role: "scout",
      result: {
        description: "Candidate candidate@example.com; call 202-555-0199",
        privateData: { content: "private nested resume text" },
        deepString: { a: { b: { c: { d: "candidate@example.com" } } } },
        taskId,
      },
      failureReason: null,
    }],
    aggregate: {
      status: "completed",
      successfulRoles: ["scout"],
      failedRoles: [],
      jobIds: [taskId],
      failures: [],
    },
  }
}

describe("durable wait output redaction", () => {
  it("restores only canonical IDs after normal redaction, including numeric UUID fixtures", () => {
    const output = validOutput()
    expect(redactSensitiveValue(waitId)).not.toBe(waitId)
    expect(redactSensitiveValue(taskId)).not.toBe(taskId)

    const safe = redactDurableWaitOutput(output) as Record<string, unknown>
    expect(safe).toMatchObject({
      waitId,
      status: "ready",
      taskIds: [taskId],
      matchedTaskIds: [taskId],
      tasks: [{
        taskId,
        status: "completed",
        result: {
          description: "Candidate [REDACTED_EMAIL]; call [REDACTED_PHONE]",
          privateData: { content: "[REDACTED]" },
        },
      }],
    })
    const safeTasks = safe.tasks as Array<Record<string, unknown>>
    const safeResult = safeTasks[0]?.result as Record<string, unknown>
    expect(safeResult.taskId).not.toBe(taskId)
    expect(safeResult.deepString).toEqual({ a: { b: { c: { d: "[REDACTED_EMAIL]" } } } })
    const safeAggregate = safe.aggregate as Record<string, unknown>
    expect(safeAggregate.jobIds).not.toEqual([taskId])
    expect(output.waitId).toBe(waitId)
  })

  it("preserves complete execution state, accepts legacy task rows, and rejects partial or invalid state", () => {
    const legacy = redactDurableWaitOutput(validOutput()) as Record<string, unknown>
    const legacyTask = (legacy.tasks as Array<Record<string, unknown>>)[0]!
    expect(Object.keys(legacyTask).sort()).toEqual(["failureReason", "result", "role", "status", "taskId"])

    const legacyCurrent = validOutput()
    const current = {
      ...legacyCurrent,
      tasks: [{
        ...legacyCurrent.tasks[0]!, attemptCount: 2, maxAttempts: 4,
        leaseExpiresAt: "2026-10-12T10:15:30.000Z", interruptRequestedAt: null,
      }],
    }
    const safe = redactDurableWaitOutput(current) as Record<string, unknown>
    const safeTask = (safe.tasks as Array<Record<string, unknown>>)[0]!
    expect(safeTask).toMatchObject({
      taskId, attemptCount: 2, maxAttempts: 4,
      leaseExpiresAt: "2026-10-12T10:15:30.000Z", interruptRequestedAt: null,
    })
    expect(safeTask).not.toHaveProperty("leaseOwner")

    const invalid = [
      { ...current.tasks[0]!, attemptCount: -1 },
      { ...current.tasks[0]!, maxAttempts: 0 },
      { ...current.tasks[0]!, leaseExpiresAt: "not-a-timestamp" },
      { ...current.tasks[0]!, interruptRequestedAt: 123 },
      { ...current.tasks[0]!, leaseOwner: "private-owner" },
      { taskId, status: "completed", role: "scout", result: null, failureReason: null, attemptCount: 2 },
    ]
    for (const task of invalid) expect(() => redactDurableWaitOutput({ ...current, tasks: [task] })).toThrow("durable_wait_receipt_invalid")
  })

  it("projects resumed native wait results through the same feedback allowlist", () => {
    const output = validOutput()
    Object.assign(output.tasks[0]!.result, {
      status: "completed",
      nativeVerificationReport: {
        schemaVersion: NATIVE_VERIFICATION_REPORT_SCHEMA,
        controlOperationId: "verify-op",
        controlTaskId: taskId,
        controlAttempt: 1,
        owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null },
        target: { kind: "root_goal", candidateDigest: "a".repeat(64), childBindingSetDigest: "b".repeat(64) },
        goalDigest: "c".repeat(64), criteriaDigest: "d".repeat(64), evidencePacketDigest: "e".repeat(64), disposition: "passed",
        criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["target-ref"] }],
      },
    })
    const safe = redactDurableWaitOutput(output) as Record<string, unknown>
    const safeTasks = safe.tasks as Array<Record<string, unknown>>
    expect(safeTasks[0]?.result).toMatchObject({
      status: "completed",
      nativeVerificationFeedback: {
        disposition: "passed",
        criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["target-ref"] }],
      },
    })
    expect(JSON.stringify(safe)).not.toContain("nativeVerificationReport")
    expect(JSON.stringify(safe)).not.toContain("childBindingSetDigest")
    expect(JSON.stringify(safe)).not.toContain("controlTaskId")
  })

  it.each([
    "missing_final_output",
    "result_too_large",
    "result_shape_invalid",
    "evidence_binding_invalid",
  ] as const)("preserves only the fixed category with the existing failed child result fields (%s)", category => {
    const output = validOutput()
    const failedOutput = {
      ...output,
      tasks: output.tasks.map(row => ({
        ...row,
        status: "failed",
        failureReason: "invalid_structured_result",
        result: {
          ...row.result,
          status: "failed",
          stepCount: 2,
          toolCallCount: 1,
          finalItemId: "child-final-item",
          structuredOutputFailureCategory: category,
        },
      })),
    }

    const safe = redactDurableWaitOutput(failedOutput) as Record<string, unknown>
    const taskRows = safe.tasks as Array<Record<string, unknown>>
    const safeRow = taskRows[0]
    const safeResult = safeRow?.result as Record<string, unknown> | undefined
    expect(safeRow).toMatchObject({ status: "failed", failureReason: "invalid_structured_result" })
    expect(safeResult).toMatchObject({
      status: "failed",
      stepCount: 2,
      toolCallCount: 1,
      finalItemId: "child-final-item",
      structuredOutputFailureCategory: category,
    })
    expect(safeResult && Object.keys(safeResult).sort()).toEqual([
      "deepString", "description", "finalItemId", "privateData", "status", "stepCount", "structuredOutputFailureCategory", "taskId", "toolCallCount",
    ])

    const legacyResult = { status: "failed", summary: "Legacy child result" }
    const legacyOutput = {
      ...validOutput(),
      tasks: [{ taskId, status: "failed", role: "scout", result: legacyResult, failureReason: "invalid_structured_result" }],
    }
    const legacySafe = redactDurableWaitOutput(legacyOutput) as Record<string, unknown>
    expect((legacySafe.tasks as Array<Record<string, unknown>>)[0]?.result).toEqual(legacyResult)
  })

  it("fails closed on invalid or contradictory IDs", () => {
    const invalid = [
      { ...validOutput(), waitId: "wait-123" },
      { ...validOutput(), taskIds: ["subagent-12345678-1234-3123-9234-123456789012"] },
      { ...validOutput(), matchedTaskIds: [otherTaskId] },
      { ...validOutput(), tasks: [{ ...validOutput().tasks[0], taskId: otherTaskId }] },
      { ...validOutput(), taskIds: [taskId, taskId], tasks: [{ ...validOutput().tasks[0] }, { ...validOutput().tasks[0] }] },
      { ...validOutput(), matchedTaskIds: [taskId, taskId] },
      { ...validOutput(), tasks: [] },
      { ...validOutput(), extra: "injected" },
      { ...validOutput(), tasks: [{ ...validOutput().tasks[0], extra: "injected" }] },
    ]
    for (const value of invalid) expect(() => redactDurableWaitOutput(value)).toThrow("durable_wait_receipt_invalid")
  })

  it("rejects sparse arrays, custom array fields, accessors, and circular data", () => {
    const sparse = validOutput()
    sparse.taskIds = new Array(1)

    const extended = validOutput()
    Object.defineProperty(extended.matchedTaskIds, "injected", { value: taskId, enumerable: true })

    const accessor = validOutput()
    const row = accessor.tasks[0]!
    Object.defineProperty(row, "taskId", {
      enumerable: true,
      get: () => taskId,
    })

    const cyclic = validOutput()
    const result = cyclic.tasks[0]!.result as Record<string, unknown>
    result.self = result

    for (const value of [sparse, extended, accessor, cyclic]) {
      expect(() => redactDurableWaitOutput(value)).toThrow("durable_wait_receipt_invalid")
    }
  })
})
