import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTurnScheduledGateChoiceContent, createTurnScheduledGateChoiceResumeAcknowledgement,
  parseTurnQuestionGateChoiceBinding, TURN_SCHEDULED_GATE_CHOICE_SCHEMA, turnScheduledGateChoiceWaitId } from "../turns/turn-question-gate-choice-contract.js"
import { SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA,
  scheduledGateCandidateSetDigest, scheduledGateCheckpointEvidence } from "./scheduled-gate-contract.js"
import { buildScheduledPrepareTaskGraphProof, SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
  scheduledPrepareResultDigest } from "./scheduled-prepare-task-graph-verification.js"
import { buildScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import { ROLE_RESULT_SCHEMA, type PrepareResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { scheduledGateRegistrationReceiptKey, SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA } from "./scheduled-gate-registration-receipt.js"
import { matchScheduledGateWaitTarget, readScheduledGateQuestionCandidate, scheduledGateWaitMatcherFromResult,
  scheduledGateWaitReplayMatches } from "./scheduled-gate-wait-match.js"

const state = vi.hoisted(() => ({ graph: null as unknown, ackRows: [] as Record<string, unknown>[], prepareWaitRows: [] as Record<string, unknown>[],
  prepareStepRows: [] as Record<string, unknown>[], registrationRows: [] as Record<string, unknown>[] }))
vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: vi.fn(async () => state.graph) }))

const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
  targetLocations: ["Dublin"], minScore: 70, dailyCap: 2, requireApproval: true, autoApply: false }
const snapshotDigest = "sha256:" + createHash("sha256").update(JSON.stringify([snapshot.schemaVersion, snapshot.targetRoles,
  snapshot.targetLocations, snapshot.minScore, snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]), "utf8").digest("hex")
const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", stepId: "root-final-step", gateTaskId: "gate-1", requestAttemptCount: 0 }
const checkpointOwner = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
  rootAttemptCount: 1, turnLeaseOwnerId: "turn-owner", turnLeaseVersion: 3, executionId: "execution-1", executionAttemptCount: 2 }
const checkpointState = { nextStage: "gate", scoutedJobs: Array.from({ length: 60 }, (_, index) => ({ id: `job-${index + 1}`, userId: scope.userId })),
  scoredJobs: Array.from({ length: 60 }, (_, index) => ({ job: { id: `job-${index + 1}`, userId: scope.userId }, score: 80, matchedKeywords: ["TypeScript"], missingKeywords: [],
    recommendation: "Prepared candidate.", analysisFenceAt: "2026-10-23T12:00:00.000Z" })), analysisFailed: 0,
  scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
    key: "scheduled-taskgraph:sha256:" + "a".repeat(64), snapshotDigest, evidenceDigest: "b".repeat(64), graphRevision: 2, owner: checkpointOwner } }
const checkpointEvidence = scheduledGateCheckpointEvidence(checkpointState)!
const prepareResult: PrepareResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-1", attemptCount: 1,
  snapshotDigest: checkpointEvidence.snapshotDigest, checkpointDigest: checkpointEvidence.checkpointDigest,
  jobs: [{ jobId: "job-1", status: "prepared" }, { jobId: "job-2", status: "skipped" }],
  materials: [{ jobId: "job-1", kind: "resume", artifactRef: { artifactId: "draft-1", version: 1,
    contentHash: "sha256:" + "c".repeat(64), sourceDigest: "sha256:" + "d".repeat(64) } }] }
const prepareReceipt = buildScheduledTaskGraphContinuationReceipt({ owner: checkpointOwner, continuationKey: checkpointEvidence.continuationKey,
  snapshotDigest: checkpointEvidence.snapshotDigest, evidenceDigest: checkpointEvidence.evidenceDigest, checkpointDigest: checkpointEvidence.checkpointDigest,
  analyzeGraphRevision: checkpointEvidence.analyzeGraphRevision, prepareScheduleRevision: checkpointEvidence.analyzeGraphRevision + 1 })!
const prepareFacts = { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt: prepareReceipt,
  completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 4, nodes: [
    { taskId: "scout-1", attemptCount: 1, role: "scout", taskType: TASK_GRAPH_TEMPLATES.scout.taskType, status: "completed", verification: "passed", dependsOnTaskIds: [] },
    { taskId: "analyst-1", attemptCount: 2, role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, status: "completed", verification: "passed", dependsOnTaskIds: ["scout-1"] },
    { taskId: "prepare-1", attemptCount: 1, role: "prepare", taskType: TASK_GRAPH_TEMPLATES.prepare.taskType, status: "completed", verification: "passed",
      dependsOnTaskIds: ["analyst-1"], tool: "scheduled.application.prepare@1", resultDigest: scheduledPrepareResultDigest(prepareResult) },
  ] }, result: prepareResult }
