import { describe, expect, it } from "vitest"
import { canonicalTaskGraphReadObservations, taskGraphEvidenceDigest, validateTaskGraphVerificationItems, type TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"

const scope: TaskGraphVerificationScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "scout-1", attemptCount: 2 }
function pair(overrides: { output?: unknown; call?: Record<string, unknown>; result?: Record<string, unknown> } = {}) {
  const callContent = { toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", input: {}, status: "completed", errorCode: null, ...overrides.call }
  return [
    { id: "call-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepId: "step-1", joinedStepId: "step-1", attempt: 2, ordinal: 0, revision: 1, status: "completed", stepStatus: "completed", type: "tool_call", content: callContent },
    { id: "result-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepId: "step-1", joinedStepId: "step-1", attempt: 2, ordinal: 0, revision: 1, status: "completed", stepStatus: "completed", type: "tool_result", content: { toolCallId: "call-1", output: overrides.output ?? { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null, ...overrides.result } },
  ]
}

describe("TaskGraph canonical verification receipt validation", () => {
  it("binds paired observations to the exact owner, task, step and attempt", () => {
    expect(validateTaskGraphVerificationItems(pair(), scope)).toHaveLength(2)
    expect(() => validateTaskGraphVerificationItems(pair().map(item => ({ ...item, taskId: "other" })), scope)).toThrow("task_graph_verification_item_invalid")
    expect(() => validateTaskGraphVerificationItems(pair().map(item => ({ ...item, attempt: 1 })), scope)).toThrow("task_graph_verification_item_invalid")
    expect(() => validateTaskGraphVerificationItems([pair()[0]!], scope)).toThrow("task_graph_verification_pair_invalid")
  })

  it("projects only complete recognized read outputs and keeps stable receipt digests", () => {
    const items = validateTaskGraphVerificationItems(pair(), scope)
    const outcomes = new Map([["call-1", "completed" as const]])
    const observations = canonicalTaskGraphReadObservations(items, outcomes)
    expect(observations).toEqual([{ id: "tool-result:call-1", content: expect.objectContaining({ toolName: "jobs.search", output: { jobs: [{ id: "job-1", source: "greenhouse" }] } }) }])
    expect(taskGraphEvidenceDigest(items, outcomes, ["evidence-2", "evidence-1"], "a".repeat(64), [])).toMatch(/^[a-f0-9]{64}$/)
    expect(taskGraphEvidenceDigest(items, outcomes, ["evidence-1", "evidence-2"], "a".repeat(64), [])).toEqual(taskGraphEvidenceDigest(items, outcomes, ["evidence-2", "evidence-1"], "a".repeat(64), []))
  })

  it.each([
    ["missing", { job: { id: "job-1" } }],
    ["null", { job: { id: "job-1", source: null } }],
    ["empty", { job: { id: "job-1", source: "" } }],
    ["whitespace-only", { job: { id: "job-1", source: " \t " } }],
  ] as const)("uses the generic jobs.read source fallback for %s jobs.get source", (_name, output) => {
    const items = validateTaskGraphVerificationItems(pair({ call: { toolName: "jobs.get" }, output }), scope)
    const observations = canonicalTaskGraphReadObservations(items, new Map([["call-1", "completed"]]))

    expect(observations[0]?.content).toMatchObject({ toolName: "jobs.get", output: { job: { id: "job-1", source: "jobs.read" } } })
  })

  it.each([
    ["a non-string", { job: { id: "job-1", source: 7 } }],
    ["an over-bound", { job: { id: "job-1", source: "x".repeat(257) } }],
  ] as const)("rejects %s jobs.get source instead of normalizing it", (_name, output) => {
    const items = validateTaskGraphVerificationItems(pair({ call: { toolName: "jobs.get" }, output }), scope)

    expect(() => canonicalTaskGraphReadObservations(items, new Map([["call-1", "completed"]])))
      .toThrow("task_graph_verification_output_invalid")
  })

  it("preserves a bounded nonempty jobs.get source exactly", () => {
    const source = " greenhouse "
    const items = validateTaskGraphVerificationItems(pair({ call: { toolName: "jobs.get" }, output: { job: { id: "job-1", source } } }), scope)
    const observations = canonicalTaskGraphReadObservations(items, new Map([["call-1", "completed"]]))

    expect(observations[0]?.content).toMatchObject({ toolName: "jobs.get", output: { job: { id: "job-1", source } } })
  })

  it.each([
    ["truncated output", { jobs: [{ id: "job-1" }], truncated: true, preview: "x", byteLength: 99 }],
    ["duplicate outputs", { jobs: [{ id: "job-1" }, { id: "job-1" }] }],
    ["unrecognized tool payload", { other: true }],
  ])("rejects %s without partially projecting evidence", (_name, output) => {
    expect(() => canonicalTaskGraphReadObservations(validateTaskGraphVerificationItems(pair({ output }), scope), new Map([["call-1", "completed"]]))).toThrow("task_graph_verification_output_invalid")
  })

  it("excludes failed read calls from the canonical evidence observations", () => {
    const failed = pair({ call: { status: "failed", errorCode: "read_failed" }, result: { errorCode: "read_failed" } })
    const items = validateTaskGraphVerificationItems(failed, scope)
    expect(canonicalTaskGraphReadObservations(items, new Map([["call-1", "failed"]]))).toEqual([])
  })
})
