import { describe, expect, it } from "vitest"
import {
  SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE,
  SCHEDULED_GATE_TASK_TYPE,
  SCHEDULED_GATE_TEMPLATE_ID,
  scheduledGateProposal,
  type ScheduledGateQuestion,
  parseScheduledGateChoice,
  parseScheduledGateResult,
  parseScheduledGateTaskEnvelope,
  scheduledGateCheckpointEvidence,
  scheduledGateCandidateSetDigest,
  scheduledGatePreparedJobIds,
  scheduledGatePreparedJobIdsFromResult,
} from "./scheduled-gate-contract.js"
import { buildScheduledPrepareTaskGraphProof, SCHEDULED_PREPARE_COMPLETION_SCHEMA,
  SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, scheduledPrepareResultDigest } from "./scheduled-prepare-task-graph-verification.js"
import { buildScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { ROLE_RESULT_SCHEMA, type PrepareResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"

const jobIds = ["job-a", "job-b"]
const question: ScheduledGateQuestion = {
  status: "question_required",
  kind: "weak_cover_letter",
  jobIds: ["job-a"],
  candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-a"]),
  allowedChoiceIds: ["continue", "review", "skip"],
}
const waitingEnvelope = {
  finalItemId: null, finalText: "", status: "waiting_for_user", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: question,
}

function prepareProofFor(jobs: PrepareResult["jobs"]): ScheduledPrepareTaskGraphProof {
  const binding = {
    owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 1,
      turnLeaseOwnerId: "turn-owner-1", turnLeaseVersion: 2, executionId: "execution-1", executionAttemptCount: 1 },
    continuationKey: `scheduled-taskgraph:sha256:${"0".repeat(64)}`,
    snapshotDigest: `sha256:${"a".repeat(64)}`, evidenceDigest: "b".repeat(64), checkpointDigest: "c".repeat(64),
    analyzeGraphRevision: 2, prepareScheduleRevision: 3,
  }
  const receipt = buildScheduledTaskGraphContinuationReceipt({ ...binding,
    continuationKey: scheduledTaskGraphStableContinuationKey(binding) })
  if (!receipt) throw new Error("test_receipt_invalid")
  const result: PrepareResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-1",
    attemptCount: 1, snapshotDigest: binding.snapshotDigest, checkpointDigest: binding.checkpointDigest, jobs,
    materials: jobs.filter(job => job.status === "prepared").map((job, index) => ({ jobId: job.jobId, kind: "resume" as const,
      artifactRef: { artifactId: `artifact-${index}`, version: 1, contentHash: `sha256:${"d".repeat(64)}`,
        sourceDigest: `sha256:${"e".repeat(64)}` } })) }
  const completion = { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 4, nodes: [
    { taskId: "scout-1", attemptCount: 1, role: "scout" as const, taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
      status: "completed" as const, verification: "passed" as const, dependsOnTaskIds: [] },
    { taskId: "analyst-1", attemptCount: 1, role: "analyst" as const, taskType: TASK_GRAPH_TEMPLATES.analyst.taskType,
      status: "completed" as const, verification: "passed" as const, dependsOnTaskIds: ["scout-1"] },
    { taskId: result.taskId, attemptCount: result.attemptCount, role: "prepare" as const, taskType: TASK_GRAPH_TEMPLATES.prepare.taskType,
      status: "completed" as const, verification: "passed" as const, dependsOnTaskIds: ["analyst-1"],
      tool: "scheduled.application.prepare@1" as const, resultDigest: scheduledPrepareResultDigest(result) },
  ] as const }
  const proof = buildScheduledPrepareTaskGraphProof({ schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt, completion, result },
    { waitId: "wait-prepare", status: "ready", mode: "all", targetTaskIds: [result.taskId], matchedTaskIds: [result.taskId] })
  if (!proof) throw new Error("test_prepare_proof_invalid")
  return proof
}

