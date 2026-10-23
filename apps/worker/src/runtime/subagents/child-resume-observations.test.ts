import { describe, expect, it } from "vitest"

import { mergeDurableWaitObservation, resolveDurableWaitOutcome } from "./child-resume-observations.js"

const wait = {
  waitId: "wait-1", stepId: "step-1", attempt: 1, ordinal: 2, toolCallId: "wait-call", sourceItemId: "wait-result",
  input: { idempotencyKey: "key-1", taskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 5_000 },
  output: { waitId: "wait-1", status: "ready", taskIds: ["child-a", "child-b"], deadlineAt: "2099-01-01T00:00:00.000Z",
    matchedTaskIds: ["child-a", "child-b"], tasks: [{ taskId: "child-a" }, { taskId: "child-b" }] },
} as const

describe("durable child wait resume observation", () => {
  it("accepts only the persisted outcome matching its exact direct children", () => {
    const row = { id: "wait-1", status: "ready", mode: "all", targetTaskIds: ["child-a", "child-b"],
      matchedTaskIds: ["child-a", "child-b"], deadlineAt: "2099-01-01T00:00:00.000Z", result: { outcome: wait.output } }
    expect(resolveDurableWaitOutcome(row, row.targetTaskIds, row.matchedTaskIds, new Date("2026-10-22T10:00:00.000Z")))
      .toMatchObject({ waitId: "wait-1", status: "ready", taskIds: row.targetTaskIds })
    expect(() => resolveDurableWaitOutcome(row, row.targetTaskIds, ["child-a"], new Date("2026-10-22T10:00:00.000Z")))
      .toThrow("Persisted child wait result is invalid")
  })

  it("replaces the immutable original result with the persisted resolved projection exactly once", () => {
    const observations = [
      { id: "child-resume:old-wait-result", content: { toolCallId: "wait-call", toolName: "wait_subagents", input: wait.input, status: "completed", output: { status: "waiting" }, errorCode: null } },
      { id: "child-resume:other-result", content: { toolCallId: "other-call", toolName: "jobs.search", input: {}, status: "completed", output: { jobs: [] }, errorCode: null } },
    ]

    const restored = mergeDurableWaitObservation(observations, wait)

    expect(restored).toHaveLength(2)
    expect(restored[0]).toEqual(observations[1])
    expect(restored[1]).toMatchObject({ id: "child-resume:wait-result", content: {
      toolCallId: "wait-call", toolName: "wait_subagents", input: wait.input, status: "completed", output: wait.output, errorCode: null,
    } })
  })

  it("rejects unresolved, mismatched, or malformed durable projections", () => {
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, status: "waiting" } })).toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, taskIds: ["child-a"] } })).toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, input: { ...wait.input, taskIds: ["child-a", "child-a"] } })).toThrow("child_resume_invalid_wait_input")
  })
})