const prepareProof = buildScheduledPrepareTaskGraphProof(prepareFacts, { waitId: "prepare-wait-1", status: "ready", mode: "all",
  targetTaskIds: ["prepare-1"], matchedTaskIds: ["prepare-1"] })!
const prepareStepId = "original-prepare-step"
const prepareWaitKey = `scheduled-prepare-dependency:${createHash("sha256").update(`${checkpointEvidence.continuationKey}\0${prepareStepId}`, "utf8").digest("hex")}`
const registrationOwner = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
  rootAttemptCount: 1, executionId: "execution-1", executionAttemptCount: 2 }
const registrationReceipt = { schemaVersion: SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA, owner: registrationOwner,
  continuationKey: checkpointEvidence.continuationKey, snapshotDigest: checkpointEvidence.snapshotDigest,
  evidenceDigest: checkpointEvidence.evidenceDigest, checkpointDigest: checkpointEvidence.checkpointDigest,
  analyzeGraphRevision: checkpointEvidence.analyzeGraphRevision, prepareScheduleRevision: checkpointEvidence.analyzeGraphRevision + 1,
  prepareWaitId: "prepare-wait-1", gateTaskId: scope.gateTaskId, gateAppendRevision: 5 }
const binding = parseTurnQuestionGateChoiceBinding({ schemaVersion: TURN_SCHEDULED_GATE_CHOICE_SCHEMA,
  owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: 1, executionId: "execution-1", executionAttemptCount: 2 },
  continuationKey: checkpointEvidence.continuationKey, snapshotDigest: checkpointEvidence.snapshotDigest, evidenceDigest: checkpointEvidence.evidenceDigest,
  checkpointDigest: checkpointEvidence.checkpointDigest, analyzeGraphRevision: checkpointEvidence.analyzeGraphRevision,
  graphRevision: 6, gateTaskId: scope.gateTaskId, gateAttempt: 1,
  kind: "weak_cover_letter", jobIds: ["job-1"], allowedChoiceIds: ["continue", "review", "skip"] })!
const waitId = turnScheduledGateChoiceWaitId(binding)!
const itemId = `agent-wait:question:${waitId}`
const question = { status: "question_required", kind: "weak_cover_letter", jobIds: ["job-1"],
  candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-1"]), allowedChoiceIds: ["continue", "review", "skip"] }
const waitingEnvelope = { finalItemId: null, finalText: "", status: "waiting_for_user", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: question }
const completedEnvelope = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: { status: "completed", nextStage: "execute", approvedJobIds: [], pendingJobIds: ["job-1"], skippedJobIds: [],
    counts: { approved: 0, pending: 1, skipped: 0 } } }
const lifecycle = (type: string, attempt: number, expectedRevision: number, extra: Record<string, unknown> = {}) => ({ nodeKey: "gate", type,
  idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "gate", attempt, type), expectedRevision, ...extra })
const start = (attempt: number, expectedRevision: number) => lifecycle("task.started", attempt, expectedRevision)
const expectedSchema = (role: "scout" | "analyst" | "prepare") => TASK_GRAPH_TEMPLATES[role].expectedOutputSchema
const allowedActions = (role: "scout" | "analyst" | "prepare") => TASK_GRAPH_TEMPLATES[role].allowedActions

