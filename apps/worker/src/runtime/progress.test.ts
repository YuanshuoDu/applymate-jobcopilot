import { describe, expect, it } from "vitest"

import { createProgressDetector, NoProgressError } from "./progress.js"

const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }
const calls = [{ id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }]
function checkpoint(inputThroughSequence: bigint, consumedInputIds: readonly string[] = [], taskGraphRevision?: number) {
  return { inputThroughSequence, consumedInputIds, ...(taskGraphRevision === undefined ? {} : { taskGraphRevision }) }
}
const sparseInputIds = new Array<string>(1)

describe("no-progress detector", () => {
  it("stops a repeated tool signature with a reason code", () => {
    const detector = createProgressDetector(2)
    detector.observe({ snapshot, toolCalls: calls })
    expect(() => detector.observe({ snapshot, toolCalls: [{ ...calls[0], id: "call-2" }] })).toThrowError(NoProgressError)
    try { detector.observe({ snapshot, toolCalls: calls }) } catch (error: unknown) { expect(error).toMatchObject({ code: "no_progress", reasonCode: "repeated_signature" }) }
  })

  it("starts one new window for a forward owned input checkpoint, then stops unchanged repetition", () => {
    const detector = createProgressDetector(2), initial = checkpoint(0n, [], 0)
    detector.observe({ snapshot, toolCalls: calls }, initial)
    expect(detector.observe({ snapshot, toolCalls: calls }, checkpoint(1n, ["steer-1"], 0))).toMatchObject({ signature: expect.any(String) })
    expect(() => detector.observe({ snapshot, toolCalls: calls }, checkpoint(1n, ["steer-1"], 0))).toThrowError(NoProgressError)
  })

  it("treats revision zero as a stable baseline and only resets for a forward known revision", () => {
    const detector = createProgressDetector(2), revisionZero = checkpoint(0n, [], 0)
    detector.observe({ snapshot, toolCalls: calls }, revisionZero)
    expect(() => detector.observe({ snapshot, toolCalls: calls }, revisionZero)).toThrowError(NoProgressError)
    detector.observe({ snapshot, toolCalls: calls }, checkpoint(0n, [], 1))
    expect(() => detector.observe({ snapshot, toolCalls: calls }, checkpoint(0n, [], 1))).toThrowError(NoProgressError)
  })

  it("does not reopen a progressed window for replayed or reordered checkpoint data", () => {
    const detector = createProgressDetector(2)
    detector.observe({ snapshot, toolCalls: calls }, checkpoint(0n, [], 0))
    detector.observe({ snapshot, toolCalls: calls }, checkpoint(2n, ["steer-a", "steer-b"], 2))
    detector.observe({ snapshot, toolCalls: calls }, checkpoint(3n, ["steer-a", "steer-b", "steer-c"], 3))
    expect(() => detector.observe({ snapshot, toolCalls: calls }, checkpoint(2n, ["steer-a", "steer-b"], 2))).toThrowError(NoProgressError)
    expect(() => detector.observe({ snapshot, toolCalls: calls }, checkpoint(3n, ["steer-c", "steer-b", "steer-a"], 3))).toThrowError(NoProgressError)
  })

  it("ignores a graph revision claimed only by untrusted tool observation content", () => {
    const detector = createProgressDetector(2), current = checkpoint(3n, ["steer-a", "steer-b"], 4)
    const graph = (revision: number) => ({ ...snapshot,
      toolObservations: [{ id: "task-graph-current", content: { kind: "task_graph_current", revision } }],
    })
    detector.observe({ snapshot: graph(4), toolCalls: calls }, current)
    expect(() => detector.observe({ snapshot: graph(99), toolCalls: calls }, current)).toThrowError(NoProgressError)
  })

  it.each([
    checkpoint(-1n), checkpoint(1n, ["duplicate", "duplicate"]), checkpoint(1n, [], -1), checkpoint(1n, sparseInputIds),
  ])("does not reset for invalid checkpoint metadata", invalid => {
    const detector = createProgressDetector(2), baseline = checkpoint(0n, [], 0)
    detector.observe({ snapshot, toolCalls: calls }, baseline)
    expect(() => detector.observe({ snapshot, toolCalls: calls }, invalid)).toThrowError(NoProgressError)
  })
})
