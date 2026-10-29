import { describe, expect, it } from "vitest"
import { redactSensitiveText } from "@jobcopilot/shared"

import { mergeDurableWaitObservation, resolveDurableWaitOutcome } from "./child-resume-observations.js"

const targetId = "subagent-00000000-0000-4000-8000-000000000001"
const otherId = "child-b"
const phoneShapedCallId = "child-wait-call:415-555-0134"
const freeText = `Call +1 (415) 555-0134 about ${targetId}`
const wait = {
  waitId: "wait-1", stepId: "step-1", attempt: 1, ordinal: 2, toolCallId: "wait-call", sourceItemId: "wait-result",
  input: { idempotencyKey: "key-1", taskIds: [targetId, otherId], mode: "all", timeoutMs: 5_000 },
  output: { waitId: "wait-1", status: "ready", taskIds: [otherId, targetId], deadlineAt: "2099-01-01T00:00:00.000Z",
    matchedTaskIds: [targetId, otherId], tasks: [
      { taskId: otherId, status: "completed", role: "analyst", result: null, failureReason: null },
      { taskId: targetId, status: "completed", role: "scout", result: { finalText: freeText }, failureReason: null },
    ] },
} as const

describe("durable child wait resume observation", () => {
  it("validates the durable shape, retains only structural IDs, and preserves valid reordering", () => {
    const row = { id: "wait-1", status: "ready", mode: "all", targetTaskIds: [targetId, otherId],
      matchedTaskIds: [targetId, otherId], deadlineAt: "2099-01-01T00:00:00.000Z", result: { outcome: wait.output } }
    expect(resolveDurableWaitOutcome(row, row.targetTaskIds, row.matchedTaskIds, new Date("2026-10-22T10:00:00.000Z")))
      .toMatchObject({ waitId: "wait-1", status: "ready", taskIds: row.targetTaskIds })
    expect(() => resolveDurableWaitOutcome(row, row.targetTaskIds, [targetId], new Date("2026-10-22T10:00:00.000Z")))
      .toThrow("Persisted child wait result is invalid")

    const observations = [
      { id: "child-resume:wait-result", content: { toolCallId: "wait-call", toolName: "wait_subagents", input: wait.input, status: "completed", output: { status: "waiting" }, errorCode: null } },
      { id: "child-resume:other-result", content: { toolCallId: "other-call", toolName: "jobs.search", input: {}, status: "completed", output: { jobs: [] }, errorCode: null } },
    ]
    const restored = mergeDurableWaitObservation(observations, wait)
    expect(restored).toHaveLength(2)
    expect(restored[0]).toEqual(observations[1])
    expect(restored[1]?.id).toBe("child-resume:wait-result")

    const content = restored[1]?.content as Record<string, unknown>
    const input = content.input as Record<string, unknown>
    const output = content.output as Record<string, unknown>
    const tasks = output.tasks as Array<Record<string, unknown>>
    expect(input.taskIds).toEqual([targetId, otherId])
    expect(output.taskIds).toEqual([otherId, targetId])
    expect(output.matchedTaskIds).toEqual([targetId, otherId])
    expect(tasks.map(task => task.taskId)).toEqual([otherId, targetId])
    expect((tasks[1]?.result as Record<string, unknown>).finalText).toBe(redactSensitiveText(freeText))
    expect((tasks[1]?.result as Record<string, unknown>).finalText).not.toContain(targetId)
  })

  it("retains the validated canonical call ID internally while redacting ordinary restored text", () => {
    const phoneWait = { ...wait, toolCallId: phoneShapedCallId }
    const restored = mergeDurableWaitObservation([], phoneWait)
    const content = restored[0]?.content as Record<string, unknown>
    const output = content.output as Record<string, unknown>
    const tasks = output.tasks as Array<Record<string, unknown>>

    expect(redactSensitiveText(phoneShapedCallId)).not.toBe(phoneShapedCallId)
    expect(content.toolCallId).toBe(phoneShapedCallId)
    expect((tasks[1]?.result as Record<string, unknown>).finalText).toBe(redactSensitiveText(freeText))
    expect(JSON.stringify(content.input)).not.toContain(phoneShapedCallId)
    expect(JSON.stringify(content.output)).not.toContain(phoneShapedCallId)
  })

  it("matches wait observations by exact raw ID and fails closed on conflicting or duplicate lineage", () => {
    const phoneWait = { ...wait, toolCallId: phoneShapedCallId }
    const redactedIdObservation = { id: "child-resume:unrelated", content: { toolCallId: redactSensitiveText(phoneShapedCallId) } }
    const restored = mergeDurableWaitObservation([redactedIdObservation], phoneWait)
    expect(restored).toHaveLength(2)
    expect((restored[1]?.content as Record<string, unknown>).toolCallId).toBe(phoneShapedCallId)

    const prior = { id: `child-resume:${wait.sourceItemId}`, content: { toolCallId: phoneShapedCallId } }
    expect(mergeDurableWaitObservation([prior], phoneWait)).toHaveLength(1)
    const oldRedactedSource = { id: `child-resume:${wait.sourceItemId}`, content: { toolCallId: redactSensitiveText(phoneShapedCallId) } }
    expect((mergeDurableWaitObservation([oldRedactedSource], phoneWait)[0]?.content as Record<string, unknown>).toolCallId)
      .toBe(phoneShapedCallId)
    expect(() => mergeDurableWaitObservation([{ id: "tool-result:phone", content: { toolCallId: phoneShapedCallId } }], phoneWait))
      .toThrow("child_resume_wait_tool_call_conflict")
    expect(() => mergeDurableWaitObservation([
      prior,
      { id: "child-resume:duplicate", content: { toolCallId: phoneShapedCallId } },
    ], phoneWait)).toThrow("child_resume_wait_tool_call_conflict")
    expect(() => mergeDurableWaitObservation([
      { id: "child-resume:wrong-source", content: { toolCallId: phoneShapedCallId } },
    ], phoneWait)).toThrow("child_resume_wait_tool_call_conflict")
    expect(() => mergeDurableWaitObservation([
      { id: `child-resume:${wait.sourceItemId}`, content: { toolCallId: "misbound-call" } },
    ], phoneWait)).toThrow("child_resume_wait_tool_call_conflict")
  })

  it("rejects malformed canonical wait call IDs without normalizing their identity", () => {
    expect(() => mergeDurableWaitObservation([], { ...wait, toolCallId: " " }))
      .toThrow("child_resume_wait_lineage")
    expect(() => mergeDurableWaitObservation([], { ...wait, toolCallId: "x".repeat(257) }))
      .toThrow("child_resume_wait_lineage")
  })

  it("rejects duplicate, missing, forged, malformed, and misbound target IDs", () => {
    expect(() => mergeDurableWaitObservation([], { ...wait, input: { ...wait.input, taskIds: [targetId, targetId] } }))
      .toThrow("child_resume_invalid_wait_input")
    expect(() => mergeDurableWaitObservation([], { ...wait, input: { ...wait.input, taskIds: [targetId, 2] } }))
      .toThrow("child_resume_invalid_wait_input")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, taskIds: [targetId] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, taskIds: ["forged", otherId] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, taskIds: [otherId, otherId] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, matchedTaskIds: ["foreign"] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output,
      tasks: [wait.output.tasks[0], { ...wait.output.tasks[1], taskId: "misbound" }] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, waitId: "other-wait" } }))
      .toThrow("child_resume_invalid_wait_result")
  })

  it("checks matched IDs against the stored task snapshot while allowing valid timeout and async states", () => {
    const anyMode = { ...wait, input: { ...wait.input, mode: "any" } }
    const readyAsync = { ...anyMode, output: { ...wait.output, matchedTaskIds: [targetId], tasks: [
      { ...wait.output.tasks[0], status: "running" }, wait.output.tasks[1],
    ] } }
    expect(() => mergeDurableWaitObservation([], readyAsync)).not.toThrow()
    expect(() => mergeDurableWaitObservation([], { ...anyMode, output: { ...readyAsync.output,
      tasks: [{ ...readyAsync.output.tasks[0], status: "running" }, { ...readyAsync.output.tasks[1], status: "running" }] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output,
      tasks: wait.output.tasks.map(task => ({ ...task, status: "running" })) } }))
      .toThrow("child_resume_invalid_wait_result")

    const timedOut = { ...wait, output: { ...wait.output, status: "timed_out", deadlineAt: new Date(Date.now() - 60_000).toISOString(),
      matchedTaskIds: [targetId], tasks: [ { ...wait.output.tasks[0], status: "running" }, wait.output.tasks[1] ] } }
    expect(() => mergeDurableWaitObservation([], timedOut)).not.toThrow()
    expect(() => mergeDurableWaitObservation([], { ...timedOut, output: { ...timedOut.output, matchedTaskIds: [],
      tasks: timedOut.output.tasks.map(task => ({ ...task, status: "running" })) } })).not.toThrow()
  })
})
