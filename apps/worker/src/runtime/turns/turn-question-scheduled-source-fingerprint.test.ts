import { describe, expect, it } from "vitest"
import { isCanonicalAnalyzeCheckpointTimestamp, scheduledAnalyzeCheckpointDigest,
  scheduledAnalyzeSourceFingerprintProjection } from "./turn-question-scheduled-source-fingerprint.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "lease-1", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 3 }
const key = `scheduled-taskgraph:v2:sha256:${"a".repeat(64)}`
const fingerprint = (digit: string) => ({ version: "agent-harness.v2.analyze-source-input.v1", digest: digit.repeat(64) })

describe("scheduled Analyze source fingerprint projection", () => {
  it("uses sorted job-id rows and accepts fingerprints independent of map insertion order", () => {
    const state = { scheduledTaskGraphAnalyzeSourceFingerprints: { "job-b": fingerprint("b"), "job-a": fingerprint("a") } }
    expect(scheduledAnalyzeSourceFingerprintProjection(state, ["job-b", "job-a"])).toEqual([
      ["job-a", fingerprint("a").version, fingerprint("a").digest],
      ["job-b", fingerprint("b").version, fingerprint("b").digest],
    ])
  })

  it("builds Web's canonical Analyze checkpoint digest with sorted complete fingerprint rows", () => {
    const sourceFingerprints = { "job-b": fingerprint("b"), "job-a": fingerprint("a") }
    const state = { scheduledTaskGraphAnalyzeSourceFingerprints: sourceFingerprints }
    const scoredJobs = [
      { jobId: "job-b", score: 72, matchedKeywords: ["Rust"], missingKeywords: [], recommendation: "Review" },
      { jobId: "job-a", score: 84, matchedKeywords: ["TypeScript"], missingKeywords: ["AWS"], recommendation: "Apply" },
    ]
    const input = { state, owner: ["user-1", "session-1", "turn-1", "root-1", 2, "execution-1", 3],
      snapshotDigest: `sha256:${"c".repeat(64)}`, evidenceDigest: "d".repeat(64), analyzeGraphRevision: 7,
      analysisFailed: 0, scoredJobs }
    expect(scheduledAnalyzeCheckpointDigest(input)).toBe("3ba58cad1cfc3b3d7d4e4171957b391fe02c13e8a83c57b87f7b2989d8ee8148")
    expect(scheduledAnalyzeCheckpointDigest({ ...input, state: {} })).toBeNull()
  })

  it("accepts only canonical UTC ISO timestamps for checkpoint fence values", () => {
    expect(isCanonicalAnalyzeCheckpointTimestamp("2026-10-06T10:00:00.000Z")).toBe(true)
    expect(isCanonicalAnalyzeCheckpointTimestamp("2026-10-06T10:00:00+00:00")).toBe(false)
    expect(isCanonicalAnalyzeCheckpointTimestamp("2026-10-06")).toBe(false)
    expect(isCanonicalAnalyzeCheckpointTimestamp("invalid")).toBe(false)
  })

  it.each([
    ["missing map", undefined],
    ["missing scored job", { "job-a": fingerprint("a") }],
    ["extra job", { "job-a": fingerprint("a"), "job-b": fingerprint("b"), "job-c": fingerprint("c") }],
    ["unknown version", { "job-a": { ...fingerprint("a"), version: "legacy" }, "job-b": fingerprint("b") }],
    ["malformed digest", { "job-a": { ...fingerprint("a"), digest: "bad" }, "job-b": fingerprint("b") }],
    ["extra fingerprint field", { "job-a": { ...fingerprint("a"), extra: true }, "job-b": fingerprint("b") }],
  ])("fails closed for %s", (_label, fingerprints) => {
    expect(scheduledAnalyzeSourceFingerprintProjection({ scheduledTaskGraphAnalyzeSourceFingerprints: fingerprints }, ["job-a", "job-b"]))
      .toBeNull()
  })

  it("allows only the same strict safe-empty checkpoint used by Web", () => {
    const state = safeEmptyCheckpoint()
    expect(scheduledAnalyzeSourceFingerprintProjection(state, [])).toEqual([])
    expect(scheduledAnalyzeSourceFingerprintProjection({ ...state, scheduledTaskGraphAnalyzeSourceFingerprints: {} }, [])).toEqual([])
    expect(scheduledAnalyzeSourceFingerprintProjection({ ...state, analysisFailed: 1 }, [])).toBeNull()
    expect(scheduledAnalyzeSourceFingerprintProjection({ ...state, scoutedJobs: [{ id: "job-a" }] }, [])).toBeNull()
    expect(scheduledAnalyzeSourceFingerprintProjection({ ...state, scheduledTaskGraphAnalyzeSourceFingerprints: { extra: fingerprint("e") } }, []))
      .toBeNull()
    expect(scheduledAnalyzeSourceFingerprintProjection({ ...state, scheduledTaskGraphClaim: { ...state.scheduledTaskGraphClaim, claimToken: "" } }, []))
      .toBeNull()
  })
})

function safeEmptyCheckpoint() {
  const now = "2026-11-17T00:00:00.000Z"
  return { nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken: "claim-1",
      owner, claimedAt: now, leaseExpiresAt: "2026-11-17T00:05:00.000Z" },
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner,
      snapshotDigest: `sha256:${"b".repeat(64)}`, graphRevision: 7, evidenceDigest: "c".repeat(64) } }
}
