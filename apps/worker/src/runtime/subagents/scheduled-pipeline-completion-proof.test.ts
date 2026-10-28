import { describe, expect, it } from "vitest"
import { parseScheduledPipelineAttestation } from "@jobcopilot/agent-protocol"
import { parseScheduledPipelinePrepareContinuationResult } from "./scheduled-pipeline-completion-proof.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { buildScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { SCHEDULED_PREPARE_COMPLETION_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import type { ScheduledPipelineAnalyzeCheckpointProof } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"

const digest = (value: string) => value.repeat(64)
const owner: ScheduledAutomationPipelineBridgeScope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root",
  rootAttemptCount: 2, turnLeaseOwnerId: "lease", turnLeaseVersion: 3 }

function fixture() {
  const snapshotDigest = `sha256:${digest("a")}`, evidenceDigest = digest("b"), checkpointDigest = digest("c")
  const receipt = (taskId: string, candidateCount: number) => ({ status: "complete", taskId, attemptCount: 1, completedCalls: 1,
    candidateCount, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest("d") })
  const input = { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v2", owner, snapshotDigest, graphRevision: 10,
    scouts: ["a", "b"].map(key => ({ nodeKey: `scout-${key}`, taskId: `task-${key}`, attemptCount: 1, status: "completed", verification: "passed",
      resultDigest: digest("e"), nodeDigest: digest("f"), evidenceDigest: digest("1"), reportDigest: digest("2"), candidateJobIds: [`job-${key}`],
      discoveryReceipt: receipt(`task-${key}`, 1) })), candidateUnionJobIds: ["job-a", "job-b"],
    analyst: { nodeKey: "analyst", taskId: "analyst-task", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest("3"),
      nodeDigest: digest("4"), evidenceDigest: digest("5"), reportDigest: digest("6"), dependsOnTaskIds: ["task-a", "task-b"], jobIds: ["job-a"] }, evidenceDigest }
  const attestation = parseScheduledPipelineAttestation(input)
  if (!attestation || attestation.schemaVersion.endsWith(".v1")) throw new Error("v2 fixture rejected")
  const execution = { executionId: "execution", executionAttemptCount: 1 }
  const continuationKey = scheduledTaskGraphContinuationKey(owner, attestation, execution.executionId, execution.executionAttemptCount)
  const binding = { owner: { ...owner, ...execution }, continuationKey, snapshotDigest, evidenceDigest, checkpointDigest,
    analyzeGraphRevision: 10, prepareScheduleRevision: 11 }
  const stableKey = scheduledTaskGraphStableContinuationKey(binding)
  if (!stableKey) throw new Error("stable key missing")
  const receiptValue = buildScheduledTaskGraphContinuationReceipt({ ...binding, continuationKey: stableKey })
  if (!receiptValue) throw new Error("receipt rejected")
  const handoff: ScheduledPipelineAnalyzeCheckpointProof = { status: "analyze_checkpointed", continuationKey, checkpointDigest,
    claimTokenDigest: `sha256:${digest("7")}`, ...execution }
  const nodes = [
    { taskId: "task-b", attemptCount: 1, role: "scout", taskType: TASK_GRAPH_TEMPLATES.scout.taskType, status: "completed", verification: "passed", dependsOnTaskIds: [] },
    { taskId: "task-a", attemptCount: 1, role: "scout", taskType: TASK_GRAPH_TEMPLATES.scout.taskType, status: "completed", verification: "passed", dependsOnTaskIds: [] },
    { taskId: "analyst-task", attemptCount: 1, role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, status: "completed", verification: "passed", dependsOnTaskIds: ["task-a", "task-b"] },
    { taskId: "prepare-task", attemptCount: 1, role: "prepare", taskType: TASK_GRAPH_TEMPLATES.prepare.taskType, status: "completed", verification: "passed", dependsOnTaskIds: ["analyst-task"] },
  ]
  const value = { status: "ready", prepareProof: { receipt: receiptValue, result: {}, completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA,
    graphRevision: 12, nodes, wait: { status: "ready", mode: "all", waitId: "wait", targetTaskIds: ["prepare-task"], matchedTaskIds: ["prepare-task"] } } },
    choice: { required: false } }
  return { value, attestation, handoff }
}

describe("scheduled Prepare continuation proof parsing", () => {
  it("accepts a v2 completion proof with every Scout in authored order", () => {
    const input = fixture()
    expect(parseScheduledPipelinePrepareContinuationResult(input.value, owner, input.attestation, input.handoff, "step", 4))
      .toMatchObject({ status: "ready", choice: { required: false } })
  })

  it("rejects missing, foreign, duplicate, or misbound source completion rows", () => {
    const input = fixture(), base = input.value
    const nodes = base.prepareProof.completion.nodes
    for (const changed of [
      nodes.slice(1),
      [{ ...nodes[0], taskId: "foreign" }, ...nodes.slice(1)],
      [{ ...nodes[0] }, { ...nodes[0] }, ...nodes.slice(2)],
      [nodes[0], nodes[1], { ...nodes[2], dependsOnTaskIds: ["task-a"] }, nodes[3]],
    ]) {
      const value = { ...base, prepareProof: { ...base.prepareProof, completion: { ...base.prepareProof.completion, nodes: changed } } }
      expect(parseScheduledPipelinePrepareContinuationResult(value, owner, input.attestation, input.handoff, "step", 4)).toBeNull()
    }
  })
})
