import { describe, expect, it } from "vitest"
import { projectDurableWaitOutcome } from "../subagents/durable-wait-dependency-revalidation.js"
import { hasResolvedWaitOutcome, parseWaitRequest } from "./turn-execution-wait.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"

const waitId = "wait-00000000-0000-4000-8000-000000000001"
const input = { idempotencyKey: "wait-key", taskIds: ["child-b", "child-a"], mode: "all" as const, timeoutMs: 30_000 }
const outcome = {
  waitId, status: "ready", matchedTaskIds: ["child-a", "child-b"], targetTaskIds: ["child-a", "child-b"],
  tasks: [{ taskId: "child-a", status: "completed" }, { taskId: "child-b", status: "completed" }],
}
function snapshot(content: unknown, id = `wait-result:${waitId}`): StepContextSnapshot {
  return { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [{ id, content }] }
}
function producerProjection(value: unknown = outcome) {
  return projectDurableWaitOutcome(waitId, { value: toRepositoryJson(value), taskIds: ["child-a", "child-b"], mode: "all" })
}
function projectionContent(value: ReturnType<typeof producerProjection>) {
  if (!value.content || typeof value.content !== "object" || Array.isArray(value.content)) throw new Error("fixture_projection_invalid")
  return value.content
}

describe("canonical durable wait outcome matching", () => {
  it("matches the production two-field projection against the exact original request", () => {
    const projection = producerProjection()
    const content = projectionContent(projection)
    expect(content).toMatchObject({ input: { taskIds: ["child-a", "child-b"], mode: "all" } })
    if (!content.input || typeof content.input !== "object" || Array.isArray(content.input)) throw new Error("fixture_input_invalid")
    expect(Object.keys(content.input).sort()).toEqual(["mode", "taskIds"])
    expect(hasResolvedWaitOutcome(snapshot(content), waitId, input)).toBe(true)
  })

  it.each([
    ["different target", { taskIds: ["child-a", "child-c"], mode: "all" }],
    ["different mode", { taskIds: ["child-a", "child-b"], mode: "any" }],
    ["extra omitted authority fields", { taskIds: ["child-a", "child-b"], mode: "all", idempotencyKey: "wait-key", timeoutMs: 30_000 }],
  ])("rejects a projected request with %s", (_name, projectedInput) => {
    const projection = producerProjection()
    expect(hasResolvedWaitOutcome(snapshot({ ...projectionContent(projection), input: projectedInput }), waitId, input)).toBe(false)
  })

  it("requires the exact wait result identity and output linkage", () => {
    const projection = producerProjection()
    const content = projectionContent(projection)
    expect(hasResolvedWaitOutcome(snapshot(content, "wait-result:wait-00000000-0000-4000-8000-000000000002"), waitId, input)).toBe(false)
    expect(hasResolvedWaitOutcome(snapshot({ ...content, toolCallId: "wait:other" }), waitId, input)).toBe(false)
    expect(hasResolvedWaitOutcome(snapshot({ ...content, output: { ...outcome, waitId: "other" } }), waitId, input)).toBe(false)
  })

  it("accepts only the producer-shaped, incomplete interrupted outcome when recovery expects interruption", () => {
    const interrupted = {
      waitId, status: "interrupted", matchedTaskIds: ["child-a"], targetTaskIds: ["child-a", "child-b"],
      tasks: [
        { taskId: "child-a", status: "completed", role: "scout", result: null, failureReason: null },
        { taskId: "child-b", status: "running", role: "scout", result: null, failureReason: null },
      ],
    }
    const content = projectionContent(projectDurableWaitOutcome(waitId, {
      value: toRepositoryJson(interrupted), taskIds: ["child-a", "child-b"], mode: "all",
    }))
    expect(hasResolvedWaitOutcome(snapshot(content), waitId, input)).toBe(false)
    expect(hasResolvedWaitOutcome(snapshot(content), waitId, input, "interrupted")).toBe(true)
    expect(hasResolvedWaitOutcome(snapshot({ ...content, extra: true }), waitId, input, "interrupted")).toBe(false)

    const impossibleMatch = { ...interrupted, matchedTaskIds: ["child-a", "child-b"] }
    expect(hasResolvedWaitOutcome(snapshot({ ...content, output: impossibleMatch }), waitId, input, "interrupted")).toBe(false)
    const foreignMatch = { ...interrupted, matchedTaskIds: ["child-c"] }
    expect(hasResolvedWaitOutcome(snapshot({ ...content, output: foreignMatch }), waitId, input, "interrupted")).toBe(false)
    const wrongTarget = { ...interrupted, targetTaskIds: ["child-a", "child-c"] }
    expect(hasResolvedWaitOutcome(snapshot({ ...content, output: wrongTarget }), waitId, input, "interrupted")).toBe(false)
    const wrongTaskOrder = { ...interrupted, tasks: [...interrupted.tasks].reverse() }
    expect(hasResolvedWaitOutcome(snapshot({ ...content, output: wrongTaskOrder }), waitId, input, "interrupted")).toBe(false)
  })

  it("keeps original tool invocation strict", () => {
    expect(parseWaitRequest(input)).toMatchObject({ idempotencyKey: "wait-key", taskIds: ["child-a", "child-b"], mode: "all" })
    expect(parseWaitRequest({ ...input, extra: true })).toBeNull()
  })
})
