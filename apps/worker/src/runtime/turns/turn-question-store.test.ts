import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { SessionPauseRequestedError, OPEN_SESSION, SESSION_WORK_ADMISSION } from "../session-gate.js"
import { buildTurnQuestionScheduledChoiceBinding, createTurnScheduledPrepareChoiceContent, scheduledAnalyzeCheckpointEvidence, TurnQuestionStoreError,
  turnScheduledPrepareChoiceWaitId, type TurnQuestionIntentEnvelope } from "./turn-question-contract.js"
import { createPgTurnQuestionStore } from "./turn-question-store.js"
import { questionId, questionItemId, type TurnQuestionPool } from "./turn-question-store-guards.js"
import { appendTurnQuestionPlanningObservation, prepareTurnQuestionPlanningObservation } from "./turn-question-planning-store.js"
import { readTurnQuestionPlanningWait } from "./turn-question-planning-history.js"
import type { TurnQuestionPlanningReceipt } from "./turn-question-planning-contract.js"

vi.mock("./turn-question-planning-store.js", () => ({ prepareTurnQuestionPlanningObservation: vi.fn(), appendTurnQuestionPlanningObservation: vi.fn() }))
vi.mock("./turn-question-planning-history.js", () => ({ readTurnQuestionPlanningWait: vi.fn() }))

const now = new Date("2026-10-06T10:00:00.000Z")
const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 3, leaseExpiresAt: new Date("2026-10-06T10:01:00.000Z"),
}
const stepId = "step-1", toolCallId = "call-1"
const intent: TurnQuestionIntentEnvelope = {
  schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input",
  question: "Which work authorization do you have?", options: [{ label: "EU", value: "eu" }],
}
const callContent = { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null,
  input: { question: intent.question, choices: intent.options } }
const resultContent = { toolCallId, output: intent, errorCode: null }

const scheduledSnapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"], targetLocations: ["Dublin"],
  minScore: 70, dailyCap: 10, requireApproval: true, autoApply: false }
const scheduledOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: 1, turnLeaseOwnerId: owner.ownerId, turnLeaseVersion: owner.leaseVersion, executionId: "execution-1", executionAttemptCount: 2 }
const scheduledContinuation = { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
  key: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
  snapshotDigest: `sha256:${createHash("sha256").update(JSON.stringify([scheduledSnapshot.schemaVersion, scheduledSnapshot.targetRoles, scheduledSnapshot.targetLocations,
    scheduledSnapshot.minScore, scheduledSnapshot.dailyCap, scheduledSnapshot.requireApproval, scheduledSnapshot.autoApply]), "utf8").digest("hex")}`,
  evidenceDigest: "b".repeat(64), graphRevision: 2, owner: scheduledOwner }
const scheduledCheckpointState = { nextStage: "prepare", scoutedJobs: [{ id: "job-1", userId: owner.userId }],
  scoredJobs: [{ job: { id: "job-1", userId: owner.userId }, score: 82, matchedKeywords: ["TypeScript"], missingKeywords: ["PostgreSQL"],
    recommendation: "Apply after tailoring.", analysisFenceAt: "2026-10-06T10:00:00.000Z" }], analysisFailed: 0,
  scheduledTaskGraphContinuation: scheduledContinuation }
const scheduledCheckpointEvidence = scheduledAnalyzeCheckpointEvidence(scheduledCheckpointState)!
const scheduledReceipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1", owner: scheduledOwner,
  continuationKey: scheduledContinuation.key, snapshotDigest: scheduledContinuation.snapshotDigest, evidenceDigest: scheduledContinuation.evidenceDigest,
  checkpointDigest: scheduledCheckpointEvidence.checkpointDigest, analyzeGraphRevision: 2, prepareScheduleRevision: 3 }
const scheduledFinalStepId = "final-step-1", scheduledFinalStepOrdinal = 4
const scheduledBinding = buildTurnQuestionScheduledChoiceBinding({ receipt: scheduledReceipt, finalStepId: scheduledFinalStepId, finalStepOrdinal: scheduledFinalStepOrdinal })!
const scheduledWaitId = turnScheduledPrepareChoiceWaitId(scheduledBinding)!

