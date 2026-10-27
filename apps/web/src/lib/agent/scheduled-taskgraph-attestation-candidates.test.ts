import { describe, expect, it } from "vitest"
import { parseScheduledPipelineAttestation } from "@jobcopilot/agent-protocol"
import { scheduledTaskGraphAttestationCandidates } from "./scheduled-taskgraph-attestation-candidates"

const digest = (char: string) => char.repeat(64)
const owner = { userId: "u", sessionId: "s", turnId: "t", rootTaskId: "r", rootAttemptCount: 1,
  turnLeaseOwnerId: "lease", turnLeaseVersion: 1 }
const receipt = (taskId: string, candidateCount: number) => ({ status: "complete", taskId, attemptCount: 1,
  completedCalls: 1, candidateCount, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest("f") })
const proof = (nodeKey: string, taskId: string, candidates: string[], c: string) => ({ nodeKey, taskId,
  attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest(c), nodeDigest: digest("a"),
  evidenceDigest: digest("b"), reportDigest: digest("c"), candidateJobIds: candidates,
  discoveryReceipt: receipt(taskId, candidates.length) })

function v1() {
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner,
    snapshotDigest: `sha256:${digest("a")}`, graphRevision: 1,
    scout: { taskId: "s1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("b"),
      candidateJobIds: ["job-a", "job-b"], discoveryReceipt: receipt("s1", 2) },
    analyst: { taskId: "a1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("c"),
      dependsOnTaskIds: ["s1"], jobIds: ["job-b"] }, evidenceDigest: digest("d") }
}

function v2() {
  const first = proof("scout-a", "s1", ["job-a", "job-c"], "1")
  const second = proof("scout-b", "s2", ["job-b", "job-c"], "2")
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v2", owner,
    snapshotDigest: `sha256:${digest("a")}`, graphRevision: 2, scouts: [first, second],
    candidateUnionJobIds: ["job-a", "job-b", "job-c"],
    analyst: { nodeKey: "analyst", taskId: "a1", attemptCount: 1, status: "completed", verification: "passed",
      resultDigest: digest("3"), nodeDigest: digest("4"), evidenceDigest: digest("5"), reportDigest: digest("6"),
      dependsOnTaskIds: ["s1", "s2"], jobIds: ["job-c"] }, evidenceDigest: digest("e") }
}

describe("scheduled TaskGraph candidate selection", () => {
  it("keeps the entire singleton Scout cohort for v1", () => {
    const parsed = parseScheduledPipelineAttestation(v1())
    expect(parsed).not.toBeNull()
    expect(scheduledTaskGraphAttestationCandidates(parsed!)).toEqual({ version: "v1",
      candidateUnionJobIds: ["job-a", "job-b"], selectedJobIds: ["job-a", "job-b"] })
  })

  it("keeps the complete v2 union as proof metadata and selects only the ordered Analyst cohort", () => {
    const parsed = parseScheduledPipelineAttestation(v2())
    expect(parsed).not.toBeNull()
    expect(scheduledTaskGraphAttestationCandidates(parsed!)).toEqual({ version: "v2",
      candidateUnionJobIds: ["job-a", "job-b", "job-c"], selectedJobIds: ["job-c"] })
  })

  it("fails closed on a v2 union that does not exactly match all Scout candidates", () => {
    const value = v2()
    value.candidateUnionJobIds = ["job-c"]
    expect(parseScheduledPipelineAttestation(value)).toBeNull()
  })
})