function graph(taskStatus: string, currentAttempt: number, wrongStart = false, requestAttemptCount = 0) {
  const nodes = [
    { key: "scout", templateId: "scout", goal: "discover", successCriteria: [], dependsOn: [], depth: 1, taskId: "scout-1", verificationDisposition: "typed", verification: { role: "scout" } },
    { key: "analyst", templateId: "analyst", goal: "analyze", successCriteria: [], dependsOn: ["scout"], depth: 2, taskId: "analyst-1", verificationDisposition: "typed", verification: { role: "analyst" } },
    { key: "prepare", templateId: "prepare", goal: "prepare", successCriteria: [], dependsOn: ["analyst"], depth: 3, taskId: "prepare-1", verificationDisposition: "specialized" },
    { key: "gate", templateId: "gate", goal: SCHEDULED_GATE_NODE_GOAL, successCriteria: SCHEDULED_GATE_NODE_CRITERIA,
      dependsOn: ["prepare"], depth: 4, taskId: scope.gateTaskId, verificationDisposition: "specialized" },
  ]
  const gateTask = { id: scope.gateTaskId, status: taskStatus, role: "prepare", taskType: "scheduled_taskgraph_gate",
    expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [] }
  const tasks = new Map<string, Record<string, unknown>>([
    ["scout-1", { id: "scout-1", status: "completed", role: "scout", taskType: TASK_GRAPH_TEMPLATES.scout.taskType, expectedOutputSchema: expectedSchema("scout"), allowedActions: allowedActions("scout"), attemptCount: 1, failureReason: null }],
    ["analyst-1", { id: "analyst-1", status: "completed", role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, expectedOutputSchema: expectedSchema("analyst"), allowedActions: allowedActions("analyst"), attemptCount: 2, failureReason: null }],
    ["prepare-1", { id: "prepare-1", status: "completed", role: "prepare", taskType: TASK_GRAPH_TEMPLATES.prepare.taskType, expectedOutputSchema: expectedSchema("prepare"), allowedActions: allowedActions("prepare"), attemptCount: 1, failureReason: null,
      result: { status: "completed", structuredResult: prepareResult, taskGraphScheduledPrepareProofFacts: prepareFacts } }],
    [scope.gateTaskId, gateTask],
  ])
  const events: Record<string, unknown>[] = []
  let revision = 5
  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    events.push(start(attempt, revision++))
    if (attempt < currentAttempt) {
      if (attempt === requestAttemptCount) {
        events.push(lifecycle("task.waiting_for_user", attempt, revision++))
        events.push(lifecycle("task.gate_choice_resumed", attempt, revision++, { gateTaskId: scope.gateTaskId,
          requestAttemptCount: attempt, resumedAttemptCount: attempt + 1 }))
      } else events.push(lifecycle("task.retrying", attempt, revision++))
    }
  }
  if (taskStatus === "waiting_for_user" && currentAttempt > 0) events.push(lifecycle("task.waiting_for_user", currentAttempt, revision++))
  if (taskStatus === "queued" && currentAttempt > 0) {
    if (requestAttemptCount === currentAttempt) {
      events.push(lifecycle("task.waiting_for_user", currentAttempt, revision++))
      events.push(lifecycle("task.gate_choice_resumed", currentAttempt, revision++, { gateTaskId: scope.gateTaskId,
        requestAttemptCount: currentAttempt, resumedAttemptCount: currentAttempt + 1 }))
    } else events.push(lifecycle("task.retrying", currentAttempt, revision++))
  }
  if (wrongStart) events[0] = { ...events[0]!, idempotencyKey: "misbound-start" }
  const current = nodes.map(node => ({ key: node.key, taskId: node.taskId, status: node.key === "gate" ? taskStatus : "completed", failureReason: null }))
  return { item: { id: "task-graph-root", revision, content: {} }, snapshot: { nodes },
    state: { revision, appliedEvents: events, nodes: current }, tasks }
}

function acknowledgementRow(overrides: Record<string, unknown> = {}) {
  const ack = createTurnScheduledGateChoiceResumeAcknowledgement({ binding, gateTaskId: scope.gateTaskId,
    requestAttemptCount: 1, waitId, itemId, resumedAttemptCount: 2 })!
  const content = { ...createTurnScheduledGateChoiceContent(waitId, binding, "Continue?"), answer: "continue",
    answerAvailable: true, answeredAt: "2026-10-23T12:00:00.000Z", scheduledGateChoiceResumeAcknowledgement: ack }
  return { id: itemId, taskId: scope.rootTaskId, type: "question", status: "completed", stepStatus: "waiting_for_user", content, ...overrides }
}

