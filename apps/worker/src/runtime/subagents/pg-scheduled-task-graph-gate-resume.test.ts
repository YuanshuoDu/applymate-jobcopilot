import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTurnScheduledGateChoiceContent, turnScheduledGateChoiceWaitId } from "../turns/turn-question-gate-choice-contract.js"
import { resumeScheduledGateChoice } from "./pg-scheduled-task-graph-gate-resume.js"
import { scheduledGateCandidateSetDigest, scheduledGateProposal, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { transaction } from "./pg-store-persistence.js"

const mocks = vi.hoisted(() => ({ load: vi.fn(), readCandidate: vi.fn(), match: vi.fn(), acknowledge: vi.fn(),
  prepare: vi.fn(), persist: vi.fn(), enqueue: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: mocks.load }))
vi.mock("./scheduled-gate-wait-match.js", () => ({ readScheduledGateQuestionCandidate: mocks.readCandidate,
  matchScheduledGateWaitTarget: mocks.match }))
vi.mock("../turns/turn-question-gate-choice-store.js", () => ({ acknowledgeScheduledGateChoiceResume: mocks.acknowledge }))
vi.mock("./task-graph-pg-lifecycle.js", () => ({ prepareGraphTransition: mocks.prepare, persistGraphTransition: mocks.persist }))
vi.mock("./task-graph-pg-dispatch.js", () => ({ enqueueReadyGraphTask: mocks.enqueue }))

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "gate-wait-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 4, parentLeaseOwner: "root-owner", parentAttemptCount: 2 }
const executionOwner = { executionId: "execution-1", executionAttemptCount: 3 }
const owner = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
  rootAttemptCount: scope.parentAttemptCount, ...executionOwner }
const binding = { schemaVersion: "agent-harness.v2.scheduled-gate-choice-wait.v1", owner,
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7, graphRevision: 12,
  gateTaskId: "gate-task", gateAttempt: 1, kind: "weak_cover_letter", jobIds: ["job-1"], allowedChoiceIds: ["continue", "review", "skip"] }
const waitId = turnScheduledGateChoiceWaitId(binding)!
const baseContent = createTurnScheduledGateChoiceContent(waitId, binding, "Continue or skip?")!
const answeredContent = { ...baseContent, answer: "continue", answerAvailable: true, answeredAt: "2026-10-23T10:00:00.000Z" }
const question = { status: "question_required", kind: "weak_cover_letter", jobIds: ["job-1"],
  candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-1"]),
  allowedChoiceIds: ["continue", "review", "skip"] }
const result = { finalItemId: null, finalText: "", status: "waiting_for_user", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: question }
const gateDefinition = scheduledGateProposal(0).nodes[0]!
const gateNode = { ...gateDefinition, taskId: "gate-task", depth: 4, status: "waiting_for_user", readiness: "blocked_dependency",
  verificationDisposition: "specialized" }
const prefix = [
  { key: "scout", templateId: "scout", taskId: "scout-task", depth: 1, dependsOn: [], verificationDisposition: "typed" },
  { key: "analyst", templateId: "analyst", taskId: "analyst-task", depth: 2, dependsOn: ["scout"], verificationDisposition: "typed" },
  { key: "prepare", templateId: "prepare", taskId: "prepare-task", depth: 3, dependsOn: ["analyst"], verificationDisposition: "specialized" },
]
const graphState = { revision: 13, appliedEvents: [
  { type: "task.started", nodeKey: "gate", idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "gate", 1, "task.started"), expectedRevision: 11 },
  { type: "task.waiting_for_user", nodeKey: "gate", idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "gate", 1, "task.waiting_for_user"), expectedRevision: 12 },
] , nodes: [...prefix.map(node => ({ ...node, status: "completed" })), {
  key: "gate", taskId: "gate-task", status: "waiting_for_user",
}] }
const waitingGraph = { rootTaskId: scope.rootTaskId, item: { id: "graph", revision: 13, content: {} },
  snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", rootSuccessCriteria: [], nodes: [...prefix, gateNode] },
  state: graphState, tasks: new Map() }
