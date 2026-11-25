import { describe, expect, it } from "vitest"
import { objectiveJobRequirementMaterialDigest, verifyObjectiveJobRequirementEvidence,
  type ObjectiveJobRequirementDeliveryCandidate } from "./objective-job-requirement-evidence.js"

const jobId = "123e4567-e89b-42d3-a456-426614174000"
function job(overrides: Record<string, unknown> = {}) {
  return { id: jobId, company: "Example", role: "Engineer", location: null, status: "saved", score: 8,
    url: "https://example.test/job", source: "greenhouse", salary: null,
    description: "🙂 Required: Rust. More details.", keywords: "generated metadata", ...overrides }
}
function delivery(id = "call-1", requestedJobId = jobId, outputJob = job()): ObjectiveJobRequirementDeliveryCandidate {
  return { call: { id: `call-item-${id}`, stepId: `step-${id}`, attempt: 2, ordinal: 0, revision: 1 },
    callContent: { toolCallId: id, toolName: "jobs.get", toolVersion: "1", input: { jobId: requestedJobId },
      status: "completed", errorCode: null }, outcome: "completed",
    result: { id: `result-item-${id}`, stepId: `step-${id}`, attempt: 2, ordinal: 0, revision: 1 },
    resultContent: { toolCallId: id, output: { job: outputJob }, status: "completed", errorCode: null }, replay: null }
}
function verify(overrides: Record<string, unknown> = {}) {
  return verifyObjectiveJobRequirementEvidence({ proposal: { jobId, evidenceId: "job-proof", quote: "Required: Rust." },
    attemptCount: 2, currentJob: job(), deliveries: [delivery()], ...overrides })
}

describe("shared Objective requirement evidence policy", () => {
  it("verifies an exact same-attempt jobs.get quote and returns only bounded receipt metadata", () => {
    expect(verify()).toMatchObject({ inputJobId: jobId, outputJobId: jobId, toolVersion: "1", startUtf16: 3, endUtf16: 18,
      inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/), outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      jobMaterialDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), quoteDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      deliveries: [{ toolCallId: "call-1", callItemId: "call-item-call-1", resultItemId: "result-item-call-1" }] })
    expect(objectiveJobRequirementMaterialDigest(job())).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(verify())).not.toContain("More details")
  })

  it.each([
    ["requested/output Job mismatch", { deliveries: [delivery("call-1", "123e4567-e89b-42d3-a456-426614174001")] }],
    ["changed current source", { currentJob: job({ description: "Changed posting" }) }],
    ["different attempt", { attemptCount: 3 }],
    ["missing result", { deliveries: [{ ...delivery(), result: null, resultContent: null }] }],
    ["incomplete verification input", { extra: true }],
    ["repeated quote", { deliveries: [delivery("call-1", jobId, job({ description: "Required: Rust. Again: Required: Rust." }))] }],
  ])("rejects %s", (_name, overrides) => expect(verify(overrides)).toBeNull())

  it("rejects competing direct receipts and accepts exact replay lineage", () => {
    expect(verify({ deliveries: [delivery("call-1"), delivery("call-2")] })).toBeNull()
    expect(verify({ deliveries: [delivery("call-1"), { ...delivery("call-2"), replay: {
      currentCallId: "call-2", sourceCallItemId: "call-item-call-1", sourceResultItemId: "result-item-call-1" } }] }))
      .toMatchObject({ deliveries: [{ toolCallId: "call-1" }, { toolCallId: "call-2",
        replaySourceCallItemId: "call-item-call-1", replaySourceResultItemId: "result-item-call-1" }] })
  })

  it("checks candidate bounds before walking a large array", () => {
    const oversized = new Proxy(new Array(1025), { ownKeys() { throw new Error("must_not_enumerate") } })
    expect(verify({ deliveries: oversized })).toBeNull()
  })
})
