import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import {
  buildScheduledPrepareTaskGraphProof,
  SCHEDULED_PREPARE_COMPLETION_SCHEMA,
  SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
  scheduledPrepareResultDigest,
  verifyScheduledPrepareTaskGraphEvidence,
} from "./scheduled-prepare-task-graph-verification.js"
import { buildScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey,
  SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT } from "./scheduled-taskgraph-continuation-receipt.js"
import { ROLE_RESULT_SCHEMA, type PrepareResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphFingerprint } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION, publicTaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./child-discovery-attempt.js"
import { SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION } from "./scheduled-automation-snapshot.js"
import { canonicalJson } from "@jobcopilot/shared"
import { prepareToolResultJson, type CanonicalToolSourceName } from "../tools/tool-result-reference-types.js"
import { verifyPrepareToolResultOutput } from "./scheduled-prepare-task-graph-verification.js"

afterEach(() => { gateCheckpointMocks.stableKey = null; gateCheckpointMocks.handoffKey = null
  gateCheckpointMocks.dependencies.mockReset(); gateCheckpointMocks.nodeEvidence.mockReset(); gateCheckpointMocks.receipts.mockReset() })

const gateCheckpointMocks = vi.hoisted(() => ({ stableKey: null as string | null, handoffKey: null as string | null,
  dependencies: vi.fn(), nodeEvidence: vi.fn(), receipts: vi.fn() }))
vi.mock("./scheduled-taskgraph-continuation-receipt.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-continuation-receipt.js")>()
  return { ...actual, scheduledTaskGraphStableContinuationKey: (value: unknown) => gateCheckpointMocks.stableKey
    ?? actual.scheduledTaskGraphStableContinuationKey(value) }
})
vi.mock("./scheduled-pipeline-handoff.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-pipeline-handoff.js")>()
  return { ...actual, scheduledTaskGraphContinuationKey: (...args: Parameters<typeof actual.scheduledTaskGraphContinuationKey>) =>
    gateCheckpointMocks.handoffKey ?? actual.scheduledTaskGraphContinuationKey(...args) }
})
vi.mock("./task-graph-pg-completed-dependency-verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-completed-dependency-verification.js")>()
  return { ...actual, verifyCompletedScoutDependencies: gateCheckpointMocks.dependencies }
})
vi.mock("./task-graph-pg-verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-verification.js")>()
  return { ...actual, verifyCompletedTaskGraphNodeEvidence: gateCheckpointMocks.nodeEvidence }
})
vi.mock("./task-graph-pg-verification-receipts.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-verification-receipts.js")>()
  return { ...actual, loadTaskGraphVerificationReceipts: gateCheckpointMocks.receipts }
})

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
const prepareTool = "scheduled.application.prepare" as CanonicalToolSourceName
const prepareScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  taskId: "subagent-12345678-1234-4234-9234-123456789012", attemptCount: 2 }

function largeResult(): PrepareResult {
  const jobs = Array.from({ length: 50 }, (_, index) => ({ jobId: "c" + index.toString(36).padStart(24, "0"), status: "prepared" as const }))
  return { ...result, taskId: prepareScope.taskId, attemptCount: prepareScope.attemptCount,
    jobs, materials: jobs.map((job, index) => ({ jobId: job.jobId, kind: "resume" as const, artifactRef: {
      artifactId: "scheduled-draft:" + index.toString(16).padStart(64, "0"), version: 1,
      contentHash: "sha256:" + "c".repeat(64), sourceDigest: "sha256:" + "d".repeat(64),
    } })) }
}

