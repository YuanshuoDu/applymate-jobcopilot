import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { scheduledGateCheckpointEvidence, SCHEDULED_GATE_OUTPUT_SCHEMA, scheduledGateCandidateSetDigest } from "../subagents/scheduled-gate-contract.js"
import { taskGraphLifecycleKey } from "../subagents/task-graph-snapshot.js"
import { createTurnScheduledGateChoiceContent, createTurnScheduledGateChoiceResumeAcknowledgement,
  parseTurnQuestionGateChoiceBinding, TURN_SCHEDULED_GATE_CHOICE_SCHEMA, turnScheduledGateChoiceWaitId,
  type TurnQuestionGateChoiceBinding } from "./turn-question-gate-choice-contract.js"
import { acknowledgeScheduledGateChoiceResume, readScheduledGateChoice, waitForScheduledGateChoice } from "./turn-question-gate-choice-store.js"
import type { TurnQuestionPool, TurnQuestionQueryClient } from "./turn-question-store-guards.js"

const fixtureState = vi.hoisted(() => ({
  client: null as unknown,
  turn: { status: "in_progress", revision: 7 } as Record<string, unknown>,
  step: { id: "root-step", status: "streaming", taskId: "root-1", attempt: 1, finishReason: null,
    errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } as Record<string, unknown>,
  task: {} as Record<string, unknown>,
  item: null as Record<string, unknown> | null,
  graph: null as unknown,
}))

vi.mock("./turn-question-store-guards.js", () => ({
  admitQuestionWork: vi.fn(),
  lockQuestionStep: vi.fn(async () => fixtureState.step),
  questionConflict: (resource: string) => Object.assign(new Error("Question persistence conflict: " + resource), { code: "question_conflict" }),
  questionItemId: (id: string) => "agent-wait:question:" + id,
  withQuestionTransaction: async (_pool: unknown, _owner: unknown, work: (client: never, turn: never) => Promise<unknown>) =>
    work(fixtureState.client as never, fixtureState.turn as never),
}))
vi.mock("../subagents/task-graph-pg-state.js", () => ({
  loadTaskGraph: vi.fn(async () => fixtureState.graph),
}))
vi.mock("./turn-question-gate-choice-events.js", () => ({
  appendScheduledGateChoiceWaitEvents: vi.fn(),
}))

const now = new Date("2026-10-23T12:00:00.000Z")
const owner: TurnExecutionOwnerFence = { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  taskId: "root-1", rootTaskId: "root-1", ownerId: "turn-lease", leaseVersion: 3,
  leaseExpiresAt: new Date("2026-10-23T12:01:00.000Z") }
const scheduledSnapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
  targetLocations: ["Dublin"], minScore: 70, dailyCap: 10, requireApproval: true, autoApply: false }
const snapshotDigest = "sha256:" + createHash("sha256").update(JSON.stringify([scheduledSnapshot.schemaVersion, scheduledSnapshot.targetRoles,
  scheduledSnapshot.targetLocations, scheduledSnapshot.minScore, scheduledSnapshot.dailyCap, scheduledSnapshot.requireApproval,
  scheduledSnapshot.autoApply]), "utf8").digest("hex")
const checkpointOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: 1, turnLeaseOwnerId: owner.ownerId, turnLeaseVersion: owner.leaseVersion,
  executionId: "execution-1", executionAttemptCount: 3 }
const checkpointState = { nextStage: "gate", scoutedJobs: [{ id: "job-1", userId: owner.userId }],
  scoredJobs: [{ job: { id: "job-1", userId: owner.userId }, score: 81, matchedKeywords: ["TypeScript"], missingKeywords: [],
    recommendation: "Continue.", analysisFenceAt: "2026-10-23T12:00:00.000Z" }], analysisFailed: 0,
  scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
    key: "scheduled-taskgraph:sha256:" + "a".repeat(64), snapshotDigest, evidenceDigest: "b".repeat(64), graphRevision: 9, owner: checkpointOwner } }
const checkpointEvidence = scheduledGateCheckpointEvidence(checkpointState)!
const binding: TurnQuestionGateChoiceBinding = parseTurnQuestionGateChoiceBinding({
  schemaVersion: TURN_SCHEDULED_GATE_CHOICE_SCHEMA,
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: 1, executionId: "execution-1", executionAttemptCount: 3 },
  continuationKey: checkpointEvidence.continuationKey, snapshotDigest, evidenceDigest: "b".repeat(64),
  checkpointDigest: checkpointEvidence.checkpointDigest, analyzeGraphRevision: checkpointEvidence.analyzeGraphRevision,
  graphRevision: 10, gateTaskId: "gate-1", gateAttempt: 2,
  kind: "weak_cover_letter", jobIds: ["job-1"], allowedChoiceIds: ["continue", "review", "skip"],
})!
const waitId = turnScheduledGateChoiceWaitId(binding)!
const itemId = "agent-wait:question:" + waitId
const structuredResult = { status: "question_required", kind: binding.kind, jobIds: ["job-1"],
  candidateSetDigest: scheduledGateCandidateSetDigest(binding.kind, binding.jobIds), allowedChoiceIds: binding.allowedChoiceIds }
