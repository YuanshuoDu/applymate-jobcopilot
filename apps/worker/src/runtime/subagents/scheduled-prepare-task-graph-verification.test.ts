import { describe, expect, it, vi } from "vitest"
import {
  buildScheduledPrepareTaskGraphProof,
  SCHEDULED_PREPARE_COMPLETION_SCHEMA,
  SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
  scheduledPrepareResultDigest,
  verifyScheduledPrepareTaskGraphEvidence,
} from "./scheduled-prepare-task-graph-verification.js"
import { buildScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { ROLE_RESULT_SCHEMA, type PrepareResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"

const binding = {
  owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
    turnLeaseOwnerId: "turn-owner-1", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 1 },
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 12, prepareScheduleRevision: 13,
}
const receipt = buildScheduledTaskGraphContinuationReceipt({ ...binding, continuationKey: scheduledTaskGraphStableContinuationKey(binding) })!
const result: PrepareResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-1", attemptCount: 3,
  snapshotDigest: binding.snapshotDigest, checkpointDigest: binding.checkpointDigest, jobs: [], materials: [] }
const completion = {
  schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 14,
  nodes: [
    { taskId: "scout-1", attemptCount: 1, role: "scout", taskType: TASK_GRAPH_TEMPLATES.scout.taskType, status: "completed", verification: "passed", dependsOnTaskIds: [] },
    { taskId: "analyst-1", attemptCount: 2, role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, status: "completed", verification: "passed", dependsOnTaskIds: ["scout-1"] },
    { taskId: result.taskId, attemptCount: result.attemptCount, role: "prepare", taskType: TASK_GRAPH_TEMPLATES.prepare.taskType,
      status: "completed", verification: "passed", dependsOnTaskIds: ["analyst-1"], tool: "scheduled.application.prepare@1", resultDigest: scheduledPrepareResultDigest(result) },
  ],
}
const facts = { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt, completion, result }
const wait = { waitId: "wait-1", status: "ready", mode: "all", targetTaskIds: [result.taskId], matchedTaskIds: [result.taskId] }

describe("scheduled Prepare TaskGraph proof", () => {
  it("builds a proof only when completion is bound to the stable receipt and exact ready dependency wait", () => {
    expect(buildScheduledPrepareTaskGraphProof(facts, wait)).toEqual({ receipt, completion: { ...completion, wait }, result })
    expect(buildScheduledPrepareTaskGraphProof(facts, { ...wait, matchedTaskIds: ["other-task"] })).toBeNull()
    expect(buildScheduledPrepareTaskGraphProof(facts, { ...wait, status: "waiting" })).toBeNull()
    expect(buildScheduledPrepareTaskGraphProof({ ...facts, completion: { ...completion, graphRevision: 13 } }, wait)).toBeNull()
    expect(buildScheduledPrepareTaskGraphProof({ ...facts, result: { ...result, snapshotDigest: `sha256:${"e".repeat(64)}` } }, wait)).toBeNull()
  })

  it("fails closed on mismatched Prepare task and attempt identity before database reads", async () => {
    const query = vi.fn()
    const verification = await verifyScheduledPrepareTaskGraphEvidence({ query } as never, {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "prepare-1", attemptCount: 3 },
      snapshot: {} as never, current: {} as never, tasks: new Map(),
      structuredResult: { ...result, taskId: "other-task" }, completionGraphRevision: 14,
    })
    expect(verification).toEqual({ verified: false, reasonCode: "scheduled_prepare_result_invalid" })
    expect(query).not.toHaveBeenCalled()
  })

  it("starts persisted verification only after the Prepare task and graph node complete", async () => {
    const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
    ] }
    const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
      { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
    ] }
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { key: "scout", templateId: "scout", taskId: "scout-1", goal: "Find jobs", successCriteria: ["Find matching jobs"],
        dependsOn: [], depth: 1, verificationDisposition: "typed", verification: scoutVerification },
      { key: "analyst", templateId: "analyst", taskId: "analyst-1", goal: "Analyze jobs", successCriteria: ["Score jobs"],
        dependsOn: ["scout"], depth: 2, verificationDisposition: "typed", verification: analystVerification },
      { key: "prepare", templateId: "prepare", taskId: "prepare-1", goal: "Prepare materials", successCriteria: ["Persist materials"],
        dependsOn: ["analyst"], depth: 3, verificationDisposition: "specialized" },
    ] }
    const current = { revision: 13, nodes: snapshot.nodes.map(node => ({ ...node, status: "completed", readiness: "ready",
      resultSummary: null, failureReason: null })) }
    const task = (id: string, role: "scout" | "analyst" | "prepare") => ({ id, role: TASK_GRAPH_TEMPLATES[role].role,
      taskType: TASK_GRAPH_TEMPLATES[role].taskType, status: "completed", failureReason: null, attemptCount: 1,
      expectedOutputSchema: TASK_GRAPH_TEMPLATES[role].expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES[role].allowedActions })
    const tasks = new Map([task("scout-1", "scout"), task("analyst-1", "analyst"), task("prepare-1", "prepare")].map(value => [value.id, value]))
    const query = vi.fn(async () => ({ rows: [] }))
    const completed = await verifyScheduledPrepareTaskGraphEvidence({ query } as never, {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "prepare-1", attemptCount: 1 },
      snapshot: snapshot as never, current: current as never, tasks: tasks as never, structuredResult: { ...result, attemptCount: 1 }, completionGraphRevision: 13,
    })
    expect(completed).toEqual({ verified: false, reasonCode: "scheduled_prepare_receipt_invalid" })
    expect(query).toHaveBeenCalledOnce()

    query.mockClear()
    const running = { ...current, nodes: current.nodes.map(node => node.key === "prepare" ? { ...node, status: "running" } : node) }
    const runningTasks = new Map(tasks)
    runningTasks.set("prepare-1", { ...tasks.get("prepare-1")!, status: "running" })
    const incomplete = await verifyScheduledPrepareTaskGraphEvidence({ query } as never, {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "prepare-1", attemptCount: 1 },
      snapshot: snapshot as never, current: running as never, tasks: runningTasks as never, structuredResult: { ...result, attemptCount: 1 }, completionGraphRevision: 13,
    })
    expect(incomplete).toEqual({ verified: false, reasonCode: "scheduled_prepare_graph_invalid" })
    expect(query).not.toHaveBeenCalled()

    const failed = { ...current, nodes: current.nodes.map(node => node.key === "prepare" ? { ...node, status: "failed", failureReason: "prepare_failed" } : node) }
    const failedTasks = new Map<string, unknown>(tasks)
    failedTasks.set("prepare-1", { ...tasks.get("prepare-1")!, status: "failed", failureReason: "prepare_failed" })
    const rejectedFailure = await verifyScheduledPrepareTaskGraphEvidence({ query } as never, {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "prepare-1", attemptCount: 1 },
      snapshot: snapshot as never, current: failed as never, tasks: failedTasks as never, structuredResult: { ...result, attemptCount: 1 }, completionGraphRevision: 13,
    })
    expect(rejectedFailure).toEqual({ verified: false, reasonCode: "scheduled_prepare_graph_invalid" })
    expect(query).not.toHaveBeenCalled()
  })
})