function referenceFixture(expected: PrepareResult, leaseOwner: string, expired = false) {
  const stored = prepareToolResultJson(expected, prepareTool, expected.taskId)
  const id = "tool-result-12345678-1234-4234-9234-123456789012"
  const stepId = "step-prepare-1", toolCallId = "call-prepare-1"
  const row = { id, userId: prepareScope.userId, sessionId: prepareScope.sessionId, turnId: prepareScope.turnId, stepId,
    taskId: expected.taskId, toolCallId, sanitizedJson: stored.value, sha256: stored.sha256, byteCount: stored.bytes,
    createdAt: new Date("2026-10-01T00:00:00.000Z"), updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    currentRootTaskId: prepareScope.rootTaskId, currentAttemptCount: expected.attemptCount, currentTaskStatus: "running", currentTaskFailureReason: null, currentLeaseOwner: leaseOwner,
    currentLeaseExpiresAt: new Date(expired ? "2020-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z"), currentInterruptRequestedAt: null,
    leaseCheckedAt: new Date(expired ? "2021-01-01T00:00:00.000Z" : "2098-12-31T00:00:00.000Z"), currentStepAttempt: expected.attemptCount,
    sourceCallItemId: "tool-item-prepare-1", sourceCallStepId: stepId, sourceCallTaskId: expected.taskId, sourceCallType: "tool_call",
    sourceCallStatus: "completed", sourceCallContent: { toolCallId, toolName: prepareTool, toolVersion: "1", input: {}, status: "completed", errorCode: null } }
  return { expected, stepId, toolCallId, output: { $ref: id, sizeBytes: stored.bytes, sha256: stored.sha256 }, row }
}
function completedReferenceFixture(expected: PrepareResult) {
  const active = referenceFixture(expected, "worker-owner-1")
  return { ...active, row: { ...active.row, currentTaskStatus: "completed", currentLeaseOwner: null, currentLeaseExpiresAt: null } }
}

