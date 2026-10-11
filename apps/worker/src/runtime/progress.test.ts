import { describe, expect, it } from "vitest"

import { createProgressDetector, NoProgressError } from "./progress.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./planning/task-graph-verification.js"
import { stableJson } from "./turns/turn-engine-replay.js"

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

  it("preserves deterministic public fingerprints and the repeated-signature error shape", () => {
    const checkpointOnlyId = "checkpoint-only-private-675"
    const detector = createProgressDetector(2)
    const input = { snapshot, toolCalls: calls }
    const metadata = checkpoint(4n, [checkpointOnlyId], 1)
    const observation = detector.observe(input, metadata)
    const otherObservation = createProgressDetector(2).observe(input, metadata)
    const signature = stableJson(calls.map(call => ({ name: call.name, arguments: call.arguments })))
    const stateFingerprint = stableJson({ businessRefs: [], toolObservations: [] })

    expect(observation).toEqual({ signature, stateFingerprint })
    expect(otherObservation).toEqual(observation)
    expect(JSON.stringify(observation)).not.toContain(checkpointOnlyId)

    let caught: unknown
    try {
      detector.observe(input, metadata)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NoProgressError)
    const error = caught as NoProgressError
    expect(error.observation).toEqual(observation)
    expect(error.message).toBe(`Turn made no progress: repeated ${signature}`)
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

  it("uses a fixed semantic reason only after two persisted repair conflicts and preserves the default reason", () => {
    const current = checkpoint(0n, [], 0)
    const plan = (goal: string) => ({ id: `plan-${goal}`, name: "agent.plan", arguments: {
      expectedRevision: 0,
      nodes: [{ key: "repair", templateId: "scout", goal, successCriteria: [goal], dependsOn: [],
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
          { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
        ] },
        repairOf: { nodeKey: "target-private", taskId: "task-private", criterionIds: ["candidate-count"] },
      }],
    } })
    const denial = (callId: string) => ({ id: `tool-result:${callId}`, content: {
      toolCallId: callId, toolName: "agent.plan", input: plan("earlier prose").arguments, status: "failed",
      output: { code: "task_graph_repair_conflict" }, errorCode: "task_graph_repair_conflict",
    } })
    const detector = createProgressDetector(2)
    detector.observe({ snapshot, toolCalls: [plan("first prose")] }, current)
    detector.observe({ snapshot: { ...snapshot, toolObservations: [denial("plan-1")] }, toolCalls: [plan("second prose")] }, current)

    let caught: unknown
    try {
      detector.observe({ snapshot: { ...snapshot, toolObservations: [denial("plan-1"), denial("plan-2")] }, toolCalls: [plan("third prose")] }, current)
    } catch (error: unknown) { caught = error }
    expect(caught).toBeInstanceOf(NoProgressError)
    expect(caught).toMatchObject({ code: "no_progress", reasonCode: "repeated_repair_conflict", observation: {
      signature: "repair_conflict_retry", stateFingerprint: "unchanged_trusted_repair_epoch",
    } })
    expect(JSON.stringify((caught as NoProgressError).observation)).not.toContain("target-private")
    expect(new NoProgressError({ signature: "ordinary", stateFingerprint: "ordinary-state" }).reasonCode).toBe("repeated_signature")
  })
})