const preparedTransition = { scope: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
  rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }, itemId: "graph", taskId: "gate-task",
  expectedRevision: 13, snapshot: waitingGraph.snapshot, event: { type: "task.gate_choice_resumed" },
  state: { revision: 14, nodes: [], appliedEvents: [...graphState.appliedEvents, {
    type: "task.gate_choice_resumed", nodeKey: "gate", idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "gate", 1, "task.gate_choice_resumed"),
    expectedRevision: 13, gateTaskId: "gate-task", requestAttemptCount: 1, resumedAttemptCount: 2,
  }] }, duplicate: false }

function database(status: "waiting_for_user" | "queued" | "running" = "waiting_for_user", attemptCount = 1,
  options: { deadlineLive?: boolean; expireAfterChecks?: number } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const state = { acknowledged: false, requeued: false, enqueued: false }
  let deadlineChecks = 0
  let beforeTransaction: typeof state | null = null
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    if (sql === "BEGIN") { beforeTransaction = { ...state }; return { rows: [], rowCount: 1 } }
    if (sql === "COMMIT") return { rows: [], rowCount: 1 }
    if (sql === "ROLLBACK") {
      if (beforeTransaction) Object.assign(state, beforeTransaction)
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('SELECT 1 FROM "sub_agent_tasks"')) {
      deadlineChecks += 1
      const live = options.expireAfterChecks === undefined
        ? options.deadlineLive !== false : deadlineChecks <= options.expireAfterChecks
      return { rows: live ? [{}] : [], rowCount: live ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: scope.sessionId, status: "active" }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: scope.turnId, status: "in_progress", leaseOwnerId: scope.turnLeaseOwner,
      leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date("2026-10-23T10:10:00Z"), leaseValid: true }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('task."role"')) return { rows: [{ id: "gate-task", sessionId: scope.sessionId,
      turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, status, attemptCount,
      maxAttempts: 3, role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA,
      allowedActions: [], result: status === "waiting_for_user" ? result : null, failureReason: null,
      leaseOwner: status === "running" ? "gate-owner" : null, leaseExpiresAt: status === "running" ? new Date("2026-10-23T10:05:00Z") : null,
      interruptRequestedAt: null }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: [{ id: scope.rootTaskId, status: "running", leaseOwner: scope.parentLeaseOwner,
      attemptCount: scope.parentAttemptCount, interruptRequestedAt: null, leaseValid: true }], rowCount: 1 }
    if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: executionOwner.executionId, status: "running", attemptCount: executionOwner.executionAttemptCount,
      state: {} }], rowCount: 1 }
    if (sql.includes('FROM "agent_items" AS item')) return { rows: [{ id: `agent-wait:question:${waitId}`, stepId: "question-step", taskId: scope.rootTaskId,
      type: "question", status: "completed", content: answeredContent, stepStatus: "waiting_for_user" }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_steps"')) return { rows: [{ id: "question-step" }], rowCount: 1 }
    if (sql.includes('UPDATE "sub_agent_tasks"')) { state.requeued = true; return { rows: [{ id: "gate-task" }], rowCount: 1 } }
    return { rows: [], rowCount: 0 }
  })
  return { calls, client: { query, release: vi.fn() }, pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) }, state }
}

function resumeInput(requestAttemptCount = 1) {
  return { scope, executionOwner, gateTaskId: "gate-task", requestAttemptCount, waitId, now: new Date("2026-10-23T10:00:00Z") }
}

