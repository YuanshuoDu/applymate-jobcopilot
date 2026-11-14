import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createObservedEvidenceIndex, hydrateObservedEvidence } from "./child-evidence.js"
import { canonicalTaskGraphReadObservations, taskGraphEvidenceDigest, validateTaskGraphVerificationItems, type TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"

const scope: TaskGraphVerificationScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "scout-1", attemptCount: 2 }
function pair(overrides: { output?: unknown; call?: Record<string, unknown>; result?: Record<string, unknown> } = {}) {
  const callContent = { toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", input: {}, status: "completed", errorCode: null, ...overrides.call }
  return [
    { id: "call-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepId: "step-1", joinedStepId: "step-1", attempt: 2, ordinal: 0, revision: 1, status: "completed", stepStatus: "completed", type: "tool_call", content: callContent },
    { id: "result-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepId: "step-1", joinedStepId: "step-1", attempt: 2, ordinal: 0, revision: 1, status: "completed", stepStatus: "completed", type: "tool_result", content: { toolCallId: "call-1", output: overrides.output ?? { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null, ...overrides.result } },
  ]
}
function readPair(id: string, toolName: string, input: unknown, output: unknown, ordinal: number) {
  return pair({ call: { toolCallId: id, toolName, input }, output, result: { toolCallId: id } }).map((item, index) => ({
    ...item, id: `${id}-${index}`, ordinal,
    content: index === 0 ? { ...(item.content as Record<string, unknown>), toolCallId: id } : { ...(item.content as Record<string, unknown>), toolCallId: id },
  }))
}
const JOB_ID = `c${"a".repeat(24)}`
const DISCOVERY_REF = "tool-result-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
function discoveryOutput(location = "Dublin, Ireland") {
  return {
    jobs: [{ id: JOB_ID, title: "Engineer", company: "Example", location, url: "https://example.test/job",
      description: "", fullDescription: "", salary: null, logo: null, source: "greenhouse", evidenceRefs: ["evidence-1"] }],
    evidence: [{ evidenceId: "evidence-1", jobId: JOB_ID, kind: "source", source: "greenhouse",
      url: "https://example.test/job", summary: "Source listing" }],
    nextCursor: null,
    usage: { toolName: "jobs.discover", toolVersion: "1", requests: 1, jobsProcessed: 1, jobsSucceeded: 1,
      jobsFailed: 0, aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1 },
  }
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
    expect(observations).toEqual([{ id: "tool-result:call-1", content: expect.objectContaining({ toolName: "jobs.search", output: { jobs: [{ id: "job-1", source: "greenhouse", observedSource: "greenhouse", location: null }] } }) }])
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

    expect(observations[0]?.content).toMatchObject({ toolName: "jobs.get", output: { job: { id: "job-1", source: "jobs.read", observedSource: null, location: null } } })
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

    expect(observations[0]?.content).toMatchObject({ toolName: "jobs.get", output: { job: { id: "job-1", source, observedSource: source, location: null } } })
  })

  it("preserves source-reported locations for search and get", () => {
    const search = canonicalTaskGraphReadObservations(validateTaskGraphVerificationItems(pair({
      output: { jobs: [{ id: "job-1", source: "greenhouse", location: "Dublin, Ireland" }, { id: "job-2", source: null, location: null }] },
    }), scope), new Map([["call-1", "completed"]]))
    expect(search[0]?.content).toMatchObject({ output: { jobs: [
      { id: "job-1", source: "greenhouse", observedSource: "greenhouse", location: "Dublin, Ireland" },
      { id: "job-2", source: "jobs.read", observedSource: null, location: null },
    ] } })

    const get = canonicalTaskGraphReadObservations(validateTaskGraphVerificationItems(pair({
      call: { toolName: "jobs.get" }, output: { job: { id: "job-1", source: "greenhouse", location: "Dublin, Ireland" } },
    }), scope), new Map([["call-1", "completed"]]))
    expect(get[0]?.content).toMatchObject({ output: { job: {
      id: "job-1", source: "greenhouse", observedSource: "greenhouse", location: "Dublin, Ireland",
    } } })
  })

  it.each([
    ["non-string location", { job: { id: "job-1", source: "greenhouse", location: 7 } }],
    ["over-bound location", { job: { id: "job-1", source: "greenhouse", location: "x".repeat(501) } }],
  ] as const)("rejects %s jobs.get output", (_name, output) => {
    const items = validateTaskGraphVerificationItems(pair({ call: { toolName: "jobs.get" }, output }), scope)
    expect(() => canonicalTaskGraphReadObservations(items, new Map([["call-1", "completed"]])))
      .toThrow("task_graph_verification_output_invalid")
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

  it("projects only a complete redacted jobs.discover receipt and rejects truncated location evidence", () => {
    const output = discoveryOutput()
    const observations = canonicalTaskGraphReadObservations(
      validateTaskGraphVerificationItems(readPair("discover-call", "jobs.discover", {}, output, 0), scope),
      new Map([["discover-call", "completed"]]),
    )
    expect(observations[0]?.content.output).toMatchObject({ jobs: [{ id: JOB_ID, source: "greenhouse", location: "Dublin, Ireland" }] })

    const truncated = discoveryOutput("Dublin...[TRUNCATED]")
    expect(() => canonicalTaskGraphReadObservations(
      validateTaskGraphVerificationItems(readPair("discover-call", "jobs.discover", {}, truncated, 0), scope),
      new Map([["discover-call", "completed"]]),
    )).toThrow("task_graph_verification_output_invalid")
  })

  it("restores a durable discovery location only from the exact successful read chunk receipts", () => {
    const bytes = Buffer.from(JSON.stringify(discoveryOutput()), "utf8")
    const digest = createHash("sha256").update(bytes).digest("hex")
    const reference = { $ref: DISCOVERY_REF, sizeBytes: bytes.length, sha256: digest }
    const items = validateTaskGraphVerificationItems([
      ...readPair("discover-call", "jobs.discover", {}, reference, 0),
      ...readPair("chunk-call", "tool_results.read", { referenceId: DISCOVERY_REF }, {
        ref: DISCOVERY_REF, sha256: digest, byteCount: bytes.length, chunk: bytes.toString("utf8"), nextCursor: null,
      }, 1),
    ], scope)
    const observations = canonicalTaskGraphReadObservations(items, new Map([
      ["discover-call", "completed"], ["chunk-call", "completed"],
    ]))
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, observations)
    expect(index.jobFacts.facts.get(JOB_ID)).toMatchObject({ location: "dublin, ireland", locationEvidenceStatus: "verified" })
  })

  it("rejects durable reads whose requested reference or chunk metadata does not match", () => {
    const bytes = Buffer.from(JSON.stringify(discoveryOutput()), "utf8")
    const digest = createHash("sha256").update(bytes).digest("hex")
    const items = validateTaskGraphVerificationItems([
      ...readPair("discover-call", "jobs.discover", {}, { $ref: DISCOVERY_REF, sizeBytes: bytes.length, sha256: digest }, 0),
      ...readPair("chunk-call", "tool_results.read", { referenceId: "tool-result-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, {
        ref: DISCOVERY_REF, sha256: digest, byteCount: bytes.length, chunk: bytes.toString("utf8"), nextCursor: null,
      }, 1),
    ], scope)
    expect(() => canonicalTaskGraphReadObservations(items, new Map([
      ["discover-call", "completed"], ["chunk-call", "completed"],
    ]))).toThrow("task_graph_verification_output_invalid")
  })
})
