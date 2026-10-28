import { describe, expect, it } from "vitest"
import { parseScheduledPipelineAttestation } from "@jobcopilot/agent-protocol"
import { scheduledAnalyzeGraphMatches } from "./scheduled-analyze-graph-proof.js"
import type { TaskGraphScheduledPrepareInput, TaskGraphCurrentState } from "./task-graph-command-port.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"

const digest = (value: string) => value.repeat(64)
const attestation = parseScheduledPipelineAttestation({ schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v2",
  owner: { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", rootAttemptCount: 1, turnLeaseOwnerId: "lease", turnLeaseVersion: 1 },
  snapshotDigest: `sha256:${digest("a")}`, graphRevision: 3,
  scouts: ["a", "b"].map(key => ({ nodeKey: `scout-${key}`, taskId: `task-${key}`, attemptCount: 1, status: "completed", verification: "passed",
    resultDigest: digest("b"), nodeDigest: digest("c"), evidenceDigest: digest("d"), reportDigest: digest("e"), candidateJobIds: [`job-${key}`],
    discoveryReceipt: { status: "complete", taskId: `task-${key}`, attemptCount: 1, completedCalls: 1, candidateCount: 1,
      providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest("f") } })),
  candidateUnionJobIds: ["job-a", "job-b"], analyst: { nodeKey: "analyst", taskId: "analyst-task", attemptCount: 1,
    status: "completed", verification: "passed", resultDigest: digest("1"), nodeDigest: digest("2"), evidenceDigest: digest("3"),
    reportDigest: digest("4"), dependsOnTaskIds: ["task-a", "task-b"], jobIds: ["job-a"] }, evidenceDigest: digest("5") })

describe("scheduled Analyze persisted proof reconstruction", () => {
  it("rejects a current multi-source graph whose proof task rows are missing", () => {
    if (!attestation || attestation.schemaVersion.endsWith(".v1")) throw new Error("v2 fixture rejected")
    const snapshot = { schemaVersion: "agent-harness.v2.task-graph", nodes: [
      { key: "scout-a", templateId: "scout", depth: 1, taskId: "task-a", goal: "Discover", successCriteria: ["Jobs"], dependsOn: [] },
      { key: "scout-b", templateId: "scout", depth: 1, taskId: "task-b", goal: "Discover", successCriteria: ["Jobs"], dependsOn: [] },
      { key: "analyst", templateId: "analyst", depth: 2, taskId: "analyst-task", goal: "Analyze", successCriteria: ["Findings"], dependsOn: ["scout-b", "scout-a"] },
    ] } as unknown as TaskGraphSnapshot
    const input = { attestation } as unknown as TaskGraphScheduledPrepareInput
    const current = { revision: 3, nodes: [{}, {}, {}] } as unknown as TaskGraphCurrentState
    expect(scheduledAnalyzeGraphMatches(input, snapshot, current, new Map(), false)).toBeNull()
  })
})