function checkpointFixture(stage: "prepare" | "gate") {
  const owner = binding.owner, automation = { schemaVersion: SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION,
    targetRoles: ["Software Engineer"], targetLocations: [], minScore: 50, dailyCap: 50, requireApproval: true, autoApply: false }
  const snapshotDigest = `sha256:${createHash("sha256").update(JSON.stringify([automation.schemaVersion, automation.targetRoles,
    automation.targetLocations, automation.minScore, automation.dailyCap, automation.requireApproval, automation.autoApply]), "utf8").digest("hex")}`
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
    { key: "prepare", templateId: "prepare", taskId: prepareScope.taskId, goal: "Prepare materials", successCriteria: ["Persist materials"],
      dependsOn: ["analyst"], depth: 3, verificationDisposition: "specialized" },
  ] }
  const evidence = [{ id: "evidence-1", kind: "job", ref: "job-1", source: "test" }]
  const scoutResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [
    { jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["evidence-1"] },
  ], evidence, summary: "one candidate" }
  const analystResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [
    { jobId: "job-1", score: 8, evidenceIds: ["evidence-1"] },
  ], evidence, summary: "one finding" }
  const dependencyBinding = { nodeKey: "scout", taskId: "scout-1", attemptCount: 1, nodeDigest: "1".repeat(64),
    resultDigest: "2".repeat(64), evidenceDigest: "3".repeat(64), reportDigest: "4".repeat(64) }
  const scoutReport = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "5".repeat(64),
    resultDigest: taskGraphFingerprint(scoutResult) } as const
  const analystReport = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "6".repeat(64),
    resultDigest: taskGraphFingerprint(analystResult), dependencyBindings: [dependencyBinding] } as const
  const scoutEnvelope = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 1,
    taskGraphVerificationReport: scoutReport, structuredResult: scoutResult,
    discoveryAttempt: { attemptCount: 1, health: { schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
      attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0, candidateCount: 1,
      providerFailures: 0, materializationFailures: 0, hasMore: false } } }
  const analystEnvelope = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
    taskGraphVerificationReport: analystReport, structuredResult: analystResult }
  const scoredJobs = [{ job: { id: "job-1", userId: owner.userId }, score: 80, matchedKeywords: ["typescript"],
    missingKeywords: [], recommendation: "review" }]
  const evidenceDigest = taskGraphFingerprint({ owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount }, snapshotDigest,
    graphDigest: taskGraphFingerprint({ schemaVersion: snapshot.schemaVersion, nodes: snapshot.nodes.slice(0, 2) }),
    graphRevision: 12, receipt: taskGraphFingerprint({ status: "complete", taskId: "scout-1", attemptCount: 1,
      completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false }),
    scout: { taskId: "scout-1", attemptCount: 1, report: publicTaskGraphVerificationReport(scoutReport) },
    analyst: { taskId: "analyst-1", attemptCount: 2, report: publicTaskGraphVerificationReport(analystReport), bindings: [dependencyBinding] } })
  const scoredProjection = [{ jobId: "job-1", score: 80, matchedKeywords: ["typescript"], missingKeywords: [], recommendation: "review" }]
  const checkpointDigest = createHash("sha256").update(JSON.stringify({ owner: [owner.userId, owner.sessionId, owner.turnId,
    owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount], snapshotDigest, evidenceDigest,
    analyzeGraphRevision: 12, analysisFailed: 0, scoredJobs: scoredProjection }), "utf8").digest("hex")
  const receiptBinding = { owner, continuationKey: `scheduled-taskgraph:sha256:${"0".repeat(64)}`, snapshotDigest,
    evidenceDigest, checkpointDigest, analyzeGraphRevision: 12, prepareScheduleRevision: 13 }
  const continuationKey = scheduledTaskGraphStableContinuationKey(receiptBinding)!
  const privateReceipt = buildScheduledTaskGraphContinuationReceipt({ ...receiptBinding, continuationKey })!
  gateCheckpointMocks.stableKey = continuationKey
  gateCheckpointMocks.handoffKey = "handoff-key"
  const prepareResult: PrepareResult = { ...result, taskId: prepareScope.taskId, attemptCount: prepareScope.attemptCount,
    snapshotDigest, checkpointDigest, jobs: [{ jobId: "job-1", status: "skipped" }], materials: [] }
  const prepareEnvelope = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 1,
    taskGraphVerificationReport: null, structuredResult: prepareResult }
  const task = (id: string, role: "scout" | "analyst" | "prepare", attemptCount: number, taskResult: unknown) => ({ id,
    role: TASK_GRAPH_TEMPLATES[role].role, taskType: TASK_GRAPH_TEMPLATES[role].taskType, status: "completed", failureReason: null,
    attemptCount, expectedOutputSchema: TASK_GRAPH_TEMPLATES[role].expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES[role].allowedActions,
    result: taskResult })
  const tasks = new Map([task("scout-1", "scout", 1, scoutEnvelope), task("analyst-1", "analyst", 2, analystEnvelope),
    task(prepareScope.taskId, "prepare", prepareScope.attemptCount, prepareEnvelope)].map(value => [value.id, value]))
  const current = { revision: 14, nodes: snapshot.nodes.map(node => ({ key: node.key, taskId: node.taskId, templateId: node.templateId,
    status: "completed", readiness: "ready", failureReason: null,
    verificationReport: node.key === "scout" ? publicTaskGraphVerificationReport(scoutReport)
      : node.key === "analyst" ? publicTaskGraphVerificationReport(analystReport) : null })) }
  const state = { nextStage: stage, analysisFailed: 0, scoutedJobs: [{ id: "job-1", userId: owner.userId }], scoredJobs,
    scheduledTaskGraphContinuation: { key: "handoff-key", snapshotDigest, graphRevision: 12, evidenceDigest,
      owner: stage === "gate" ? { ...owner, turnLeaseOwnerId: "turn-owner-2", turnLeaseVersion: 5 } : owner } }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM "agent_events" AS event')) return { rows: [{ type: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT,
      itemId: null, taskId: null, actor: "system", payload: privateReceipt, idempotencyKey: "scheduled-prepare:fixture", hasOutbox: false }] }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: [{ attemptCount: owner.rootAttemptCount }] }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: automation } }] }
    if (sql.includes('FROM "agent_executions"')) return { rows: [{ status: "running", attemptCount: owner.executionAttemptCount,
      checkpoint: stage, state }] }
    return { rows: [] }
  })
  const call = { toolCallId: "prepare-call", toolName: "scheduled.application.prepare", toolVersion: "1", input: {}, status: "completed", errorCode: null }
  gateCheckpointMocks.dependencies.mockResolvedValue({ projections: {}, bindings: [dependencyBinding] })
  gateCheckpointMocks.nodeEvidence.mockResolvedValue({ verified: true, report: publicTaskGraphVerificationReport(analystReport) })
  gateCheckpointMocks.receipts.mockResolvedValue({ items: [
    { type: "tool_call", stepId: "prepare-step", content: call },
    { type: "tool_result", stepId: "prepare-step", content: { errorCode: null, output: prepareResult } },
  ], replayReceipts: [], outcomes: new Map([["prepare-call", "completed"]]) })
  return { query, state, input: { scope: prepareScope, snapshot, current, tasks, structuredResult: prepareResult,
    completionGraphRevision: 14, referenceVerificationMode: { phase: "persisted_gate" as const } } }
}

