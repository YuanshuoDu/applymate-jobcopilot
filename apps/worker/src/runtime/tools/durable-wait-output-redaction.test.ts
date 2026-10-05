import { describe, expect, it } from "vitest"
import { redactSensitiveValue } from "@jobcopilot/shared"

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
