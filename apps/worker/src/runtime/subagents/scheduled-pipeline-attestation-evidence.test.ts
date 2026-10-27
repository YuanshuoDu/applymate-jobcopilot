import { describe, expect, it, vi } from "vitest"
import { parseScheduledPipelineAttestation, type ScheduledPipelineScoutProofV2 } from "@jobcopilot/agent-protocol"
import { buildScheduledPipelineAttestationEvidence, projectScheduledPipelineV2Attestation } from "./scheduled-pipeline-attestation-evidence.js"
import type { ScheduledPipelineNodeEvidence } from "./scheduled-pipeline-node-evidence.js"

const hex = (character: string) => character.repeat(64)

describe("scheduled Analyze attestation evidence", () => {
  it("rejects an empty source set before consulting persisted receipt providers", async () => {
    const verifyCompletedNode = vi.fn()
    const result = await buildScheduledPipelineAttestationEvidence({ dependencies: { verifyCompletedNode } as never,
      scope: {} as never, schedule: {} as never, prefix: {} as never, graph: [] })
    expect(result).toEqual({ status: "blocked", reasonCode: "task_graph_node_invalid" })
    expect(verifyCompletedNode).not.toHaveBeenCalled()
  })

  it("rejects more sources than the scheduled full-pipeline slot budget", async () => {
    const graph = Array.from({ length: 5 }, () => ({ node: { templateId: "scout" } } as unknown as ScheduledPipelineNodeEvidence))
    const result = await buildScheduledPipelineAttestationEvidence({ dependencies: {} as never, scope: {} as never,
      schedule: {} as never, prefix: {} as never, graph })
    expect(result).toEqual({ status: "blocked", reasonCode: "task_graph_node_invalid" })
  })

  it("roundtrips mixed-case Scout keys in protocol codepoint order while preserving result order", () => {
    const scout = (nodeKey: string, taskId: string, candidateJobIds: readonly string[]): ScheduledPipelineScoutProofV2 => ({
      nodeKey, taskId, attemptCount: 1, status: "completed", verification: "passed", resultDigest: hex("a"),
      nodeDigest: hex("b"), evidenceDigest: hex("c"), reportDigest: hex("d"), candidateJobIds,
      discoveryReceipt: { status: "complete", taskId, attemptCount: 1, completedCalls: 1, candidateCount: candidateJobIds.length,
        providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: hex("e") },
    })
    const scouts = [scout("scout-a", "task-a", ["job-z", "job-a"]), scout("scout-A", "task-A", ["job-A"])]
    const bindings = ["scout-A", "scout-a"].map((nodeKey, index) => ({ nodeKey, taskId: index === 0 ? "task-A" : "task-a",
      attemptCount: 1, nodeDigest: hex("b"), resultDigest: hex("a"), evidenceDigest: hex("c"), reportDigest: hex("d") }))
    const attestation = projectScheduledPipelineV2Attestation({
      owner: { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", rootAttemptCount: 1,
        turnLeaseOwnerId: "lease", turnLeaseVersion: 1 },
      snapshotDigest: `sha256:${hex("f")}`, graphDigest: hex("9"), graphRevision: 4, scouts,
      analyst: { nodeKey: "analyst", taskId: "analyst-task", attemptCount: 1, status: "completed", verification: "passed",
        resultDigest: hex("6"), nodeDigest: hex("7"), evidenceDigest: hex("8"), reportDigest: hex("5"), jobIds: ["job-z", "job-A"] },
      bindings,
    })
    const parsed = parseScheduledPipelineAttestation(attestation)
    expect(parsed).not.toBeNull()
    expect(parsed?.schemaVersion).toBe("agent-harness.v2.scheduled-pipeline-attestation.v2")
    if (!parsed || !("scouts" in parsed)) throw new Error("V2 producer output did not parse")
    expect(parsed.scouts.map(source => source.nodeKey)).toEqual(["scout-A", "scout-a"])
    expect(parsed.scouts.find(source => source.nodeKey === "scout-a")?.candidateJobIds).toEqual(["job-z", "job-a"])
    expect(parsed.candidateUnionJobIds).toEqual(["job-A", "job-a", "job-z"])
    expect(parsed.analyst.dependsOnTaskIds).toEqual(["task-A", "task-a"])
    expect(parsed.analyst.jobIds).toEqual(["job-z", "job-A"])
  })
})