describe("scheduled Gate public contract", () => {
  it("pins a non-model Gate identity to the existing Prepare role", () => {
    expect([SCHEDULED_GATE_TEMPLATE_ID, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE]).toEqual([
      "gate", "prepare", "scheduled_taskgraph_gate",
    ])
    expect(SCHEDULED_GATE_OUTPUT_SCHEMA).toEqual({
      schemaVersion: "agent-harness.v2.subagent.result",
      role: "prepare",
      taskType: "scheduled_taskgraph_gate",
    })
    expect(scheduledGateProposal(17)).toEqual({ expectedRevision: 17, nodes: [{
      key: "gate", templateId: "gate", dependsOn: ["prepare"],
      goal: "Review the exact server-prepared applications and return the fixed pending or skip decisions required by the scheduled Gate policy.",
      successCriteria: [
        "Return only the strict scheduled Gate result for the exact server-prepared job set; never mark a job approved.",
        "Ask only the fixed-choice question produced by the scheduled Gate policy when required.",
        "Never submit applications, contact employers, or expose private job material.",
      ],
    }] })
  })

  it("accepts a bounded fixed-choice question and binds its candidate digest", () => {
    expect(parseScheduledGateResult(question, jobIds)).toEqual(question)
    expect(parseScheduledGateChoice({ kind: "weak_cover_letter", jobIds: ["job-a"], choiceId: "continue" }, question))
      .toBe("continue")
    expect(parseScheduledGateTaskEnvelope(waitingEnvelope, "waiting_for_user", jobIds)).toEqual(waitingEnvelope)
  })

  it("returns the exact skip choice ID and rejects extra choice fields", () => {
    expect(parseScheduledGateChoice({ kind: "weak_cover_letter", jobIds: ["job-a"], choiceId: "skip" }, question))
      .toBe("skip")
    expect(parseScheduledGateChoice({ kind: "weak_cover_letter", jobIds: ["job-a"], choiceId: "skip", source: "user" }, question))
      .toBeNull()
  })

  it("accepts only an exact partition for Execute without granting approval", () => {
    expect(parseScheduledGateResult({
      status: "completed", nextStage: "execute", approvedJobIds: [],
      pendingJobIds: ["job-b"], skippedJobIds: ["job-a"], counts: { approved: 0, pending: 1, skipped: 1 },
    }, jobIds)).toMatchObject({
      status: "completed", approvedJobIds: [], pendingJobIds: ["job-b"], skippedJobIds: ["job-a"],
    })
    expect(parseScheduledGateResult({
      status: "completed", nextStage: "execute", approvedJobIds: [],
      pendingJobIds: ["job-b"], skippedJobIds: [], counts: { approved: 0, pending: 1, skipped: 0 },
    }, jobIds)).toBeNull()
    expect(parseScheduledGateResult({
      status: "completed", nextStage: "execute", approvedJobIds: [],
      pendingJobIds: ["job-a", "job-b"], skippedJobIds: [], counts: { approved: 0, pending: 2, skipped: 0 },
    }, jobIds)).toMatchObject({ status: "completed", nextStage: "execute" })
    expect(parseScheduledGateResult({
      status: "completed", nextStage: "execute", approvedJobIds: ["job-a"],
      pendingJobIds: ["job-b"], skippedJobIds: [], counts: { approved: 1, pending: 1, skipped: 0 },
    }, jobIds)).toBeNull()
    expect(parseScheduledGateResult({
      status: "completed", nextStage: "execute", approvedJobIds: ["job-a", "job-a"],
      pendingJobIds: ["job-b"], skippedJobIds: [], counts: { approved: 2, pending: 1, skipped: 0 },
    }, jobIds)).toBeNull()
  })

  it("projects prepared jobs only and rejects ambiguous persisted job identities", () => {
    const proof = prepareProofFor([
      { jobId: "prepared-a", status: "prepared" },
      { jobId: "skipped-b", status: "skipped" },
      { jobId: "prepared-c", status: "prepared" },
    ])
    expect(scheduledGatePreparedJobIds(proof)).toEqual(["prepared-a", "prepared-c"])
    expect(scheduledGatePreparedJobIdsFromResult({ jobs: [
      { jobId: "same", status: "prepared" }, { jobId: "same", status: "skipped" },
    ] })).toBeNull()
  })

  it.each([
    ["extra question property", { ...question, prompt: "private" }],
    ["wrong digest", { ...question, candidateSetDigest: "sha256:" + "0".repeat(64) }],
    ["wrong fixed choices", { ...question, allowedChoiceIds: ["continue", "skip"] }],
    ["unknown job", { ...question, jobIds: ["other"] }],
    ["multiple weak-letter jobs", { ...question, jobIds: ["job-a", "job-b"], candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-a", "job-b"]) }],
  ])("rejects %s", (_name, value) => {
    expect(parseScheduledGateResult(value, jobIds)).toBeNull()
  })

  it("rejects an outer status mismatch, private field, or fabricated fixed-step report", () => {
    expect(parseScheduledGateTaskEnvelope({ ...waitingEnvelope, status: "completed" }, "waiting_for_user", jobIds)).toBeNull()
    expect(parseScheduledGateTaskEnvelope(waitingEnvelope, "completed", jobIds)).toBeNull()
    expect(parseScheduledGateTaskEnvelope({ ...waitingEnvelope, taskGraphVerificationReport: { status: "passed" } }, "waiting_for_user", jobIds)).toBeNull()
    expect(parseScheduledGateTaskEnvelope({ ...waitingEnvelope, stepCount: 1 }, "waiting_for_user", jobIds)).toBeNull()
    expect(parseScheduledGateTaskEnvelope({ ...waitingEnvelope, binding: { secret: true } }, "waiting_for_user", jobIds)).toBeNull()
  })

  it("accepts JSON-encoded persisted results and rejects choices from a different identity", () => {
    expect(parseScheduledGateTaskEnvelope(JSON.stringify(waitingEnvelope), "waiting_for_user", jobIds)).toMatchObject(waitingEnvelope)
    expect(parseScheduledGateChoice({ kind: "borderline_match", jobIds: ["job-a"], choiceId: "skip" }, question)).toBeNull()
    expect(parseScheduledGateChoice({ kind: "weak_cover_letter", jobIds: ["job-b"], choiceId: "continue" }, question)).toBeNull()
  })

  it("accepts only the Gate-stage projection of a fully valid persisted Analyze checkpoint", () => {
    const state = {
      nextStage: "gate",
      scoutedJobs: [{ id: "job-a", userId: "user-1" }],
      scoredJobs: [{ job: { id: "job-a", userId: "user-1" }, score: 80, matchedKeywords: ["TypeScript"],
        missingKeywords: [], recommendation: "Apply after tailoring.", analysisFenceAt: "2026-10-06T10:00:00.000Z" }],
      analysisFailed: 0,
      scheduledTaskGraphContinuation: {
        schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
        key: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
        owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 1,
          turnLeaseOwnerId: "lease-1", turnLeaseVersion: 2, executionId: "execution-1", executionAttemptCount: 1 },
        snapshotDigest: `sha256:${"b".repeat(64)}`, graphRevision: 2, evidenceDigest: "c".repeat(64),
      },
    }
    const evidence = scheduledGateCheckpointEvidence(state)
    expect(evidence).toMatchObject({ owner: { userId: "user-1", executionId: "execution-1" }, analyzeGraphRevision: 2,
      prepareWaitContinuationKey: state.scheduledTaskGraphContinuation.key })
    expect(evidence?.prepareWaitContinuationKey).not.toBe(evidence?.continuationKey)
    expect(scheduledGateCheckpointEvidence({ ...state, nextStage: "prepare" })).toBeNull()
    expect(scheduledGateCheckpointEvidence({ ...state, analysisFailed: 1 })).toBeNull()
    expect(scheduledGateCheckpointEvidence({ ...state, scheduledTaskGraphContinuation: {
      ...state.scheduledTaskGraphContinuation, key: "malformed-handoff-key",
    } })).toBeNull()
  })
})