function scheduledChoiceFixture(options: { turnStatus?: string; stepStatus?: string; itemStatus?: string; itemContent?: unknown; candidateUsage?: unknown } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  let sequence = 0
  const candidateUsage = options.candidateUsage === undefined ? { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 } : options.candidateUsage
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes(SESSION_WORK_ADMISSION)) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT session."id" FROM "agent_sessions" AS session')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId, status: options.turnStatus ?? "in_progress", revision: 4 }], rowCount: 1 }
    if (sql.includes('event."type" = $4') && sql.includes('root."attemptCount"')) return { rows: [{ itemId: null, taskId: owner.rootTaskId, actor: "orchestrator",
      correlationId: scheduledFinalStepId, idempotencyKey: `scheduled-candidate:${owner.rootTaskId}:1:${scheduledFinalStepId}`,
      payload: { schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v2", sessionId: owner.sessionId, turnId: owner.turnId,
        rootTaskId: owner.rootTaskId, rootAttemptCount: 1, finalStepId: scheduledFinalStepId, finalStepOrdinal: scheduledFinalStepOrdinal, stepAttempt: 1, candidateText: "final",
        finishReason: "stop", usage: candidateUsage },
      stepTaskId: owner.rootTaskId, ordinal: scheduledFinalStepOrdinal, attempt: 1, stepStatus: options.stepStatus ?? "streaming", attemptCount: 1, rootStatus: "running" }], rowCount: 1 }
    if (sql.includes('execution."attemptCount"')) return { rows: [{ source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: scheduledSnapshot }, id: "execution-1", attemptCount: 2,
      status: "running", state: scheduledCheckpointState }], rowCount: 1 }
    if (sql.includes('FROM "agent_items"') && sql.includes('WHERE "id" = $1')) return options.itemStatus
      ? { rows: [{ id: `agent-wait:question:${scheduledWaitId}`, stepId: scheduledFinalStepId, taskId: owner.taskId, type: "question",
        status: options.itemStatus, content: options.itemContent }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_steps"') && sql.includes('WHERE "id" = $1')) return { rows: [{ id: scheduledFinalStepId, status: options.stepStatus ?? "streaming",
      taskId: owner.taskId, attempt: 1, finishReason: options.stepStatus === "waiting_for_user" ? "stop" : null, errorCode: null,
      inputTokens: options.stepStatus === "waiting_for_user" ? 7 : 0, outputTokens: options.stepStatus === "waiting_for_user" ? 3 : 0,
      estimatedCostUsd: options.stepStatus === "waiting_for_user" ? 0.02 : 0 }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes('ORDER BY "sequence" DESC LIMIT 1')) return { rows: [{ id: "previous-event" }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = $2')) return { rows: [], rowCount: 0 }
    if (sql.includes('UPDATE "agent_sessions" SET "eventSequence"')) return { rows: [{ eventSequence: String(++sequence) }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_steps"')) return { rows: [], rowCount: 1 }
    if (sql.includes('UPDATE "agent_turns" SET "status"')) return { rows: [{ revision: 5 }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_items"') || sql.includes('INSERT INTO "agent_events"') || sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
    throw new Error(`unexpected_scheduled_choice_query:${sql}`)
  }), release: vi.fn() }
  return { calls, store: createPgTurnQuestionStore({ connect: vi.fn(async () => client) } as unknown as TurnQuestionPool) }
}

type Fixture = {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }>
  readonly client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
  readonly store: ReturnType<typeof createPgTurnQuestionStore>
}
type FixtureOptions = {
  readonly turnStatus?: string
  readonly stepStatus?: string
  readonly stepFinishReason?: string | null
  readonly itemStatus?: string | null
  readonly itemContent?: Record<string, unknown>
  readonly callInput?: unknown
  readonly callStatus?: string
  readonly callRowStatus?: string
  readonly callContentStatus?: string | null
  readonly callErrorCode?: string | null
  readonly callContentPatch?: Record<string, unknown>
  readonly hasResult?: boolean
  readonly resultStatus?: string
  readonly resultOutput?: unknown
  readonly resultContentPatch?: Record<string, unknown>
  readonly pauseAdmission?: boolean
  readonly pauseEvents?: boolean
  readonly stepErrorCode?: string | null
  readonly failure?: { readonly includes: string; readonly error: Error }
}

function fixture(options: FixtureOptions = {}): Fixture {
  vi.mocked(prepareTurnQuestionPlanningObservation).mockReset().mockResolvedValue(null)
  vi.mocked(appendTurnQuestionPlanningObservation).mockReset().mockResolvedValue(undefined)
  vi.mocked(readTurnQuestionPlanningWait).mockReset().mockResolvedValue(null)
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  let sequence = 0
  let stepStatus = options.stepStatus ?? "streaming"
  let stepFinishReason = options.stepFinishReason === undefined ? "tool_calls" : options.stepFinishReason
  let stepInputTokens: string | number = stepFinishReason === null ? 0 : 12, stepOutputTokens: string | number = stepFinishReason === null ? 0 : 4, stepCost: string | number = stepFinishReason === null ? 0 : 0.001
  const persistedCallContent: Record<string, unknown> = { ...callContent, input: options.callInput ?? callContent.input,
    status: options.callContentStatus ?? callContent.status, errorCode: options.callErrorCode === undefined ? callContent.errorCode : options.callErrorCode,
    ...(options.callContentPatch ?? {}) }
  if (options.callContentStatus === null) { delete persistedCallContent.status; delete persistedCallContent.errorCode }
  let stepErrorCode = options.stepErrorCode ?? null
  const id = questionId(owner, stepId, toolCallId)
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (options.failure && sql.includes(options.failure.includes)) throw options.failure.error
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes(SESSION_WORK_ADMISSION)) return options.pauseAdmission ? { rows: [], rowCount: 0 } : { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT session."id" FROM "agent_sessions" AS session')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId, status: options.turnStatus ?? "in_progress", revision: 7 }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ allowedActions: [], leaseOwner: owner.ownerId, attemptCount: 1 }], rowCount: 1 }
      if (sql.includes('FROM "agent_items" AS callItem')) return { rows: [{
        stepId, ordinal: 1, stepStatus, stepErrorCode, finishReason: stepFinishReason, inputTokens: stepInputTokens, outputTokens: stepOutputTokens,
        estimatedCostUsd: stepCost, callItemId: "call-item-1", resultCount: options.hasResult === false ? 0 : 1,
        callStatus: options.callStatus ?? "completed", callContent: persistedCallContent,
        resultItemId: options.hasResult === false ? null : "result-item-1", resultStatus: options.hasResult === false ? null : options.resultStatus ?? "completed",
        resultContent: options.hasResult === false ? null : { ...resultContent, output: options.resultOutput ?? intent, ...(options.resultContentPatch ?? {}) },
      }], rowCount: 1 }
      if (sql.includes('WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE')) {
        if (options.itemStatus === undefined || options.itemStatus === null) return { rows: [], rowCount: 0 }
        return { rows: [{ id: questionItemId(id), stepId, taskId: owner.taskId, type: "question", status: options.itemStatus,
          content: options.itemContent ?? { waitKind: "question", questionId: id, toolCallId, stage: "user_input", question: intent.question, options: intent.options, answer: null, answerAvailable: false } }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_items"') && sql.includes("'tool_call'")) return { rows: [{ id: "call-item-1", status: options.callRowStatus ?? "completed", content: persistedCallContent }], rowCount: 1 }
      if (sql.includes('FROM "agent_items"') && sql.includes("'tool_result'")) return options.hasResult === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "result-item-1", status: options.resultStatus ?? "completed", content: { ...resultContent, output: options.resultOutput ?? intent, ...(options.resultContentPatch ?? {}) } }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: stepId, status: stepStatus, errorCode: stepErrorCode, taskId: owner.taskId, attempt: 1,
        finishReason: stepFinishReason, inputTokens: stepInputTokens, outputTokens: stepOutputTokens, estimatedCostUsd: stepCost }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_steps" SET "finishReason"')) {
        stepFinishReason = String(values?.[0]); stepInputTokens = Number(values?.[1]); stepOutputTokens = Number(values?.[2]); stepCost = Number(values?.[3])
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_steps" SET "status"')) {
        stepStatus = values?.[1] === "session_pause_requested" ? "interrupted" : "waiting_for_user"
        stepFinishReason = String(values?.[0]); stepErrorCode = values?.[1] == null ? null : String(values[1])
        stepInputTokens = Number(values?.[2]); stepOutputTokens = Number(values?.[3]); stepCost = Number(values?.[4])
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns" SET "status"')) return { rows: [{ revision: 8 }], rowCount: 1 }
      if (sql.includes('SELECT COUNT(*) AS "count"')) return { rows: [{ count: 1 }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_sessions" SET "eventSequence"')) return { rows: [{ eventSequence: ++sequence }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_items"')) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE "agent_items"')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = ANY')) {
        if (!options.pauseEvents) return { rows: [], rowCount: 0 }
        const base = `turn:${owner.turnId}:event:question-pause:${id}`
        const callEventId = `agent-question-pause-call-${id}`, itemEventId = `agent-question-pause-item-${id}`, stepEventId = `agent-question-pause-step-${id}`
        return { rows: [
          { id: callEventId, itemId: "call-item-1", type: "tool_call.failed", actor: "orchestrator", correlationId: toolCallId, causationId: null,
            idempotencyKey: `${base}:call`, payload: { toolCallId, toolName: "agent.ask_user", status: "cancelled", errorCode: null, taskId: owner.taskId } },
          { id: itemEventId, itemId: "call-item-1", type: "item.delta", actor: "orchestrator", correlationId: "call-item-1", causationId: callEventId,
            idempotencyKey: `${base}:item`, payload: { itemId: "call-item-1", status: "interrupted", content: { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "cancelled", errorCode: null } } },
          { id: stepEventId, itemId: null, type: "step.completed", actor: "orchestrator", correlationId: stepId, causationId: itemEventId,
            idempotencyKey: `${base}:step`, payload: { stepId, status: "interrupted", errorCode: "session_pause_requested", toolCallCount: 1, taskId: owner.taskId } },
        ], rowCount: 3 }
      }
      if (sql.includes('FROM "agent_events"')) return { rows: [], rowCount: 0 }
      if (sql.includes('INSERT INTO "agent_events"') || sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as TurnQuestionPool
  return { calls, client, store: createPgTurnQuestionStore(pool) }
}

describe("PostgreSQL native question store", () => {
  it("atomically writes the question, absolute Step usage, wait state, events, and outboxes", async () => {
    const f = fixture()
    const receipt = await f.store.waitForQuestion({ owner, stepId, toolCallId, now })
    const sessionLock = f.calls.find(call => call.sql.includes('FROM "agent_sessions" AS session'))
    expect(sessionLock?.sql).toContain(OPEN_SESSION)
    expect(sessionLock?.sql).toContain('session."id" = $1 AND session."userId" = $2')
    expect(receipt).toEqual({ status: "waiting_for_user", disposition: "created", waitId: questionId(owner, stepId, toolCallId),
      itemId: questionItemId(questionId(owner, stepId, toolCallId)), turnId: owner.turnId, toolCallId, nextTurnRevision: 8 })
    const questionInsert = f.calls.find(call => call.sql.includes('INSERT INTO "agent_items"'))
    expect(JSON.parse(String(questionInsert?.values?.[5]))).toMatchObject({
      waitKind: "question", questionId: receipt.waitId, toolCallId, stage: "user_input", question: intent.question,
      options: intent.options, answer: null, answerAvailable: false,
    })
    const stepUpdate = f.calls.find(call => call.sql.includes('UPDATE "agent_steps" SET "status"'))
    expect(stepUpdate?.values?.slice(0, 4)).toEqual(["tool_calls", 12, 4, 0.001])
    expect(f.calls.find(call => call.sql.includes('UPDATE "agent_turns" SET "status"'))?.sql).toContain('"revision" = "revision" + 1')
    const itemEvent = f.calls.find(call => call.sql.includes('INSERT INTO "agent_events"') && call.values?.[6] === "item.started")
    expect(itemEvent?.values?.slice(6, 10)).toEqual(["item.started", receipt.itemId, receipt.waitId, `agent-wait:${receipt.itemId}:started`])
    expect(JSON.parse(String(itemEvent?.values?.[10]))).toEqual({ itemId: receipt.itemId, waitKind: "question", questionId: receipt.waitId, toolCallId })
    const committed = f.calls.findIndex(call => call.sql === "COMMIT")
    expect(committed).toBeGreaterThan(f.calls.findIndex(call => call.sql.includes('INSERT INTO "agent_outbox"')))
    expect(f.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(2)
    expect(f.calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toHaveLength(2)
  })

  it("stages real usage as an absolute idempotent value and rejects changed replay", async () => {
    const f = fixture({ stepFinishReason: null, callRowStatus: "started" })
    const input = { owner, stepId, toolCallId, finishReason: "tool_calls", usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 }, now }
    await f.store.stageQuestionUsage(input)
    await f.store.stageQuestionUsage(input)
    expect(f.calls.filter(call => call.sql.includes('UPDATE "agent_steps" SET "finishReason"'))).toHaveLength(1)
    await expect(f.store.stageQuestionUsage({ ...input, usage: { ...input.usage, inputTokens: 13 } })).rejects.toMatchObject({ code: "question_conflict" })
  })

  it("replays an answered question without recreating or re-waiting it", async () => {
    const id = questionId(owner, stepId, toolCallId)
    const f = fixture({ turnStatus: "in_progress", stepStatus: "waiting_for_user", itemStatus: "completed",
      itemContent: { waitKind: "question", questionId: id, toolCallId, stage: "user_input", question: intent.question, options: intent.options, answer: "EU", answerAvailable: true } })
    await expect(f.store.waitForQuestion({ owner, stepId, toolCallId, now })).resolves.toMatchObject({ status: "answered", disposition: "replayed", nextTurnRevision: 7 })
    expect(f.calls.some(call => call.sql.includes('INSERT INTO "agent_items"') || call.sql.includes('UPDATE "agent_turns"')
      || call.sql.includes('INSERT INTO "agent_events"') || call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("replays an unanswered committed wait without another revision or publication", async () => {
    const id = questionId(owner, stepId, toolCallId)
    const f = fixture({ turnStatus: "waiting_for_user", stepStatus: "waiting_for_user", itemStatus: "started",
      itemContent: { waitKind: "question", questionId: id, toolCallId, stage: "user_input", question: intent.question, options: intent.options, answer: null, answerAvailable: false } })
    await expect(f.store.waitForQuestion({ owner, stepId, toolCallId, now })).resolves.toMatchObject({ status: "waiting_for_user", disposition: "replayed", nextTurnRevision: 7 })
    expect(readTurnQuestionPlanningWait).toHaveBeenCalledWith(f.client, { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId },
      { stepId, toolCallId, waitId: id, questionItemId: questionItemId(id) })
    expect(f.calls.some(call => call.sql.includes('INSERT INTO "agent_items"') || call.sql.includes('UPDATE "agent_turns"')
      || call.sql.includes('INSERT INTO "agent_events"') || call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("appends a prepared planning observation only after the wait and lifecycle events are written", async () => {
    const f = fixture()
    const waitId = questionId(owner, stepId, toolCallId)
    const prepared: TurnQuestionPlanningReceipt = { schemaVersion: "agent-harness.v2.plan-clarification.v1", sessionId: owner.sessionId,
      turnId: owner.turnId, rootTaskId: owner.rootTaskId, stepId, toolCallId, waitId, questionItemId: questionItemId(waitId),
      observedPlanRevision: null, graphRevisionAtAsk: 0, pendingSteers: [], inputCheckpoint: { throughSequence: "0", consumedInputIds: [] } }
    vi.mocked(prepareTurnQuestionPlanningObservation).mockResolvedValue(prepared)
    vi.mocked(appendTurnQuestionPlanningObservation).mockImplementation(async () => { f.calls.push({ sql: "planning clarification receipt", values: [] }) })
    await f.store.waitForQuestion({ owner, stepId, toolCallId, now })
    const questionInsert = f.calls.findIndex(call => call.sql.includes('INSERT INTO "agent_items"'))
    const turnWait = f.calls.findIndex(call => call.sql.includes('UPDATE "agent_turns" SET "status"'))
    const itemStarted = f.calls.findIndex(call => call.values?.[6] === "item.started")
    const observation = f.calls.findIndex(call => call.sql === "planning clarification receipt")
    expect(vi.mocked(prepareTurnQuestionPlanningObservation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(appendTurnQuestionPlanningObservation).mock.invocationCallOrder[0]!)
    expect(observation).toBeGreaterThan(Math.max(questionInsert, turnWait, itemStarted))
    expect(appendTurnQuestionPlanningObservation).toHaveBeenCalledWith(f.client, prepared, owner.userId)
  })

  it("rolls the complete question wait back when appending its planning observation fails", async () => {
    const f = fixture()
    const waitId = questionId(owner, stepId, toolCallId)
    const prepared: TurnQuestionPlanningReceipt = { schemaVersion: "agent-harness.v2.plan-clarification.v1", sessionId: owner.sessionId,
      turnId: owner.turnId, rootTaskId: owner.rootTaskId, stepId, toolCallId, waitId, questionItemId: questionItemId(waitId),
      observedPlanRevision: null, graphRevisionAtAsk: 0, pendingSteers: [], inputCheckpoint: { throughSequence: "0", consumedInputIds: [] } }
    const error = new Error("planning observation append failed")
    vi.mocked(prepareTurnQuestionPlanningObservation).mockResolvedValue(prepared)
    vi.mocked(appendTurnQuestionPlanningObservation).mockRejectedValue(error)
    await expect(f.store.waitForQuestion({ owner, stepId, toolCallId, now })).rejects.toBe(error)
    expect(f.calls.some(call => call.sql.includes('INSERT INTO "agent_items"'))).toBe(true)
    expect(f.calls.some(call => call.sql.includes('UPDATE "agent_steps" SET "status"'))).toBe(true)
    expect(f.calls.some(call => call.sql.includes('UPDATE "agent_turns" SET "status"'))).toBe(true)
    expect(f.calls.filter(call => call.sql === "ROLLBACK")).toHaveLength(1)
    expect(f.calls.filter(call => call.sql === "COMMIT")).toHaveLength(0)
  })

  it.each([
    ["prepared", "in_progress", "streaming", null, undefined],
    ["waiting", "waiting_for_user", "waiting_for_user", "started", undefined],
    ["answered", "in_progress", "waiting_for_user", "completed", { answer: "EU", answerAvailable: true }],
    ["closed", "in_progress", "interrupted", "interrupted", { answer: null, answerAvailable: false }],
  ] as const)("recovers %s without inventing usage or losing same-Turn lineage", async (status, turnStatus, stepStatus, itemStatus, answer) => {
    const id = questionId(owner, stepId, toolCallId)
    const base = { waitKind: "question", questionId: id, toolCallId, stage: "user_input", question: intent.question, options: intent.options, answer: null, answerAvailable: false }
    const f = fixture({ turnStatus, stepStatus, itemStatus: itemStatus ?? null, itemContent: { ...base, ...(answer ?? {}) } })
    await expect(f.store.readPendingQuestion({ owner, now })).resolves.toMatchObject({ status, stepId, toolCallId, waitId: id, itemId: questionItemId(id) })
  })

  it("fails closed for missing durable usage or malformed owned receipts", async () => {
    const noUsage = fixture({ stepFinishReason: null })
    await expect(noUsage.store.readPendingQuestion({ owner, now })).rejects.toMatchObject({ code: "question_usage_unavailable" })
    const malformed = fixture({ resultOutput: { ...intent, unexpectedAuthority: true } })
    await expect(malformed.store.readPendingQuestion({ owner, now })).rejects.toMatchObject({ code: "question_receipt_malformed" })
    const interrupted = fixture({ itemStatus: "interrupted", itemContent: { waitKind: "question", questionId: "foreign", toolCallId, stage: "user_input", question: intent.question, options: intent.options, answer: null, answerAvailable: false } })
    await expect(interrupted.store.waitForQuestion({ owner, stepId, toolCallId, now })).rejects.toMatchObject({ code: "question_conflict" })
  })

  it.each(["wait", "recovery"] as const)("binds the completed result to original arguments on %s", async operation => {
    const mismatched = fixture({ resultOutput: { ...intent, question: "A different question" } })
    const malformed = fixture({ callInput: { question: intent.question, choices: intent.options, ownerId: "model-forged" } })
    const run = (f: Fixture) => operation === "wait"
      ? f.store.waitForQuestion({ owner, stepId, toolCallId, now })
      : f.store.readPendingQuestion({ owner, now })
    await expect(run(mismatched)).rejects.toMatchObject({ code: "question_conflict" })
    await expect(run(malformed)).rejects.toMatchObject({ code: "question_receipt_malformed" })
  })

  it("ignores only the exact pre-intent pause interruption and fails closed on uncertain calls", async () => {
    const paused = fixture({ callStatus: "interrupted", callRowStatus: "interrupted", callContentStatus: "cancelled", callErrorCode: null,
      hasResult: false, stepStatus: "interrupted", stepErrorCode: "session_pause_requested", pauseEvents: true })
    await expect(paused.store.readPendingQuestion({ owner, now })).resolves.toEqual({ status: "none" })
    const forged = fixture({ callStatus: "interrupted", callRowStatus: "interrupted", callContentStatus: "cancelled", callErrorCode: null,
      hasResult: false, stepStatus: "interrupted", stepErrorCode: "session_pause_requested" })
    await expect(forged.store.readPendingQuestion({ owner, now })).rejects.toMatchObject({ code: "question_receipt_malformed" })
    const uncertain = fixture({ callStatus: "started", callContentStatus: "started", hasResult: false })
    await expect(uncertain.store.readPendingQuestion({ owner, now })).rejects.toMatchObject({ code: "question_receipt_missing" })
  })

  it("cancels only the exact initial step shape atomically with real output usage", async () => {
    const f = fixture({ callRowStatus: "started", callContentStatus: null, callStatus: "started", hasResult: false, stepFinishReason: null })
    const input = { owner, stepId, toolCallId, callArguments: { question: intent.question, choices: intent.options }, finishReason: "tool_calls",
      usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 }, now }
    await expect(f.store.cancelPausedQuestion(input)).resolves.toBe("cancelled")
    const stepUpdate = f.calls.find(call => call.sql.includes('UPDATE "agent_steps" SET "status"'))
    expect(stepUpdate?.values?.slice(0, 6)).toEqual(["tool_calls", "session_pause_requested", 12, 4, 0.001, now])
    expect(f.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(3)
    expect(f.calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toHaveLength(3)
    expect(f.calls.findIndex(call => call.sql === "COMMIT")).toBeGreaterThan(f.calls.findIndex(call => call.sql.includes('INSERT INTO "agent_outbox"')))
    const payloads = f.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"')).map(call => String(call.values?.[10]))
    expect(payloads.join(" ")).not.toContain(intent.question)
    expect(f.calls.some(call => call.sql.includes('INSERT INTO "agent_items"') || call.sql.includes('UPDATE "agent_turns"'))).toBe(false)
  })

  it("cancels an exact partial result without publishing a question", async () => {
    const f = fixture({ callRowStatus: "started", callContentStatus: null, callStatus: "started", resultStatus: "started" })
    const input = { owner, stepId, toolCallId, callArguments: { question: intent.question, choices: intent.options }, finishReason: "tool_calls",
      usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 }, now }
    await expect(f.store.cancelPausedQuestion(input)).resolves.toBe("cancelled")
    expect(f.calls.some(call => call.sql.includes('UPDATE "agent_items"') && call.sql.includes("'tool_result'"))).toBe(true)
    expect(f.calls.find(call => call.sql.includes('UPDATE "agent_items"') && call.sql.includes("'tool_result'"))?.values?.[0]).toContain('"status":"cancelled"')
    expect(f.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(4)
    expect(f.calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toHaveLength(4)
  })

  it("keeps complete receipts prepared and rejects a change to already-staged usage", async () => {
    const prepared = fixture()
    await expect(prepared.store.cancelPausedQuestion({ owner, stepId, toolCallId, callArguments: { question: intent.question, choices: intent.options },
      finishReason: "tool_calls", usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 }, now })).resolves.toBe("prepared")
    expect(prepared.calls.some(call => call.sql.includes('UPDATE "agent_steps"') || call.sql.includes('INSERT INTO "agent_events"'))).toBe(false)
    const changed = fixture({ callRowStatus: "started", callContentStatus: null, callStatus: "started", hasResult: false, stepFinishReason: "tool_calls" })
    await expect(changed.store.cancelPausedQuestion({ owner, stepId, toolCallId, callArguments: { question: intent.question, choices: intent.options },
      finishReason: "tool_calls", usage: { inputTokens: 13, outputTokens: 4, estimatedCostUsd: 0.001 }, now })).rejects.toMatchObject({ code: "question_conflict" })
    expect(changed.calls.some(call => call.sql.includes('UPDATE "agent_steps"'))).toBe(false)
  })

  it.each([
    [{ callContentPatch: { toolVersion: "2" } }, { resultContentPatch: {} }],
    [{ callContentPatch: { unexpected: true } }, { resultContentPatch: {} }],
    [{ callContentPatch: {} }, { resultContentPatch: { unexpected: true } }],
  ])("rejects completed receipts with an unknown version or outer envelope fields", async (call, result) => {
    const malformed = fixture({ ...call, ...result })
    const input = { owner, stepId, toolCallId, callArguments: { question: intent.question, choices: intent.options }, finishReason: "tool_calls",
      usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 }, now }
    await expect(malformed.store.cancelPausedQuestion(input)).rejects.toMatchObject({ code: "question_receipt_malformed" })
    await expect(malformed.store.waitForQuestion({ owner, stepId, toolCallId, now })).rejects.toMatchObject({ code: "question_receipt_missing" })
    await expect(malformed.store.readPendingQuestion({ owner, now })).rejects.toMatchObject({ code: "question_receipt_missing" })
    expect(malformed.calls.some(callRow => callRow.sql.includes('UPDATE "agent_steps"'))).toBe(false)
  })

  it("preserves pause and database errors and rolls back before any partial commit", async () => {
    const paused = fixture({ pauseAdmission: true })
    await expect(paused.store.stageQuestionUsage({ owner, stepId, toolCallId, finishReason: "tool_calls", usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 }, now })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(paused.calls.filter(call => call.sql === "ROLLBACK")).toHaveLength(1)
    expect(paused.calls.some(call => call.sql.includes('UPDATE "agent_steps"'))).toBe(false)

    const dbError = new Error("connection interrupted")
    const failed = fixture({ failure: { includes: 'INSERT INTO "agent_items"', error: dbError } })
    await expect(failed.store.waitForQuestion({ owner, stepId, toolCallId, now })).rejects.toBe(dbError)
    expect(failed.calls.filter(call => call.sql === "ROLLBACK")).toHaveLength(1)
    expect(failed.calls.filter(call => call.sql === "COMMIT")).toHaveLength(0)
  })
})

describe("PostgreSQL scheduled Prepare choice", () => {
  it("derives the wait ID and atomically stores the null-tool-call question with final model usage", async () => {
    const f = scheduledChoiceFixture()
    const receipt = await f.store.waitForQuestion({ owner, stepId: "current-resumed-step", toolCallId: null, expectedWaitId: scheduledWaitId,
      finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }, now })
    expect(receipt).toEqual({ status: "waiting_for_user", disposition: "created", waitId: scheduledWaitId,
      itemId: `agent-wait:question:${scheduledWaitId}`, turnId: owner.turnId, toolCallId: null, nextTurnRevision: 5 })
    const item = f.calls.find(call => call.sql.includes('INSERT INTO "agent_items"'))
    expect(JSON.parse(String(item?.values?.[5]))).toEqual(createTurnScheduledPrepareChoiceContent(scheduledWaitId, scheduledBinding))
    const step = f.calls.find(call => call.sql.includes('UPDATE "agent_steps" SET "status"'))
    expect(step?.values).toEqual(["stop", 7, 3, 0.02, now, scheduledFinalStepId, owner.sessionId, owner.turnId, owner.taskId])
    expect(f.calls.find(call => call.sql.includes('UPDATE "agent_turns" SET "status"'))?.sql).toContain('"leaseOwnerId" = $5 AND "leaseVersion" = $6')
    const events = f.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(events).toHaveLength(2)
    expect(JSON.parse(String(events[1]?.values?.[10]))).toEqual({ itemId: receipt.itemId, waitKind: "question", questionId: scheduledWaitId, toolCallId: null })
    expect(f.calls.some(call => call.sql.includes("agent.ask_user"))).toBe(false)
    expect(f.calls.findIndex(call => call.sql === "COMMIT")).toBeGreaterThan(f.calls.findIndex(call => call.sql.includes('INSERT INTO "agent_outbox"')))
  })

  it("creates and replays the deterministic choice wait when the candidate receipt has null usage", async () => {
    const f = scheduledChoiceFixture({ candidateUsage: null })
    const input = { owner, stepId: scheduledFinalStepId, toolCallId: null, expectedWaitId: scheduledWaitId,
      finishReason: "stop", usage: null, now }
    await expect(f.store.waitForQuestion(input)).resolves.toMatchObject({ status: "waiting_for_user", disposition: "created", waitId: scheduledWaitId })
    const stepUpdate = f.calls.find(call => call.sql.includes('UPDATE "agent_steps" SET "status"'))
    expect(stepUpdate?.values?.slice(0, 4)).toEqual(["stop", 0, 0, 0])

    const replay = scheduledChoiceFixture({ candidateUsage: null, turnStatus: "waiting_for_user", stepStatus: "waiting_for_user",
      itemStatus: "started", itemContent: createTurnScheduledPrepareChoiceContent(scheduledWaitId, scheduledBinding) })
    await expect(replay.store.waitForQuestion(input)).resolves.toMatchObject({ status: "waiting_for_user", disposition: "replayed", waitId: scheduledWaitId })
    expect(replay.calls.some(call => call.sql.includes('INSERT INTO "agent_items"') || call.sql.includes('UPDATE "agent_turns" SET "status"')
      || call.sql.includes('INSERT INTO "agent_events"') || call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("fails closed when the Web/API expected ID or current continuation receipt differs", async () => {
    const wrongId = scheduledChoiceFixture()
    await expect(wrongId.store.waitForQuestion({ owner, stepId: scheduledFinalStepId, toolCallId: null, expectedWaitId: "web-wait",
      finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }, now })).rejects.toMatchObject({ code: "question_conflict" })
    expect(wrongId.calls.some(call => call.sql.includes('INSERT INTO "agent_items"') || call.sql.includes('UPDATE "agent_steps"'))).toBe(false)

    const staleReceipt = scheduledChoiceFixture()
    await expect(staleReceipt.store.readScheduledPrepareChoice({ owner, receipt: { ...scheduledReceipt,
      owner: { ...scheduledOwner, executionAttemptCount: 3 } }, now })).rejects.toMatchObject({ code: "question_conflict" })
    expect(staleReceipt.calls.some(call => call.sql.includes('FROM "agent_items"'))).toBe(false)
  })

  it("reloads only the exact private answered item bound to the current receipt", async () => {
    const content = { ...createTurnScheduledPrepareChoiceContent(scheduledWaitId, scheduledBinding), answer: "keep_resume", answerAvailable: true }
    const f = scheduledChoiceFixture({ turnStatus: "in_progress", stepStatus: "waiting_for_user", itemStatus: "completed", itemContent: content })
    await expect(f.store.readScheduledPrepareChoice({ owner, receipt: scheduledReceipt, now })).resolves.toEqual({ status: "answered", waitId: scheduledWaitId,
      itemId: `agent-wait:question:${scheduledWaitId}`, answer: "keep_resume", binding: scheduledBinding })

    const forged = scheduledChoiceFixture({ turnStatus: "in_progress", stepStatus: "waiting_for_user", itemStatus: "completed", itemContent: { ...content, toolCallId: "ask_user" } })
    await expect(forged.store.readScheduledPrepareChoice({ owner, receipt: scheduledReceipt, now })).rejects.toMatchObject({ code: "question_conflict" })
  })
})