const envelope = { finalItemId: null, finalText: "", status: "waiting_for_user", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult }

function graph(status: string) {
  const gateNode = { key: "gate", templateId: "gate", goal: "Review verified scheduled applications", successCriteria: [],
    dependsOn: ["prepare"], depth: 4, taskId: "gate-1", verificationDisposition: "specialized" }
  const prepareNode = { key: "prepare", templateId: "prepare", goal: "Prepare applications", successCriteria: [],
    dependsOn: ["analyst"], depth: 3, taskId: "prepare-1" }
  const gateTask = { id: "gate-1", status, role: "prepare", taskType: "scheduled_taskgraph_gate",
    expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], result: envelope }
  const prepareTask = { id: "prepare-1", status: "completed", role: "prepare", taskType: "scheduled_application_prepare",
    expectedOutputSchema: { schemaVersion: SCHEDULED_GATE_OUTPUT_SCHEMA.schemaVersion, role: "prepare" }, allowedActions: [], result: {} }
  const started = { nodeKey: "gate", type: "task.started", idempotencyKey: taskGraphLifecycleKey("root-1", "gate", 2, "task.started"), expectedRevision: 9 }
  return { item: { id: "task-graph:root-1", revision: 12, content: {} }, snapshot: { nodes: [gateNode, prepareNode] },
    state: { revision: 12, appliedEvents: [started], nodes: [{ key: "gate", taskId: "gate-1", status }, { key: "prepare", taskId: "prepare-1", status: "completed" }] },
    tasks: new Map([["gate-1", gateTask], ["prepare-1", prepareTask]]) }
}

function answeredContent(acknowledgement?: unknown): Record<string, unknown> {
  return { ...createTurnScheduledGateChoiceContent(waitId, binding, "Continue this application?")!, answer: "review",
    answerAvailable: true, answeredAt: now.toISOString(), ...(acknowledgement ? { scheduledGateChoiceResumeAcknowledgement: acknowledgement } : {}) }
}

function fixture(options: {
  gateStatus?: string; gateAttempt?: number; turnStatus?: string; stepStatus?: string; itemStatus?: string
  itemContent?: unknown; taskOverrides?: Record<string, unknown>; graphOverrides?: { gateDepth?: number; gateDeps?: string[]; gateStartExpectedRevision?: number }
} = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const gateStatus = options.gateStatus ?? "waiting_for_user", gateAttempt = options.gateAttempt ?? 2
  fixtureState.turn = { status: options.turnStatus ?? "in_progress", revision: 7 }
  fixtureState.step = { id: "root-step", status: options.stepStatus ?? "streaming", taskId: "root-1", attempt: 1,
    finishReason: options.stepStatus === "waiting_for_user" ? "stop" : null, errorCode: null,
    inputTokens: options.stepStatus === "waiting_for_user" ? 4 : 0, outputTokens: options.stepStatus === "waiting_for_user" ? 2 : 0,
    estimatedCostUsd: options.stepStatus === "waiting_for_user" ? 0.01 : 0 }
  fixtureState.task = { id: "gate-1", sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    parentTaskId: owner.rootTaskId, role: "prepare", taskType: "scheduled_taskgraph_gate", status: gateStatus,
    attemptCount: gateAttempt, result: envelope, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [],
    rootAttemptCount: 1, turnRootTaskId: owner.rootTaskId, source: "automation", executionMode: "canonical_task_graph",
    input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: scheduledSnapshot }, userId: owner.userId,
    executionId: "execution-1", executionAttemptCount: 3, executionStatus: "running", state: checkpointState, ...options.taskOverrides }
  fixtureState.graph = graph(gateStatus)
  if (options.graphOverrides) {
    const value = fixtureState.graph as ReturnType<typeof graph>
    value.snapshot.nodes[0] = { ...value.snapshot.nodes[0], depth: options.graphOverrides.gateDepth ?? 4,
      dependsOn: options.graphOverrides.gateDeps ?? ["prepare"] }
    if (options.graphOverrides.gateStartExpectedRevision !== undefined) {
      value.state.appliedEvents[0] = { ...value.state.appliedEvents[0], expectedRevision: options.graphOverrides.gateStartExpectedRevision }
    }
  }
  fixtureState.item = options.itemStatus ? { id: itemId, stepId: "root-step", taskId: owner.taskId, type: "question",
    status: options.itemStatus, content: options.itemContent } : null
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('SELECT task."id"')) return { rows: [fixtureState.task], rowCount: 1 }
    if (sql.includes('FROM "agent_items"') && sql.includes('WHERE "id" = $1')) return { rows: fixtureState.item ? [fixtureState.item] : [], rowCount: fixtureState.item ? 1 : 0 }
    if (sql.includes('UPDATE "agent_items" SET "content"')) {
      const content = JSON.parse(String(values?.[0])) as Record<string, unknown>
      fixtureState.item = { ...fixtureState.item, content }
      return { rows: [{ content }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_items"')) return { rows: [], rowCount: 1 }
    if (sql.includes('UPDATE "agent_steps" SET "status"')) return { rows: [], rowCount: 1 }
    if (sql.includes('UPDATE "agent_turns" SET "status"')) return { rows: [{ revision: 8 }], rowCount: 1 }
    throw new Error("unexpected Gate question query: " + sql)
  }) }
  fixtureState.client = client
  return { calls, client, pool: { connect: vi.fn() } as unknown as TurnQuestionPool }
}