describe("scheduled Gate answer resume command", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.load.mockResolvedValue(waitingGraph)
    mocks.readCandidate.mockResolvedValue({ question, binding })
    mocks.match.mockResolvedValue("pending")
    mocks.acknowledge.mockResolvedValue({ kind: "weak_cover_letter", jobIds: ["job-1"], choiceId: "continue" })
    mocks.prepare.mockResolvedValue(preparedTransition)
    mocks.persist.mockResolvedValue(preparedTransition.state)
    mocks.enqueue.mockResolvedValue(undefined)
  })

  it("atomically acknowledges a private answer, resumes only the same Gate, and enqueues its next generation", async () => {
    const db = database()
    await expect(resumeScheduledGateChoice(db.client as never, resumeInput())).resolves.toEqual({
      status: "accepted", taskId: "gate-task", requestAttemptCount: 1, resumedAttemptCount: 2,
      revision: 14, readyTaskIds: ["gate-task"],
    })
    expect(mocks.readCandidate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestAttemptCount: 0, gateTaskId: "gate-task" }))
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      gateTaskId: "gate-task", requestAttemptCount: 1, resumedAttemptCount: 2, waitId,
      itemId: `agent-wait:question:${waitId}`, binding,
    }))
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "task.gate_choice_resumed",
      attemptCount: 1, gateChoiceResume: { gateTaskId: "gate-task", requestAttemptCount: 1, resumedAttemptCount: 2 } }))
    expect(mocks.persist).toHaveBeenCalledOnce()
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rootTaskId: scope.rootTaskId }), "gate-task")
    expect(db.calls.filter(call => call.sql.includes('UPDATE "sub_agent_tasks"'))).toHaveLength(1)
    expect(db.calls.some(call => call.sql.includes('UPDATE "agent_steps"'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes("choiceId") || call.sql.includes("answer"))).toBe(false)
  })

  it("replays an exact acknowledgement without another transition or outbox write", async () => {
    const replayGraph = { ...waitingGraph, state: { ...preparedTransition.state, revision: 14,
      nodes: [...prefix.map(node => ({ ...node, status: "completed" })), {
        key: "gate", taskId: "gate-task", status: "queued",
      }] },
      snapshot: { ...waitingGraph.snapshot, nodes: [...prefix, { ...gateNode, status: "queued", readiness: "ready" }] } }
    mocks.load.mockResolvedValue(replayGraph)
    mocks.readCandidate.mockResolvedValue({ question, binding })
    mocks.match.mockResolvedValue("pending")
    mocks.acknowledge.mockResolvedValue({ kind: "weak_cover_letter", jobIds: ["job-1"], choiceId: "continue" })
    const dbWithAck = database("queued", 1)
    await expect(resumeScheduledGateChoice(dbWithAck.client as never, resumeInput())).resolves.toMatchObject({ status: "duplicate", readyTaskIds: ["gate-task"] })
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(dbWithAck.calls.some(call => /^\s*UPDATE\b/i.test(call.sql))).toBe(false)
  })

  it("rejects a stale or mismatched question before acknowledging or changing lifecycle state", async () => {
    const db = database()
    mocks.readCandidate.mockResolvedValue({ question, binding: { ...binding, gateAttempt: 2 } })
    await expect(resumeScheduledGateChoice(db.client as never, resumeInput())).rejects.toMatchObject({ code: "scheduled_gate_resume_question" })
    expect(mocks.acknowledge).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(db.calls.some(call => /^\s*UPDATE\b/i.test(call.sql))).toBe(false)
  })

  it("does not acknowledge an answer after the database-clock deadline", async () => {
    const db = database("waiting_for_user", 1, { deadlineLive: false })
    await expect(resumeScheduledGateChoice(db.client as never, resumeInput())).rejects.toMatchObject({ code: "scheduled_gate_resume_deadline" })
    expect(mocks.acknowledge).not.toHaveBeenCalled()
    expect(db.calls.some(call => call.sql.includes('"absoluteDeadlineAt" > clock_timestamp()'))).toBe(true)
    expect(db.calls.some(call => call.sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("rolls back the answer acknowledgement and Gate requeue when the deadline crosses during resume", async () => {
    const db = database("waiting_for_user", 1, { expireAfterChecks: 1 })
    mocks.acknowledge.mockImplementationOnce(async () => {
      db.state.acknowledged = true
      return { kind: "weak_cover_letter", jobIds: ["job-1"], choiceId: "continue" }
    })
    mocks.enqueue.mockImplementationOnce(async () => { db.state.enqueued = true })

    await expect(transaction(db.pool as never, client => resumeScheduledGateChoice(client, resumeInput())))
      .rejects.toMatchObject({ code: "scheduled_gate_resume_deadline" })

    expect(db.state).toEqual({ acknowledged: false, requeued: false, enqueued: false })
    expect(db.calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(db.calls.map(call => call.sql)).not.toContain("COMMIT")
  })
})
