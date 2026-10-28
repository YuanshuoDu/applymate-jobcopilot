import { describe, expect, it } from "vitest"
import { parseScheduledTaskGraphPrepareProof, scheduledTaskGraphPrepareProofMatchesAttestation,
  scheduledTaskGraphPrepareReceiptKey, scheduledTaskGraphPrepareResultDigest } from "./scheduled-taskgraph-prepare-proof"

const digest = (char: string) => char.repeat(64)
function proof(scoutCount = 1) {
  const scouts = Array.from({ length: scoutCount }, (_, index) => ({ taskId: `scout-${index + 1}`, attemptCount: 1,
    role: "scout", taskType: "job_discovery", status: "completed", verification: "passed", dependsOnTaskIds: [] }))
  const analyst = { taskId: "analyst", attemptCount: 1, role: "analyst", taskType: "job_analysis",
    status: "completed", verification: "passed", dependsOnTaskIds: scouts.map(node => node.taskId) }
  const result = { schemaVersion: "agent-harness.v2.subagent.result", role: "prepare", status: "completed", taskId: "prepare",
    attemptCount: 1, snapshotDigest: `sha256:${digest("a")}`, checkpointDigest: digest("b"), jobs: [], materials: [] }
  const prepare = { taskId: "prepare", attemptCount: 1, role: "prepare", taskType: "scheduled_application_prepare",
    status: "completed", verification: "passed", dependsOnTaskIds: ["analyst"], tool: "scheduled.application.prepare@1",
    resultDigest: scheduledTaskGraphPrepareResultDigest(result) }
  return { receipt: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1", owner: {},
      continuationKey: `scheduled-taskgraph${scoutCount === 1 ? "" : ":v2"}:sha256:${digest("c")}`,
      snapshotDigest: result.snapshotDigest, evidenceDigest: digest("d"), checkpointDigest: result.checkpointDigest,
      analyzeGraphRevision: 1, prepareScheduleRevision: 2 },
    completion: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-prepare-completion.v1", graphRevision: 3,
      nodes: [...scouts, analyst, prepare], wait: { waitId: "wait-1", status: "ready", mode: "all",
        targetTaskIds: ["prepare"], matchedTaskIds: ["prepare"] } }, result }
}

function attestation(scoutCount = 1) {
  const owner = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", rootAttemptCount: 1,
    turnLeaseOwnerId: "lease", turnLeaseVersion: 1 }
  const sources = Array.from({ length: scoutCount }, (_, index) => {
    const nodeKey = `scout-${index + 1}`, taskId = nodeKey
    const candidateJobIds = ["job-1"]
    const common = { taskId, attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("a") }
    return scoutCount === 1 ? { ...common, candidateJobIds, discoveryReceipt: { status: "complete", taskId, attemptCount: 1,
      completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest("b") } }
      : { nodeKey, ...common, nodeDigest: digest("c"), evidenceDigest: digest("d"), reportDigest: digest("e"), candidateJobIds,
        discoveryReceipt: { status: "complete", taskId, attemptCount: 1, completedCalls: 1, candidateCount: 1,
          providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest("b") } }
  })
  const analystCommon = { taskId: "analyst", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("f"),
    dependsOnTaskIds: sources.map(source => source.taskId), jobIds: ["job-1"] }
  if (scoutCount === 1) return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner,
    snapshotDigest: `sha256:${digest("a")}`, graphRevision: 3, scout: sources[0], analyst: analystCommon, evidenceDigest: digest("b") }
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v2", owner,
    snapshotDigest: `sha256:${digest("a")}`, graphRevision: 3,
    scouts: sources.map(source => ({ ...source, candidateJobIds: [...source.candidateJobIds] })), candidateUnionJobIds: ["job-1"],
    analyst: { nodeKey: "analyst", ...analystCommon, nodeDigest: digest("c"), evidenceDigest: digest("d"), reportDigest: digest("e") },
    evidenceDigest: digest("b") }
}

describe("scheduled TaskGraph Prepare proof parser", () => {
  it("preserves the historical v1 stable Prepare receipt key bytes", () => {
    const owner = { userId: "user-literal", sessionId: "session-literal", turnId: "turn-literal", rootTaskId: "root-literal",
      rootAttemptCount: 7, turnLeaseOwnerId: "lease-literal", turnLeaseVersion: 11, executionId: "execution-literal", executionAttemptCount: 3 }
    const receipt = { continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"a".repeat(64)}`,
      evidenceDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), analyzeGraphRevision: 17, prepareScheduleRevision: 18 }
    const historicalKey = "scheduled-taskgraph:sha256:a53081f799c1c4775c5bec348c5b0fa3e08786b814ab6a8f0eb3891288813e6c"
    expect(scheduledTaskGraphPrepareReceiptKey(owner, receipt)).toBe(historicalKey)
    const versionTwoKey = scheduledTaskGraphPrepareReceiptKey(owner,
      { ...receipt, continuationKey: `scheduled-taskgraph:v2:sha256:${"a".repeat(64)}` })
    expect(versionTwoKey).toMatch(/^scheduled-taskgraph:v2:sha256:[a-f0-9]{64}$/)
    expect(versionTwoKey).not.toBe(historicalKey)
  })
  it("keeps the singleton v1 completion proof shape", () => {
    const parsed = parseScheduledTaskGraphPrepareProof(proof())
    expect(parsed?.nodes.map(node => node.role)).toEqual(["scout", "analyst", "prepare"])
  })
  it("accepts the ordered multi-Scout completion prefix and all-source dependencies", () => {
    const parsed = parseScheduledTaskGraphPrepareProof(proof(3))
    expect(parsed?.nodes.map(node => node.role)).toEqual(["scout", "scout", "scout", "analyst", "prepare"])
  })
  it.each([[1], [2]])("matches a Prepare receipt only to the same attestation key version (source count %i)", scoutCount => {
    const parsed = parseScheduledTaskGraphPrepareProof(proof(scoutCount))!
    expect(scheduledTaskGraphPrepareProofMatchesAttestation(parsed, attestation(scoutCount))).toBe(true)
  })
  it.each([[1, 2], [2, 1]])("rejects a Prepare key version mismatch (%i source(s) with %i-source attestation)", (proofSources, attestedSources) => {
    const parsed = parseScheduledTaskGraphPrepareProof(proof(proofSources))!
    expect(scheduledTaskGraphPrepareProofMatchesAttestation(parsed, attestation(attestedSources))).toBe(false)
  })
  it("rejects a multi-Scout proof that omits one Analyst dependency", () => {
    const value = proof(2)
    ;(value.completion.nodes[2] as { dependsOnTaskIds: string[] }).dependsOnTaskIds = ["scout-1"]
    expect(parseScheduledTaskGraphPrepareProof(value)).toBeNull()
  })
})