function fixture(options: { status?: string; attempts?: number; result?: unknown; turnStatus?: string; malformedTask?: Record<string, unknown>;
  noAck?: boolean; malformedAck?: boolean; wrongStart?: boolean; malformedPrepareWait?: boolean; malformedRegistration?: boolean;
  wrongAppendRevision?: boolean; requestAttemptCount?: number } = {}) {
  const status = options.status ?? "queued", attempts = options.attempts ?? 0
  state.graph = graph(status, attempts, options.wrongStart, options.requestAttemptCount)
  const currentRow = { id: scope.gateTaskId, parentTaskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, sessionId: scope.sessionId,
    turnId: scope.turnId, depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status, attemptCount: attempts, maxAttempts: 3,
    result: options.result ?? null, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], rootAttemptCount: 1, rootStatus: "running",
    turnRootTaskId: scope.rootTaskId, turnStatus: options.turnStatus ?? "in_progress", source: "automation", executionMode: "canonical_task_graph",
    input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot }, userId: scope.userId, sessionStatus: "running",
    executionId: "execution-1", executionAttemptCount: 2, executionStatus: "running", state: checkpointState, ...options.malformedTask }
  state.ackRows = options.noAck ? [] : [acknowledgementRow(options.malformedAck ? { content: { ...acknowledgementRow().content,
    scheduledGateChoiceResumeAcknowledgement: { gateTaskId: "foreign-gate", requestAttemptCount: 1, waitId, itemId, resumedAttemptCount: 2 } } } : {})]
  state.prepareWaitRows = options.malformedPrepareWait ? [{ id: "prepare-wait-1", userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, parentTaskId: scope.rootTaskId, stepId: prepareStepId, idempotencyKey: prepareWaitKey, targetTaskIds: ["prepare-1"], mode: "all",
    status: "waiting", matchedTaskIds: ["prepare-1"], result: { request: { targetTaskIds: ["prepare-1"], mode: "all", timeoutMs: 86_400_000 } } }] : [{
    id: "prepare-wait-1", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
    stepId: prepareStepId, idempotencyKey: prepareWaitKey, targetTaskIds: ["prepare-1"], mode: "all", status: "ready", matchedTaskIds: ["prepare-1"],
    result: { request: { targetTaskIds: ["prepare-1"], mode: "all", timeoutMs: 86_400_000 } } }]
  state.prepareStepRows = [{ id: prepareStepId, taskId: null, attempt: 1 }]
  state.registrationRows = [{ itemId: null, taskId: null, actor: "system",
    idempotencyKey: scheduledGateRegistrationReceiptKey(checkpointEvidence.continuationKey, scope.gateTaskId),
    payload: { ...registrationReceipt, ...(options.malformedRegistration ? { prepareWaitId: "missing-prepare-wait" } : {}),
      ...(options.wrongAppendRevision ? { gateAppendRevision: 6 } : {}) }, hasOutbox: false }]
  const client = { query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM "sub_agent_tasks" AS gate')) return { rows: [currentRow], rowCount: 1 }
    if (sql.includes('FROM "agent_items" AS item')) return { rows: state.ackRows, rowCount: state.ackRows.length }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: state.registrationRows, rowCount: state.registrationRows.length }
    if (sql.includes('FROM "agent_wait_conditions"')) return { rows: state.prepareWaitRows, rowCount: state.prepareWaitRows.length }
    if (sql.includes('FROM "agent_steps"')) return { rows: state.prepareStepRows, rowCount: state.prepareStepRows.length }
    throw new Error("unexpected scheduled Gate match query: " + sql)
  }) }
  return client
}