const waitInput = { owner, stepId: "root-step", toolCallId: null, gateChoiceBinding: binding,
  gateChoiceQuestion: "Continue this application?", expectedWaitId: waitId, finishReason: "stop",
  usage: { inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0.01 }, now }
const ackInput = { owner, binding, gateTaskId: binding.gateTaskId, requestAttemptCount: binding.gateAttempt,
  waitId, itemId, resumedAttemptCount: binding.gateAttempt + 1, now }

describe("scheduled Gate private question persistence", () => {
  beforeEach(() => vi.clearAllMocks())

  it("admits only the exact fixed Gate question and atomically suspends the root Turn", async () => {
    const f = fixture()
    await expect(waitForScheduledGateChoice(f.pool, waitInput)).resolves.toMatchObject({
      status: "waiting_for_user", disposition: "created", waitId, itemId, turnId: owner.turnId, toolCallId: null, nextTurnRevision: 8,
    })
    const insert = f.calls.find(call => call.sql.includes('INSERT INTO "agent_items"'))
    expect(JSON.parse(String(insert?.values?.[5]))).toMatchObject({ questionId: waitId, stage: "scheduled_gate", answer: null,
      scheduledGateChoiceBinding: binding })
    expect(f.calls.some(call => call.sql.includes("agent.ask_user"))).toBe(false)
  })

  it("rejects malformed-but-present task lineage, role/schema, result, and graph bindings before insertion", async () => {
    const cases = [
      { taskOverrides: { parentTaskId: "foreign-parent" } },
      { taskOverrides: { role: "gate" } },
      { taskOverrides: { taskType: "scheduled_application_prepare" } },
      { taskOverrides: { allowedActions: ["scheduled.application.prepare"] } },
      { taskOverrides: { expectedOutputSchema: { schemaVersion: "wrong", role: "prepare", taskType: "scheduled_taskgraph_gate" } } },
      { taskOverrides: { rootAttemptCount: 7 } },
      { graphOverrides: { gateDepth: 3 } },
      { graphOverrides: { gateDeps: ["analyst"] } },
      { graphOverrides: { gateStartExpectedRevision: 8 } },
    ]
    for (const options of cases) {
      const f = fixture(options)
      await expect(waitForScheduledGateChoice(f.pool, waitInput)).rejects.toMatchObject({ code: "question_conflict" })
      expect(f.calls.some(call => call.sql.includes('INSERT INTO "agent_items"'))).toBe(false)
    }
    const malformed = fixture({ taskOverrides: { result: { ...envelope, status: "completed" } } })
    await expect(readScheduledGateChoice(malformed.pool, { owner, binding, now })).rejects.toMatchObject({ code: "question_conflict" })
  })

  it("returns only the exact private answered choice, never a default", async () => {
    const waiting = fixture({ turnStatus: "waiting_for_user", stepStatus: "waiting_for_user", itemStatus: "started",
      itemContent: createTurnScheduledGateChoiceContent(waitId, binding, "Continue this application?") })
    await expect(readScheduledGateChoice(waiting.pool, { owner, binding, now })).resolves.toEqual({ status: "waiting", waitId, itemId, binding })
    const answered = fixture({ turnStatus: "in_progress", stepStatus: "waiting_for_user", itemStatus: "completed", itemContent: answeredContent() })
    await expect(readScheduledGateChoice(answered.pool, { owner, binding, now })).resolves.toEqual({ status: "answered", waitId, itemId, binding,
      validatedChoice: { kind: binding.kind, jobIds: binding.jobIds, choiceId: "review" } })
    const absent = fixture()
    await expect(readScheduledGateChoice(absent.pool, { owner, binding, now })).resolves.toEqual({ status: "none" })
  })

  it("writes the exact one-shot N to N+1 acknowledgement on the private answer and replays only that acknowledgement", async () => {
    const first = fixture({ turnStatus: "in_progress", stepStatus: "waiting_for_user", itemStatus: "completed", itemContent: answeredContent() })
    await expect(acknowledgeScheduledGateChoiceResume(first.client as unknown as TurnQuestionQueryClient, ackInput)).resolves.toEqual({
      kind: binding.kind, jobIds: binding.jobIds, choiceId: "review",
    })
    const update = first.calls.find(call => call.sql.includes('UPDATE "agent_items" SET "content"'))
    const saved = JSON.parse(String(update?.values?.[0])) as Record<string, unknown>
    expect(saved.scheduledGateChoiceResumeAcknowledgement).toEqual(createTurnScheduledGateChoiceResumeAcknowledgement(ackInput))
    expect(first.calls.some(call => call.sql.includes("agent_events") || call.sql.includes("agent_outbox"))).toBe(false)

    const ack = createTurnScheduledGateChoiceResumeAcknowledgement(ackInput)!
    const replay = fixture({ gateStatus: "queued", turnStatus: "in_progress", stepStatus: "waiting_for_user",
      itemStatus: "completed", itemContent: answeredContent(ack), taskOverrides: { result: null } })
    await expect(acknowledgeScheduledGateChoiceResume(replay.client as unknown as TurnQuestionQueryClient, ackInput)).resolves.toMatchObject({ choiceId: "review" })
    expect(replay.calls.some(call => call.sql.includes('UPDATE "agent_items" SET "content"'))).toBe(false)
    const replayRead = fixture({ gateStatus: "queued", turnStatus: "in_progress", stepStatus: "waiting_for_user",
      itemStatus: "completed", itemContent: answeredContent(ack), taskOverrides: { result: null } })
    await expect(readScheduledGateChoice(replayRead.pool, { owner, binding, now })).resolves.toMatchObject({
      status: "answered", validatedChoice: { kind: binding.kind, jobIds: binding.jobIds, choiceId: "review" },
    })
    const running = fixture({ gateStatus: "running", gateAttempt: 3, turnStatus: "in_progress", stepStatus: "waiting_for_user",
      itemStatus: "completed", itemContent: answeredContent(ack), taskOverrides: { result: null } })
    await expect(acknowledgeScheduledGateChoiceResume(running.client as unknown as TurnQuestionQueryClient, ackInput)).resolves.toMatchObject({ choiceId: "review" })
    const runningRead = fixture({ gateStatus: "running", gateAttempt: 3, turnStatus: "in_progress", stepStatus: "waiting_for_user",
      itemStatus: "completed", itemContent: answeredContent(ack), taskOverrides: { result: null } })
    await expect(readScheduledGateChoice(runningRead.pool, { owner, binding, now })).resolves.toMatchObject({
      status: "answered", validatedChoice: { kind: binding.kind, jobIds: binding.jobIds, choiceId: "review" },
    })
  })

  it("rejects an unacknowledged requeue, wrong ack, and any later attempt", async () => {
    const queued = fixture({ gateStatus: "queued", turnStatus: "in_progress", stepStatus: "waiting_for_user",
      itemStatus: "completed", itemContent: answeredContent(), taskOverrides: { result: null } })
    await expect(readScheduledGateChoice(queued.pool, { owner, binding, now })).rejects.toMatchObject({ code: "question_conflict" })
    const unacknowledgedRunning = fixture({ gateStatus: "running", gateAttempt: 3, turnStatus: "in_progress", stepStatus: "waiting_for_user",
      itemStatus: "completed", itemContent: answeredContent(), taskOverrides: { result: null } })
    await expect(readScheduledGateChoice(unacknowledgedRunning.pool, { owner, binding, now })).rejects.toMatchObject({ code: "question_conflict" })
    const ack = createTurnScheduledGateChoiceResumeAcknowledgement(ackInput)!
    const later = fixture({ gateStatus: "running", gateAttempt: 4, turnStatus: "in_progress", stepStatus: "waiting_for_user",
      itemStatus: "completed", itemContent: answeredContent(ack) })
    await expect(readScheduledGateChoice(later.pool, { owner, binding, now })).rejects.toMatchObject({ code: "question_conflict" })
    await expect(acknowledgeScheduledGateChoiceResume(later.client as unknown as TurnQuestionQueryClient, ackInput)).rejects.toMatchObject({ code: "question_conflict" })
  })
})
