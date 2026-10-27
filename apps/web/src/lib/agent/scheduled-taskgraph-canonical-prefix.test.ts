import { describe, expect, it } from "vitest"
import { projectScheduledTaskGraphCanonicalPrefix, sameScheduledTaskGraphCanonicalPrefix } from "./scheduled-taskgraph-canonical-prefix"

const digest = (char: string) => char.repeat(64)
const owner = { userId: "u", sessionId: "s", turnId: "t", rootTaskId: "r", rootAttemptCount: 1,
  turnLeaseOwnerId: "lease", turnLeaseVersion: 1 }
function multiAttestation() {
  const scouts = ["a", "b"].map((suffix, index) => ({ nodeKey: `source-${suffix}`, taskId: `scout-${suffix}`, attemptCount: 1,
    status: "completed", verification: "passed", resultDigest: digest(String(index + 1)), nodeDigest: digest("a"),
    evidenceDigest: digest("b"), reportDigest: digest("c"), candidateJobIds: [`job-${suffix}`],
    discoveryReceipt: { status: "complete", taskId: `scout-${suffix}`, attemptCount: 1, completedCalls: 1,
      candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest("d") } }))
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v2", owner, snapshotDigest: `sha256:${digest("a")}`,
    graphRevision: 1, scouts, candidateUnionJobIds: ["job-a", "job-b"], analyst: { nodeKey: "analysis", taskId: "analyst",
      attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("e"), nodeDigest: digest("f"),
      evidenceDigest: digest("1"), reportDigest: digest("2"), dependsOnTaskIds: ["scout-a", "scout-b"], jobIds: ["job-a"] },
    evidenceDigest: digest("3") }
}
const node = (key: string, templateId: string, taskId: string, depth: number, dependsOn: string[], verificationDisposition: string) =>
  ({ key, templateId, taskId, depth, dependsOn, verificationDisposition })
function graph() {
  return { schemaVersion: "agent-harness.v2.task-graph", nodes: [
    node("source-b", "scout", "scout-b", 1, [], "typed"), node("source-a", "scout", "scout-a", 1, [], "typed"),
    node("analysis", "analyst", "analyst", 2, ["source-a", "source-b"], "typed"),
    node("prepare", "prepare", "prepare", 3, ["analysis"], "specialized"),
    node("gate", "gate", "gate", 4, ["prepare"], "specialized"),
    node("scheduled_audit", "scheduled_audit", "audit", 5, ["gate"], "specialized"),
  ] }
}

describe("scheduled TaskGraph canonical prefix projection", () => {
  it("projects authored-order Scouts, all-source Analyst and typed stage suffixes", () => {
    const projected = projectScheduledTaskGraphCanonicalPrefix(graph(), multiAttestation(), "audit")
    expect(projected?.scouts.map(source => source.taskId)).toEqual(["scout-b", "scout-a"])
    expect(projected).toMatchObject({ analyst: { taskId: "analyst" }, prepare: { taskId: "prepare" },
      gate: { taskId: "gate" }, audit: { taskId: "audit" } })
  })

  it("rejects a missing source, wrong dependency set or unsupported stage length", () => {
    const current = graph()
    expect(projectScheduledTaskGraphCanonicalPrefix({ ...current, nodes: current.nodes.slice(1) }, multiAttestation(), "audit")).toBeNull()
    expect(projectScheduledTaskGraphCanonicalPrefix({ ...current, nodes: current.nodes.map((item, index) => index === 2 ? { ...item, dependsOn: ["source-a"] } : item) }, multiAttestation(), "audit")).toBeNull()
    expect(projectScheduledTaskGraphCanonicalPrefix({ ...current, nodes: current.nodes.slice(0, 5) }, multiAttestation(), "audit")).toBeNull()
  })

  it("compares a persisted prefix against a later append without losing graph metadata", () => {
    const full = graph(), prepared = { ...full, nodes: full.nodes.slice(0, 4) }
    expect(sameScheduledTaskGraphCanonicalPrefix(prepared, full, 4)).toBe(true)
    expect(sameScheduledTaskGraphCanonicalPrefix({ ...prepared, revision: 2 }, full, 4)).toBe(false)
  })
})