describe("scheduled Gate durable wait matcher", () => {
  beforeEach(() => { state.ackRows = []; state.prepareWaitRows = []; state.prepareStepRows = []; state.registrationRows = []; vi.clearAllMocks() })

  it.each([
    ["initial queued before its first claim", "queued", 0, null, "pending"],
    ["initial running attempt", "running", 1, null, "pending"],
    ["strict question result", "waiting_for_user", 1, waitingEnvelope, "matched"],
    ["strict completed result", "completed", 1, completedEnvelope, "matched"],
  ] as const)("matches %s only at its expected attempt", async (_label, status, attempts, result, expected) => {
    await expect(matchScheduledGateWaitTarget(fixture({ status, attempts, result }) as never, scope)).resolves.toBe(expected)
  })

  it("matches only the prepared subset, even when Analyze has more than fifty scored rows", async () => {
    expect(prepareProof.result.jobs).toHaveLength(2)
    expect(prepareStepId).not.toBe(scope.stepId)
    await expect(matchScheduledGateWaitTarget(fixture({ status: "waiting_for_user", attempts: 1, result: waitingEnvelope }) as never, scope)).resolves.toBe("matched")
    await expect(matchScheduledGateWaitTarget(fixture({ status: "waiting_for_user", attempts: 1, result: {
      ...waitingEnvelope, structuredResult: { ...question, jobIds: ["job-2"], candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-2"]) },
    } }) as never, scope)).resolves.toBeNull()
  })

  it("matches while the exact Root Turn is durably suspended on tool work and accepts JSONB schema key order", async () => {
    await expect(matchScheduledGateWaitTarget(fixture({ status: "waiting_for_user", attempts: 1, result: waitingEnvelope,
      turnStatus: "waiting_for_tool", malformedTask: { expectedOutputSchema: {
        taskType: SCHEDULED_GATE_OUTPUT_SCHEMA.taskType, role: SCHEDULED_GATE_OUTPUT_SCHEMA.role,
        schemaVersion: SCHEDULED_GATE_OUTPUT_SCHEMA.schemaVersion,
      } } }) as never, scope)).resolves.toBe("matched")
  })

  it("recovers only the current strict question and stable private binding for Root", async () => {
    const result = await readScheduledGateQuestionCandidate(fixture({ status: "waiting_for_user", attempts: 1,
      result: waitingEnvelope }) as never, scope)
    expect(result).toEqual({ question, binding: expect.objectContaining({
      owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
        rootAttemptCount: 1, executionId: "execution-1", executionAttemptCount: 2 },
      gateTaskId: scope.gateTaskId, gateAttempt: 1, graphRevision: 6,
      jobIds: ["job-1"], kind: "weak_cover_letter",
    }) })
    expect(JSON.stringify(result)).not.toContain("turnLeaseOwnerId")
  })

  it("requires exact resume acknowledgement and rejects absent Prepare checkpoint/wait proof", async () => {
    const resumedScope = { ...scope, requestAttemptCount: 1 }
    await expect(matchScheduledGateWaitTarget(fixture({ status: "queued", attempts: 1, requestAttemptCount: 1 }) as never, resumedScope)).resolves.toBe("pending")
    await expect(matchScheduledGateWaitTarget(fixture({ status: "running", attempts: 2, requestAttemptCount: 1 }) as never, resumedScope)).resolves.toBe("pending")
    await expect(matchScheduledGateWaitTarget(fixture({ status: "queued", attempts: 1, noAck: true, requestAttemptCount: 1 }) as never, resumedScope)).resolves.toBeNull()
    await expect(matchScheduledGateWaitTarget(fixture({ status: "running", attempts: 2, malformedAck: true, requestAttemptCount: 1 }) as never, resumedScope)).resolves.toBeNull()
    await expect(matchScheduledGateWaitTarget(fixture({ status: "running", attempts: 1, malformedPrepareWait: true }) as never, scope)).resolves.toBeNull()
    await expect(matchScheduledGateWaitTarget(fixture({ status: "running", attempts: 1, malformedRegistration: true }) as never, scope)).resolves.toBeNull()
    await expect(matchScheduledGateWaitTarget(fixture({ status: "running", attempts: 1, wrongAppendRevision: true }) as never, scope)).resolves.toBeNull()
  })

  it("rejects malformed completed envelopes, wrong task identity, stale attempts, and misbound starts", async () => {
    await expect(matchScheduledGateWaitTarget(fixture({ status: "waiting", attempts: 1 }) as never, scope)).resolves.toBe("stale")
    await expect(matchScheduledGateWaitTarget(fixture({ status: "completed", attempts: 1, result: { status: "completed" } }) as never, scope)).resolves.toBeNull()
    await expect(matchScheduledGateWaitTarget(fixture({ status: "waiting_for_user", attempts: 1, result: { ...waitingEnvelope, status: "completed" } }) as never, scope)).resolves.toBeNull()
    await expect(matchScheduledGateWaitTarget(fixture({ status: "running", attempts: 1, malformedTask: { role: "gate" } }) as never, scope)).resolves.toBeNull()
    await expect(matchScheduledGateWaitTarget(fixture({ status: "running", attempts: 1, wrongStart: true }) as never, scope)).resolves.toBeNull()
    await expect(matchScheduledGateWaitTarget(fixture({ status: "running", attempts: 1, malformedTask: { userId: "foreign-user" } }) as never, scope)).resolves.toBeNull()
  })

  it("distinguishes generic requests, strict Gate markers, and replay mismatch", () => {
    const generic = { request: { targetTaskIds: ["gate-1"], mode: "any", timeoutMs: 1000 } }
    const specialized = { request: { ...generic.request, scheduledGate: { gateTaskId: "gate-1", requestAttemptCount: 1 } } }
    expect(scheduledGateWaitMatcherFromResult(generic)).toBeNull()
    expect(scheduledGateWaitMatcherFromResult(specialized)).toEqual({ gateTaskId: "gate-1", requestAttemptCount: 1 })
    expect(scheduledGateWaitMatcherFromResult({ request: { ...specialized.request, scheduledGate: { ...specialized.request.scheduledGate, extra: true } } })).toBeUndefined()
    expect(scheduledGateWaitReplayMatches(generic)).toBe(true)
    expect(scheduledGateWaitReplayMatches(specialized)).toBe(false)
    expect(scheduledGateWaitReplayMatches(generic, { gateTaskId: "gate-1", requestAttemptCount: 1 })).toBe(false)
    expect(scheduledGateWaitReplayMatches(specialized, { gateTaskId: "gate-1", requestAttemptCount: 1 })).toBe(true)
  })
})
