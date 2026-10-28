import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { projectScheduledTaskGraphCanonicalPrefix, sameScheduledTaskGraphCanonicalPrefix,
  scheduledTaskGraphVerificationReportMatches } from "./scheduled-taskgraph-canonical-prefix"

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
function legacyAttestation() {
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner, snapshotDigest: `sha256:${digest("a")}`,
    graphRevision: 1, scout: { taskId: "scout-task", attemptCount: 1, status: "completed", verification: "passed",
      resultDigest: digest("b"), candidateJobIds: ["job-a"], discoveryReceipt: { status: "complete", taskId: "scout-task",
        attemptCount: 1, completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest("c") } },
    analyst: { taskId: "analyst-task", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("d"),
      dependsOnTaskIds: ["scout-task"], jobIds: ["job-a"] }, evidenceDigest: digest("e") }
}
function legacyGraph() {
  return { schemaVersion: "agent-harness.v2.task-graph", nodes: [
    node("scheduled-scout", "scout", "scout-task", 1, [], "typed"),
    node("scheduled-analyst", "analyst", "analyst-task", 2, ["scheduled-scout"], "typed"),
    node("prepare", "prepare", "prepare-task", 3, ["scheduled-analyst"], "specialized"),
    node("gate", "gate", "gate-task", 4, ["prepare"], "specialized"),
  ] }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  return value
}

function reportDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")
}

function publicReport() {
  return { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "source-match", status: "passed", reasonCode: "criteria_met" }],
    evidenceDigest: digest("1"), resultDigest: digest("2") }
}

describe("scheduled TaskGraph canonical prefix projection", () => {
  it("projects authored-order Scouts, all-source Analyst and typed stage suffixes", () => {
    const projected = projectScheduledTaskGraphCanonicalPrefix(graph(), multiAttestation(), "audit")
    expect(projected?.scouts.map(source => source.taskId)).toEqual(["scout-b", "scout-a"])
    expect(projected).toMatchObject({ analyst: { taskId: "analyst" }, prepare: { taskId: "prepare" },
      gate: { taskId: "gate" }, audit: { taskId: "audit" } })
  })

  it("binds v1 Scout and Analyst aliases by their attested task IDs", () => {
    const current = legacyGraph(), attestation = legacyAttestation()
    expect(projectScheduledTaskGraphCanonicalPrefix(current, attestation, "gate")).toMatchObject({
      scouts: [{ key: "scheduled-scout", taskId: "scout-task" }],
      analyst: { key: "scheduled-analyst", taskId: "analyst-task" },
    })
    const wrongTask = legacyGraph()
    wrongTask.nodes[0] = { ...wrongTask.nodes[0]!, taskId: "other-scout" }
    expect(projectScheduledTaskGraphCanonicalPrefix(wrongTask, attestation, "gate")).toBeNull()
    const wrongDependency = legacyGraph()
    wrongDependency.nodes[1] = { ...wrongDependency.nodes[1]!, dependsOn: ["other-scout"] }
    expect(projectScheduledTaskGraphCanonicalPrefix(wrongDependency, attestation, "gate")).toBeNull()
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

  it("checks a V2 report digest over the six public fields while accepting the stored evidence envelope", () => {
    const report = publicReport(), attestation = { ...report, reportDigest: reportDigest(report) }
    const stored = { ...report, dependencyBindings: ["a", "b", "c", "d"].map((suffix, index) => ({ nodeKey: `source-${suffix}`,
      taskId: `scout-task-${suffix}`, attemptCount: 1, nodeDigest: digest(String(index + 3)), resultDigest: digest("2"),
      evidenceDigest: digest("1"), reportDigest: digest("4") })) }
    const verificationNode = { templateId: "analyst", verification: { role: "analyst", criteria: [{ id: "source-match" }] } }

    expect(scheduledTaskGraphVerificationReportMatches(stored, verificationNode, attestation)).toBe(true)
    const tamperedPublic = { ...stored, evidenceDigest: digest("5") }
    expect(scheduledTaskGraphVerificationReportMatches(tamperedPublic, verificationNode,
      { ...attestation, evidenceDigest: tamperedPublic.evidenceDigest })).toBe(false)
  })

  it("keeps the V1 report path compatible when no report digest is declared", () => {
    const report = publicReport(), verificationNode = { templateId: "analyst", verification: { role: "analyst", criteria: [{ id: "source-match" }] } }
    expect(scheduledTaskGraphVerificationReportMatches(report, verificationNode,
      { resultDigest: report.resultDigest, evidenceDigest: report.evidenceDigest })).toBe(true)
  })
})
