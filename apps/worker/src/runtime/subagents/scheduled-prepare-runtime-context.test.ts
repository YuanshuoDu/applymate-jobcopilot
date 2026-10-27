import { describe, expect, it } from "vitest"
import { scheduledPrepareAnalyzeSnapshot, scheduledPrepareCheckpointDigest, scheduledPrepareCohortJobIds } from "./scheduled-prepare-runtime-context.js"
import { SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA, SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA,
  type ScheduledPipelineAttestationV1, type ScheduledPipelineAttestationV2 } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"

function graph(count: number): TaskGraphSnapshot {
  const scouts = Array.from({ length: count }, (_, i) => ({ key: `s${i}`, templateId: "scout", depth: 1, dependsOn: [],
    taskId: `t-s${i}`, goal: "Find", successCriteria: ["Found"], verificationDisposition: "typed" as const,
    verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout", criteria: [] } }))
  const nodes = [...scouts, { key: "analyst", templateId: "analyst", depth: 2, dependsOn: scouts.map(node => node.key), taskId: "t-a",
    goal: "Analyze", successCriteria: ["Analyzed"], verificationDisposition: "typed" as const,
    verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "analyst", criteria: [] } },
    { key: "prepare", templateId: "prepare", depth: 3, dependsOn: ["analyst"], taskId: "t-p", goal: "Prepare", successCriteria: ["Prepared"], verificationDisposition: "specialized" as const }]
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes } as unknown as TaskGraphSnapshot
}

describe("scheduled Prepare runtime context", () => {
  it.each([1, 2, 4])("projects the %i-Scout Analyze prefix and excludes Prepare", count => {
    const prefix = scheduledPrepareAnalyzeSnapshot(graph(count))
    expect(prefix.nodes.map(node => node.templateId)).toEqual([...Array(count).fill("scout"), "analyst"])
  })
  it("recomputes checkpoint identity from the existing owner and selected rows", () => {
    const owner = { userId: "u", sessionId: "s", turnId: "t", rootTaskId: "r", rootAttemptCount: 1,
      turnLeaseOwnerId: "lease", turnLeaseVersion: 1, executionId: "e", executionAttemptCount: 1 }
    const receipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1", owner,
      continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: "b".repeat(64),
      evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 2, prepareScheduleRevision: 3 } as ScheduledTaskGraphContinuationReceipt
    const marker = { owner, key: receipt.continuationKey, snapshotDigest: receipt.snapshotDigest, graphRevision: 2, evidenceDigest: receipt.evidenceDigest }
    const state = { nextStage: "prepare", scheduledTaskGraphContinuation: marker, analysisFailed: 0,
      scoutedJobs: [{ id: "j1", userId: "u" }], scoredJobs: [{ job: { id: "j1", userId: "u" }, score: 80,
        matchedKeywords: [], missingKeywords: [], recommendation: "" }] }
    expect(scheduledPrepareCheckpointDigest(state, receipt, receipt.continuationKey, ["j1"])).toMatch(/^[a-f0-9]{64}$/)
    expect(scheduledPrepareCheckpointDigest(state, receipt, "other", ["j1"])).toBeNull()
    expect(scheduledPrepareCheckpointDigest({ ...state, scoutedJobs: [...state.scoutedJobs, { id: "j2", userId: "u" }], analysisFailed: 1 },
      receipt, receipt.continuationKey, ["j1"])).toBeNull()
    expect(scheduledPrepareCheckpointDigest({ ...state, scoredJobs: [{ ...state.scoredJobs[0]!, job: { id: "j2", userId: "u" } }] },
      receipt, receipt.continuationKey, ["j1"])).toBeNull()
  })
  it("keeps v1's Scout cohort and uses only selected Analyst IDs for v2", () => {
    const owner = { userId: "u", sessionId: "s", turnId: "t", rootTaskId: "r", rootAttemptCount: 1,
      turnLeaseOwnerId: "lease", turnLeaseVersion: 1 }
    const discoveryReceipt = { status: "complete" as const, taskId: "scout-1", attemptCount: 1, completedCalls: 1,
      candidateCount: 2, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: "f".repeat(64) }
    const v1: ScheduledPipelineAttestationV1 = { schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA, owner,
      snapshotDigest: `sha256:${"a".repeat(64)}`, graphRevision: 2, evidenceDigest: "b".repeat(64),
      scout: { taskId: "scout-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: "c".repeat(64),
        candidateJobIds: ["a", "b"], discoveryReceipt },
      analyst: { taskId: "analyst-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: "d".repeat(64),
        dependsOnTaskIds: ["scout-1"], jobIds: ["b"] } }
    const sources = ["scout-1", "scout-2"].map((taskId, index) => ({ nodeKey: `scout-${index + 1}`, taskId,
      attemptCount: 1, status: "completed" as const, verification: "passed" as const, resultDigest: "c".repeat(64),
      nodeDigest: "d".repeat(64), evidenceDigest: "e".repeat(64), reportDigest: "f".repeat(64),
      candidateJobIds: index === 0 ? ["a", "b"] : ["b", "c"],
      discoveryReceipt: { ...discoveryReceipt, taskId, candidateCount: 2 } }))
    const v2: ScheduledPipelineAttestationV2 = { schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA, owner,
      snapshotDigest: `sha256:${"a".repeat(64)}`, graphRevision: 2, evidenceDigest: "b".repeat(64), scouts: sources,
      candidateUnionJobIds: ["a", "b", "c"], analyst: { nodeKey: "analyst", taskId: "analyst-1", attemptCount: 1,
        status: "completed", verification: "passed", resultDigest: "c".repeat(64), nodeDigest: "d".repeat(64),
        evidenceDigest: "e".repeat(64), reportDigest: "f".repeat(64), dependsOnTaskIds: ["scout-1", "scout-2"], jobIds: ["c"] } }
    expect([...scheduledPrepareCohortJobIds(v1)]).toEqual(["a", "b"])
    expect([...scheduledPrepareCohortJobIds(v2)]).toEqual(["c"])
  })
})