describe("scheduled Prepare TaskGraph proof", () => {
  it("preserves inline Prepare receipts and resolves references only under the exact live owner lease", async () => {
    const query = vi.fn(async () => ({ rows: [] as unknown[] }))
    await expect(verifyPrepareToolResultOutput({ query } as never, { scope: prepareScope, stepId: "step-1", callStepId: "step-1",
      mode: { phase: "finish", ownerId: "worker-owner-1" }, toolCallId: "inline-call", output: result, rawResult: result, expectedResult: result })).resolves.toEqual(result)
    expect(query).not.toHaveBeenCalled()

    const expected = largeResult(), valid = referenceFixture(expected, "worker-owner-1")
    expect(Buffer.byteLength(canonicalJson(expected), "utf8")).toBeGreaterThan(8 * 1024)
    query.mockResolvedValueOnce({ rows: [valid.row] })
    await expect(verifyPrepareToolResultOutput({ query } as never, { scope: prepareScope, mode: { phase: "finish", ownerId: "worker-owner-1" }, stepId: valid.stepId,
      callStepId: valid.stepId, toolCallId: valid.toolCallId, output: valid.output, rawResult: expected, expectedResult: expected })).resolves.toEqual(expected)

    for (const stale of [referenceFixture(expected, "other-worker"), referenceFixture(expected, "worker-owner-1", true)]) {
      query.mockResolvedValueOnce({ rows: [stale.row] })
      await expect(verifyPrepareToolResultOutput({ query } as never, { scope: prepareScope, mode: { phase: "finish", ownerId: "worker-owner-1" }, stepId: stale.stepId,
        callStepId: stale.stepId, toolCallId: stale.toolCallId, output: stale.output, rawResult: expected, expectedResult: expected })).resolves.toBeNull()
    }
    await expect(verifyPrepareToolResultOutput({ query } as never, { scope: prepareScope, mode: { phase: "finish", ownerId: "worker-owner-1" }, stepId: "stale-step",
      callStepId: "step-1", toolCallId: "call-1", output: valid.output, rawResult: expected, expectedResult: expected })).resolves.toBeNull()
  })

  it("resolves a large receipt through the explicit completed-task Gate mode and rejects wrong bindings", async () => {
    const expected = largeResult(), completed = completedReferenceFixture(expected), mode = { phase: "persisted_gate" as const }
    const query = vi.fn(async () => ({ rows: [completed.row] as unknown[] }))
    expect(Buffer.byteLength(canonicalJson(expected), "utf8")).toBeGreaterThan(8 * 1024)
    await expect(verifyPrepareToolResultOutput({ query } as never, { scope: prepareScope, mode, stepId: completed.stepId,
      callStepId: completed.stepId, toolCallId: completed.toolCallId, output: completed.output, rawResult: expected,
      expectedResult: expected })).resolves.toEqual(expected)
    for (const invalid of [
      { ...completed.row, currentTaskStatus: "running" },
      { ...completed.row, currentTaskFailureReason: "failed" },
      { ...completed.row, currentLeaseOwner: "not-cleared" },
      { ...completed.row, currentLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z") },
    ]) {
      query.mockResolvedValueOnce({ rows: [invalid] })
      await expect(verifyPrepareToolResultOutput({ query } as never, { scope: prepareScope, mode, stepId: completed.stepId,
        callStepId: completed.stepId, toolCallId: completed.toolCallId, output: completed.output, rawResult: expected,
        expectedResult: expected })).resolves.toBeNull()
    }
    query.mockResolvedValueOnce({ rows: [completed.row] })
    await expect(verifyPrepareToolResultOutput({ query } as never, { scope: prepareScope, mode, stepId: completed.stepId,
      callStepId: completed.stepId, toolCallId: "wrong-call", output: completed.output, rawResult: expected,
      expectedResult: expected })).resolves.toBeNull()
    query.mockResolvedValueOnce({ rows: [completed.row] })
    await expect(verifyPrepareToolResultOutput({ query } as never, { scope: prepareScope, mode, stepId: completed.stepId,
      callStepId: completed.stepId, toolCallId: completed.toolCallId, output: { ...completed.output, sha256: "e".repeat(64) },
      rawResult: expected, expectedResult: expected })).resolves.toBeNull()
  })

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
      structuredResult: { ...result, taskId: "other-task" }, completionGraphRevision: 14, referenceVerificationMode: { phase: "persisted_gate" },
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
      referenceVerificationMode: { phase: "persisted_gate" },
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
      referenceVerificationMode: { phase: "persisted_gate" },
    })
    expect(incomplete).toEqual({ verified: false, reasonCode: "scheduled_prepare_graph_invalid" })
    expect(query).not.toHaveBeenCalled()

    const failed = { ...current, nodes: current.nodes.map(node => node.key === "prepare" ? { ...node, status: "failed", failureReason: "prepare_failed" } : node) }
    const failedTasks = new Map<string, unknown>(tasks)
    failedTasks.set("prepare-1", { ...tasks.get("prepare-1")!, status: "failed", failureReason: "prepare_failed" })
    const rejectedFailure = await verifyScheduledPrepareTaskGraphEvidence({ query } as never, {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "prepare-1", attemptCount: 1 },
      snapshot: snapshot as never, current: failed as never, tasks: failedTasks as never, structuredResult: { ...result, attemptCount: 1 }, completionGraphRevision: 13,
      referenceVerificationMode: { phase: "persisted_gate" },
    })
    expect(rejectedFailure).toEqual({ verified: false, reasonCode: "scheduled_prepare_graph_invalid" })
    expect(query).not.toHaveBeenCalled()
  })

  it("verifies the persisted Gate checkpoint with only transient Turn lease drift", async () => {
    const fixture = checkpointFixture("gate")
    const verified = await verifyScheduledPrepareTaskGraphEvidence({ query: fixture.query } as never,
      { ...fixture.input, checkpointStage: "gate" } as never)
    expect(verified).toMatchObject({ verified: true, facts: { receipt: { checkpointDigest: expect.any(String) } } })
    expect(fixture.query.mock.calls.some(([sql]) => String(sql).includes('FROM "agent_executions"'))).toBe(true)
  })

  it("keeps Prepare as the default checkpoint stage and rejects Gate stage, changed digest, or changed stable owner", async () => {
    const prepare = checkpointFixture("prepare")
    await expect(verifyScheduledPrepareTaskGraphEvidence({ query: prepare.query } as never, prepare.input as never))
      .resolves.toMatchObject({ verified: true })

    const wrongStage = checkpointFixture("gate")
    await expect(verifyScheduledPrepareTaskGraphEvidence({ query: wrongStage.query } as never, wrongStage.input as never))
      .resolves.toMatchObject({ verified: false, reasonCode: "scheduled_prepare_checkpoint_invalid" })

    const wrongDigest = checkpointFixture("gate")
    ;(wrongDigest.state.scoredJobs[0] as { score: number }).score = 81
    await expect(verifyScheduledPrepareTaskGraphEvidence({ query: wrongDigest.query } as never,
      { ...wrongDigest.input, checkpointStage: "gate" } as never))
      .resolves.toMatchObject({ verified: false, reasonCode: "scheduled_prepare_checkpoint_invalid" })

    const wrongOwner = checkpointFixture("gate")
    wrongOwner.state.scheduledTaskGraphContinuation.owner.rootTaskId = "other-root"
    await expect(verifyScheduledPrepareTaskGraphEvidence({ query: wrongOwner.query } as never,
      { ...wrongOwner.input, checkpointStage: "gate" } as never))
      .resolves.toMatchObject({ verified: false, reasonCode: "scheduled_prepare_checkpoint_invalid" })
  })
})
