import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"
import { waitForNativeVerification } from "../canonical-turn-native-verification-wait.js"
import type { HarnessModelRequest, ModelAdapter, ModelCapabilityProfile } from "@jobcopilot/agent-model"
import type { WorkerUsageAuthorizationInput, WorkerUsageSettlementInput } from "../../queue/ai-usage-bridge.js"
import { releaseTurnLease, type TurnLease } from "../turns/lease.js"
import {
  canonicalNativeVerificationJson, digestNativeVerificationValue, NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, parseNativeVerificationControl,
} from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import { attachNativeVerificationReport, parseNativeVerificationReport } from "./native-verification-report.js"
import { readNativeVerificationTerminalProofWithClient } from "./native-verification-pg-readback.js"
import { ensureNativeVerificationControl } from "./native-verification-pg-request.js"
import { buildNativeChildPacketContent, type NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import { loadNativeVerificationOwnedState, nativeVerificationBindingDigest, nativeVerificationTarget } from "./native-verification-pg-bindings.js"
import { nativeVerificationHistory } from "./native-verification-pg-readback.js"
import { createPgNativeVerificationPort } from "./pg-native-verification-port.js"
import { transaction } from "./pg-store-persistence.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { questionId, questionItemId } from "../turns/turn-question-store-guards.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { projectNativeVerificationResult } from "../tools/native-verification-feedback-projection.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphItemId } from "./task-graph-snapshot.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Native verification PostgreSQL acceptance needs the dedicated disposable CI URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Native verification PostgreSQL acceptance requires the dedicated disposable CI URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), ids = {
  user: `native-verify-user-${suffix}`, session: `native-verify-session-${suffix}`, turn: `native-verify-turn-${suffix}`,
  priorTurn: `native-verify-prior-turn-${suffix}`, priorRoot: `native-verify-prior-root-${suffix}`,
  priorQuestionStep: `native-verify-prior-question-step-${suffix}`, priorQuestionCall: `native-verify-prior-question-call-${suffix}`,
  priorQuestionResult: `native-verify-prior-question-result-${suffix}`, priorTurnOwner: `native-verify-prior-turn-owner-${suffix}`,
  root: `native-verify-root-${suffix}`, rootStep: `native-verify-root-step-${suffix}`, child: `native-verify-child-${suffix}`,
  childStep: `native-verify-child-step-${suffix}`, toolCallItem: `native-verify-tool-call-${suffix}`,
  toolItem: `native-verify-tool-item-${suffix}`, duplicateToolItem: `native-verify-duplicate-tool-item-${suffix}`,
  questionStep: `native-verify-question-step-${suffix}`, questionCall: `native-verify-question-call-${suffix}`,
  questionResult: `native-verify-question-result-${suffix}`,
  turnOwner: `native-verify-turn-owner-${suffix}`, taskOwner: `native-verify-task-owner-${suffix}`,
}
type QuestionSeedInput = Readonly<{
  turnId: string; rootTaskId: string; stepId: string; callItemId: string; resultItemId: string; ownerId: string; question: string; answer: string
}>
type PriorQuestionFixture = QuestionSeedInput & Readonly<{ questionId: string; itemId: string; answerEventId: string }>
type QuestionSeedOverrides = Partial<QuestionSeedInput>
let priorQuestionFixture: PriorQuestionFixture | undefined
const goal = "Find and verify the persisted source facts"
const criteria = ["Cite the owned tool result"]
const rootGoal = "Find and verify the persisted source facts while preserving the user's stated location and phrase."
const rootCriteria = ["Cite the owned tool result", "Respect the user's stated location and phrase as self-attestation, not external proof."]
const childResult = { answer: "The source records fact 42" }
const toolOutput = { facts: ["Fact 42 is present in the owned result"] }
const metadata = {
  schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "native-op-576",
  requestFingerprint: "a".repeat(64), callerTaskId: ids.root, role: "analyst", taskType: "research",
  contextDigest: "b".repeat(64), contextBytes: 0,
}
const snapshot = parseTaskGraphSnapshot({
  schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
  nodes: [{ key: "native-child", templateId: "native", goal, successCriteria: criteria, dependsOn: [], depth: 1,
    taskId: ids.child, verificationDisposition: "legacy_unverified", nativeDelegation: metadata }],
})
const scope: TaskGraphExecutionScope = {
  userId: ids.user, sessionId: ids.session, turnId: ids.turn, rootTaskId: ids.root, parentTaskId: ids.root,
  stepId: ids.rootStep, turnLeaseOwner: ids.turnOwner, turnLeaseVersion: 1,
  parentLeaseOwner: ids.taskOwner, parentAttemptCount: 1,
}
const candidateText = "Fact 42 is present in the owned source. I will preserve the location and phrase you specified.\n"
const syntheticAnswer = "München 🧭; preserve the exact phrase \"grün\tsignal\"."
let pool: PgPool | undefined

async function seedPriorCompletedQuestion(): Promise<PriorQuestionFixture> {
  const priorGoal = "Earlier objective: record the user's own location and phrase."
  const priorCriteria = ["Record the exact answer as a user statement."]
  const startedAt = new Date(Date.now() - 60 * 60_000)
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, $6, CURRENT_TIMESTAMP)`,
  [ids.priorTurn, ids.session, ids.user, JSON.stringify({ goal: priorGoal, successCriteria: priorCriteria }), ids.priorTurnOwner, startedAt])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/prior-root', 0, 'orchestrator', 'root', 'completed', $4,
      '[]'::jsonb, $5::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [ids.priorRoot, ids.session, ids.priorTurn, priorGoal, JSON.stringify(priorCriteria)])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.priorRoot])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.priorRoot, ids.priorTurn])
  const question = await seedAnsweredQuestion({ turnId: ids.priorTurn, rootTaskId: ids.priorRoot, stepId: ids.priorQuestionStep,
    callItemId: ids.priorQuestionCall, resultItemId: ids.priorQuestionResult, ownerId: ids.priorTurnOwner,
    question: "What location and phrase did you previously state?", answer: "Prior statement: Rotterdam, with the phrase \"silver bridge\"." })
  const row = await pool!.query<{ leaseStartedAt: Date; leaseExpiresAt: Date }>(
    `SELECT "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
    [ids.priorTurn, ids.session, ids.user])
  const leaseRow = row.rows[0]
  if (!leaseRow) throw new Error("native_prior_turn_lease_unavailable")
  const lease: TurnLease = { turnId: ids.priorTurn, sessionId: ids.session, ownerId: ids.priorTurnOwner,
    userId: ids.user, leaseVersion: 1, leaseStartedAt: leaseRow.leaseStartedAt, leaseExpiresAt: leaseRow.leaseExpiresAt }
  await releaseTurnLease(pool!, lease, "completed")
  const terminal = await pool!.query<{ status: string; completedAt: Date | null; leaseOwnerId: string | null; leaseStartedAt: Date | null; leaseExpiresAt: Date | null }>(
    `SELECT "status", "completedAt", "leaseOwnerId", "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [ids.priorTurn])
  expect(terminal.rows[0]).toMatchObject({ status: "completed", leaseOwnerId: null, leaseStartedAt: null, leaseExpiresAt: null })
  expect(terminal.rows[0]?.completedAt).toBeInstanceOf(Date)
  const usage = await pool!.query<{ status: string; attempt: number; inputTokens: number; outputTokens: number; cost: string }>(
    `SELECT "status", "attempt", "inputTokens", "outputTokens", "estimatedCostUsd" AS "cost" FROM "agent_steps" WHERE "id" = $1`, [ids.priorQuestionStep])
  expect(usage.rows[0]).toMatchObject({ status: "waiting_for_user", attempt: 1, inputTokens: 47, outputTokens: 13 })
  expect(Number(usage.rows[0]?.cost)).toBeCloseTo(0.007)
  return question
}
async function seed(): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Native verifier disposable integration', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user])
  priorQuestionFixture = await seedPriorCompletedQuestion()
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
  [ids.turn, ids.session, ids.user, JSON.stringify({ goal: rootGoal, successCriteria: rootCriteria }), ids.turnOwner])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', $5,
      '[]'::jsonb, $6::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
  [ids.root, ids.session, ids.turn, ids.taskOwner, rootGoal, JSON.stringify(rootCriteria)])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 2, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [ids.rootStep, ids.session, ids.turn, ids.root])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, '/root/native-child', 1, 'analyst', 'research', 'completed', $5,
      '[]'::jsonb, $6::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $7::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, 1, 2, CURRENT_TIMESTAMP)`, [ids.child, ids.session, ids.turn, ids.root, goal, JSON.stringify(criteria), JSON.stringify(childResult)])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP)`, [taskGraphItemId(ids.root), ids.session, ids.turn, ids.root, JSON.stringify(snapshot)])
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 3, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`, [ids.childStep, ids.session, ids.turn, ids.child])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP)`, [ids.toolCallItem, ids.session, ids.turn, ids.childStep, ids.child,
    JSON.stringify({ toolCallId: "lookup-576", toolName: "source.lookup", toolVersion: "1", status: "completed", input: { query: "fact 42" } })])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP)`, [ids.toolItem, ids.session, ids.turn, ids.childStep, ids.child,
    JSON.stringify({ toolCallId: "lookup-576", output: toolOutput, errorCode: null })])
}

async function seedAnsweredQuestion(overrides: QuestionSeedOverrides = {}): Promise<PriorQuestionFixture> {
  const seed: QuestionSeedInput = {
    turnId: ids.turn, rootTaskId: ids.root, stepId: ids.questionStep, callItemId: ids.questionCall,
    resultItemId: ids.questionResult, ownerId: ids.turnOwner,
    question: "Which location and phrase should I preserve as your own statement?", answer: syntheticAnswer,
    ...overrides,
  }
  const owner: TurnExecutionOwnerFence = {
    kind: "turn", userId: ids.user, sessionId: ids.session, turnId: seed.turnId, taskId: seed.rootTaskId, rootTaskId: seed.rootTaskId,
    ownerId: seed.ownerId, leaseVersion: 1, leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
  }
  const toolCallId = `ask-user-${seed.turnId}-${suffix}`
  const waitId = questionId(owner, seed.stepId, toolCallId)
  const itemId = questionItemId(waitId)
  const { answer, question } = seed
  const answeredAt = "2026-10-06T12:00:00.000Z"
  const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input",
    question, options: [] }
  const sequenceRow = await pool!.query<{ eventSequence: number | string }>(`SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [ids.session])
  const firstSequence = Number(sequenceRow.rows[0]?.eventSequence)
  if (!Number.isSafeInteger(firstSequence) || firstSequence < 0) throw new Error("native_answer_evidence_event_sequence_unavailable")
  const previousRootEvent = await pool!.query<{ id: string }>(`SELECT "id" FROM "agent_events"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "sequence" DESC LIMIT 1`,
  [ids.session, seed.turnId, seed.rootTaskId])

  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd",
     "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "completedAt")
    VALUES ($1, $2, $3, $4, 1, 1, 'waiting_for_user', 'tool_calls', 47, 13, 0.007, 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [seed.stepId, ids.session, seed.turnId, seed.rootTaskId])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', 'commentary', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [seed.callItemId, ids.session, seed.turnId, seed.stepId, seed.rootTaskId,
    JSON.stringify({ toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null,
      input: { question, choices: [] } })])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 'commentary', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [seed.resultItemId, ids.session, seed.turnId, seed.stepId, seed.rootTaskId,
    JSON.stringify({ toolCallId, output: intent, errorCode: null })])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "phase", "content", "startedAt", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'question', 'completed', 2, 'commentary', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [itemId, ids.session, seed.turnId, seed.stepId, seed.rootTaskId, JSON.stringify({ waitKind: "question", questionId: waitId,
    toolCallId, stage: "user_input", question, options: [], answer, answerAvailable: true, answeredAt })])
  await pool!.query(`UPDATE "agent_turns" SET "revision" = 3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [seed.turnId])

  const eventPrefix = seed.turnId === ids.turn ? "native-question" : "native-prior-question"
  const answeredEventId = `${eventPrefix}-answered-event-${suffix}`
  const answerPayload = { waitKind: "question", waitId, itemId, turnId: seed.turnId,
    toolCallId, status: "answered", nextTurnRevision: 3, answerAvailable: true }
  const answerKey = "question-answer:" + seed.turnId + ":" + waitId
  const eventRows = [
    { id: `${eventPrefix}-step-event-${suffix}`, itemId: null, taskId: seed.rootTaskId, sequence: firstSequence + 1, type: "step.completed",
      actor: "orchestrator", correlationId: seed.stepId, causationId: previousRootEvent.rows[0]?.id ?? null,
      key: `turn:${seed.turnId}:event:step-completed:${seed.stepId}`,
      payload: { stepId: seed.stepId, status: "waiting_for_user", toolCallCount: 1, taskId: seed.rootTaskId }, topic: "agent.events" },
    { id: `${eventPrefix}-item-event-${suffix}`, itemId, taskId: seed.rootTaskId, sequence: firstSequence + 2, type: "item.started",
      actor: "orchestrator", correlationId: itemId, causationId: waitId, key: `agent-wait:${itemId}:started`,
      payload: { itemId, waitKind: "question", questionId: waitId, toolCallId }, topic: "agent.events" },
    { id: answeredEventId, itemId, taskId: null, sequence: firstSequence + 3, type: "question.answered",
      actor: "user", correlationId: waitId, causationId: itemId, key: answerKey, payload: answerPayload, topic: "agent.session.event" },
    { id: `${eventPrefix}-wakeup-event-${suffix}`, itemId, taskId: null, sequence: firstSequence + 4, type: "turn.wakeup",
      actor: "user", correlationId: seed.turnId, causationId: answeredEventId,
      key: answerKey + ":wakeup", payload: answerPayload, topic: "agent.turn.wakeup" },
  ]
  for (const event of eventRows) {
    const envelope = { eventId: event.id, sessionId: ids.session, turnId: seed.turnId, itemId: event.itemId,
      taskId: event.taskId, sequence: String(event.sequence), type: event.type, actor: event.actor,
      correlationId: event.correlationId, causationId: event.causationId, idempotencyKey: event.key, payload: event.payload }
    await pool!.query(`INSERT INTO "agent_events"
      ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [event.id, ids.session, seed.turnId, event.itemId, event.taskId, event.sequence, event.type, event.actor,
      event.correlationId, event.causationId, event.key, JSON.stringify(event.payload)])
    const outboxIdempotencyKey = event.topic === "agent.events" ? `agent-event:${event.id}` : `agent-event:${event.id}`
    await pool!.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [`agent-outbox-${event.id}`, event.topic, ids.session, outboxIdempotencyKey, JSON.stringify(envelope)])
  }
  await pool!.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [ids.session, firstSequence + 4])
  return { ...seed, questionId: waitId, itemId, answerEventId: answeredEventId }
}

async function completeControls(taskIds: readonly string[]): Promise<void> {
  for (const taskId of taskIds) {
    const stored = await pool!.query<{ id: string; expectedOutputSchema: unknown; context: unknown }>(`SELECT "id", "expectedOutputSchema", "context"
      FROM "sub_agent_tasks" WHERE "id" = $1`, [taskId])
    const row = stored.rows[0]
    const control = row && parseNativeVerificationControl(row.expectedOutputSchema)
    const packet = control ? parseNativeVerificationPacket(row!.context, control) : null
    if (!row || !control || !packet) throw new Error("native_verification_integration_control_unreadable")
    const modelReport = {
      schemaVersion: "agent-harness.v2.native-verifier-model-report.v1" as const,
      criteria: packet.criteria.map(item => ({ criterionId: item.criterionId, disposition: "passed" as const,
        reasonCode: "meets_criterion" as const, evidenceReferenceIds: [packet.target.referenceId] })),
    }
    const report = attachNativeVerificationReport(control, 1, modelReport)
    if (!report) throw new Error("native_verification_integration_report_invalid")
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "attemptCount" = 1, "result" = $2::jsonb,
      "failureReason" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [taskId, JSON.stringify({ nativeVerificationReport: report })])
  }
}

async function executeControlWithProduction(taskId: string): Promise<{
  outcome: { status: string }
  requests: HarnessModelRequest[]
  packets: ReturnType<typeof parseNativeVerificationPacket>[]
  usageAuthorizations: WorkerUsageAuthorizationInput[]
  usageSettlements: WorkerUsageSettlementInput[]
}> {
  const [{ AgentTreeManager }, { createProductionChildExecutor }, { PgSubagentTaskStore }, { runSubagentQueueJob }] = await Promise.all([
    import("./manager.js"), import("./production-child-runtime.js"), import("./pg-store.js"), import("../../queue/subagent-pause-dispatch.js"),
  ])
  const requests: HarnessModelRequest[] = [], packets: ReturnType<typeof parseNativeVerificationPacket>[] = []
  const usageAuthorizations: WorkerUsageAuthorizationInput[] = [], usageSettlements: WorkerUsageSettlementInput[] = []
  const profile: ModelCapabilityProfile = {
    provider: "fixture", model: "native-answer-evidence-deterministic", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
    supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
    maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
  }
  const executor = createProductionChildExecutor({
    pool: pool!,
    authorizeUsage: async input => {
      usageAuthorizations.push(input)
      return { settle: async value => { usageSettlements.push(value) } }
    },
    modelRuntimeFactory: ({ task }) => {
      const control = parseNativeVerificationControl(task.expectedOutputSchema)
      const packet = control ? parseNativeVerificationPacket(task.context, control) : null
      if (!control || !packet || task.id !== taskId) throw new Error("native_answer_evidence_control_unavailable")
      packets.push(packet)
      return {
        id: "native-answer-evidence-deterministic", profile,
        async *stream(request: HarnessModelRequest) {
          requests.push(request)
          const report = { schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
            criteria: packet.criteria.map(item => {
              const selfAttestation = item.requirement.includes("self-attestation")
              const references = selfAttestation
                ? packet.evidence.filter(evidence => evidence.kind === "user_self_attestation").map(evidence => evidence.referenceId)
                : [packet.target.referenceId, ...packet.evidence.filter(evidence => evidence.kind === "tool_result").map(evidence => evidence.referenceId)]
              return { criterionId: item.criterionId, disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: references.slice(0, 8) }
            }) }
          yield { type: "text_delta", text: JSON.stringify(report) }
          yield { type: "usage", inputTokens: 173, outputTokens: 41, estimatedCostUsd: 0.013 }
          yield { type: "completed", finishReason: "stop" }
        },
      } satisfies ModelAdapter
    },
  })
  const manager = new AgentTreeManager(new PgSubagentTaskStore(pool!))
  try {
    const outcome = await runSubagentQueueJob(pool as unknown as PgSubagentPool, manager, executor, {
      taskId, sessionId: ids.session, rootTaskId: ids.root, ownerId: `native-answer-evidence-${randomUUID()}`,
    })
    return { outcome, requests, packets, usageAuthorizations, usageSettlements }
  } finally { await manager.shutdown() }
}

function packetContentForRollback(): NativeVerificationPacketContent {
  return {
    goal, criteria: [{ criterionId: "criterion-1", requirement: criteria[0]! }],
    target: { kind: "child", taskId: ids.child, attempt: 1, resultDigest: digestNativeVerificationValue(childResult),
      referenceId: "target:rollback", resultText: canonicalNativeVerificationJson(childResult) },
    evidence: [{ referenceId: "evidence:rollback", kind: "tool_result", summary: "bounded test-owned fact" }],
  }
}

describePg("native verification PostgreSQL producer and readback", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 8 })
    await seed()
  })
  afterAll(async () => {
    if (!pool) return
    await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session])
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    await pool.end()
  })

  it("rolls back task, dispatch, event and receipt together when the caller transaction aborts", async () => {
    const parent = await pool!.query(`SELECT "budgetSnapshot" FROM "sub_agent_tasks" WHERE "id" = $1`, [ids.root])
    await expect(transaction(pool as unknown as PgSubagentPool, async client => {
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
      await ensureNativeVerificationControl(client, { scope, parent: parent.rows[0] as Record<string, unknown>,
        target: { kind: "child", nodeId: "rollback-node", nativeOperationId: "rollback-op", fingerprint: "c".repeat(64),
          taskId: ids.child, attempt: 1, resultDigest: digestNativeVerificationValue(childResult) }, content: packetContentForRollback() })
      throw new Error("exercise_atomic_rollback")
    })).rejects.toThrow("exercise_atomic_rollback")
    const rows = await pool!.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "role" = 'auditor' AND "taskType" = 'native_verification'`, [ids.session])
    expect(rows.rows[0]?.count).toBe(0)
    expect((await pool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'native_verification.requested'`, [ids.session])).rows).toHaveLength(0)
    expect((await pool!.query(`SELECT outbox."id" FROM "agent_outbox" AS outbox
      JOIN "agent_events" AS event ON event."id" = outbox."payload"->>'eventId'
      WHERE outbox."aggregateId" = $1 AND outbox."topic" = 'agent.session.event'
        AND event."type" = 'native_verification.requested'`, [ids.session])).rows).toHaveLength(0)
  }, 30_000)

  it("uses seeded canonical current and prior Q/A rows in the private judge and invalidates stale proof", async () => {
    const port = createPgNativeVerificationPort(pool as unknown as PgSubagentPool)
    const [first, second] = await Promise.all([port.ensureChildren(scope), port.ensureChildren(scope)])
    expect(first.status).toBe("pending")
    expect(second.status).toBe("pending")
    expect(first.controlTaskIds).toEqual(second.controlTaskIds)
    expect(first.pendingTaskIds).toEqual(first.controlTaskIds)

    const counts = await pool!.query(`SELECT
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "role" = 'auditor' AND "taskType" = 'native_verification') AS "controls",
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'native_verification.requested') AS "receipts",
      (SELECT COUNT(*)::int FROM "agent_outbox" AS outbox JOIN "agent_events" AS event ON event."id" = outbox."payload"->>'eventId'
        WHERE outbox."aggregateId" = $1 AND outbox."topic" = 'agent.session.event' AND event."type" = 'native_verification.requested') AS "outbox"`, [ids.session])
    expect(counts.rows[0]).toEqual({ controls: 1, receipts: 1, outbox: 1 })

    await completeControls(first.controlTaskIds)
    // Q/A envelopes are fixture-seeded; the historical Turn terminal release above uses the production lease helper.
    const answeredQuestion = await seedAnsweredQuestion()
    const priorQuestion = priorQuestionFixture
    if (!priorQuestion) throw new Error("native_prior_question_fixture_unavailable")
    const childControl = await pool!.query<{ context: unknown; expectedOutputSchema: unknown }>(
      `SELECT "context", "expectedOutputSchema" FROM "sub_agent_tasks" WHERE "id" = $1`, [first.controlTaskIds[0]])
    const childMarker = parseNativeVerificationControl(childControl.rows[0]?.expectedOutputSchema)
    const childPacket = childMarker ? parseNativeVerificationPacket(childControl.rows[0]?.context, childMarker) : null
    expect(childPacket).not.toBeNull()
    expect(childPacket?.evidence.some(item => item.kind === "user_self_attestation")).toBe(false)
    expect(JSON.stringify(childPacket).includes(answeredQuestion.answer)).toBe(false)
    expect(JSON.stringify(childPacket).includes(priorQuestion.answer)).toBe(false)

    const rootPending = await port.ensureRootGoal({ scope, candidateText })
    expect(rootPending.status).toBe("pending")
    const rootTaskIds = rootPending.controlTaskIds.filter(id => !first.controlTaskIds.includes(id))
    expect(rootTaskIds).toHaveLength(1)
    const rootControlRow = await pool!.query<{ context: unknown; expectedOutputSchema: unknown }>(
      `SELECT "context", "expectedOutputSchema" FROM "sub_agent_tasks" WHERE "id" = $1`, [rootTaskIds[0]])
    const rootControl = parseNativeVerificationControl(rootControlRow.rows[0]?.expectedOutputSchema)
    const rootPacket = rootControl ? parseNativeVerificationPacket(rootControlRow.rows[0]?.context, rootControl) : null
    expect(rootPacket?.schemaVersion).toBe("agent-harness.v2.native-verifier-packet.v2")
    expect(rootPacket?.goal).toBe(rootGoal)
    expect(JSON.stringify(rootPacket).includes("Earlier objective:")).toBe(false)
    const attestation = rootPacket?.evidence.filter(item => item.kind === "user_self_attestation") ?? []
    expect(attestation).toHaveLength(2)
    const privateSummaries = attestation.map(item => JSON.parse(item.summary) as Record<string, unknown>)
    expect(privateSummaries).toContainEqual({ kind: "user_self_attestation", stage: "user_input",
      question: answeredQuestion.question, options: [], answer: answeredQuestion.answer })
    expect(privateSummaries).toContainEqual({ kind: "user_self_attestation", stage: "user_input",
      statementSource: "user_statement", turnRelation: "earlier_turn",
      question: priorQuestion.question, options: [], answer: priorQuestion.answer })
    const privateReferenceIds = attestation.map(item => item.referenceId)
    if (!rootControl || !rootPacket || privateReferenceIds.some(value => !value)) throw new Error("native_answer_evidence_packet_unavailable")
    for (const referenceId of privateReferenceIds) expect(referenceId).toMatch(/^user-self-attestation:[a-f0-9]{64}$/)

    const executed = await executeControlWithProduction(rootTaskIds[0]!)
    expect(executed.outcome.status).toBe("completed")
    expect(executed.requests).toHaveLength(1)
    expect(executed.packets).toHaveLength(1)
    expect(executed.packets[0]?.evidence.filter(item => item.kind === "user_self_attestation")).toEqual(attestation)
    const modelRequest = executed.requests[0]!
    expect(modelRequest.tools).toEqual([])
    expect(modelRequest.toolChoice).toBeUndefined()
    const modelText = modelRequest.messages.flatMap(message => message.content)
      .filter((part): part is Extract<(typeof modelRequest.messages)[number]["content"][number], { type: "text" }> => part.type === "text")
      .map(part => part.text).join("\n")
    const profilePrefix = "[harness context layer=profile trust=UNTRUSTED_DATA source=native-verification-packet]\n"
    const profileBlocks = modelRequest.messages.filter(message => message.role === "user").flatMap(message => message.content)
      .filter((part): part is Extract<(typeof modelRequest.messages)[number]["content"][number], { type: "text" }> =>
        part.type === "text" && part.text.startsWith(profilePrefix))
    expect(profileBlocks).toHaveLength(1)
    const requestProfile = JSON.parse(profileBlocks[0]!.text.slice(profilePrefix.length)) as {
      evidence: Array<{ kind: string; referenceId: string; summary: string }>
    }
    const requestAttestation = requestProfile.evidence.filter(item => item.kind === "user_self_attestation")
    expect(requestAttestation.map(item => ({ referenceId: item.referenceId, summary: JSON.parse(item.summary) })))
      .toEqual(attestation.map(item => ({ referenceId: item.referenceId, summary: JSON.parse(item.summary) })))
    const systemText = modelRequest.messages.filter(message => message.role === "system").flatMap(message => message.content)
      .filter((part): part is Extract<(typeof modelRequest.messages)[number]["content"][number], { type: "text" }> => part.type === "text")
      .map(part => part.text).join("\n")
    expect(systemText).not.toContain(answeredQuestion.answer)
    expect(systemText).not.toContain(priorQuestion.answer)
    expect(modelText.includes("not independent proof of external facts")).toBe(true)
    expect(modelText.includes("action, approval, consent, credential, or submission authority")).toBe(true)
    expect(executed.usageAuthorizations).toHaveLength(1)
    expect(executed.usageAuthorizations[0]?.executionOwner).toMatchObject({ kind: "task", taskId: rootTaskIds[0], rootTaskId: ids.root })
    expect(executed.usageSettlements).toEqual([{ status: "success", inputTokens: 173, outputTokens: 41, estimatedCostUsd: 0.013 }])

    const completedControl = await pool!.query<{ status: string; attemptCount: number; failureReason: string | null; result: unknown }>(
      `SELECT "status", "attemptCount", "failureReason", "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [rootTaskIds[0]])
    expect(completedControl.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, failureReason: null })
    const nativeReport = completedControl.rows[0]?.result && typeof completedControl.rows[0].result === "object"
      ? (completedControl.rows[0].result as Record<string, unknown>).nativeVerificationReport : null
    const attachedReport = parseNativeVerificationReport(nativeReport, rootControl, rootPacket, completedControl.rows[0]!.attemptCount)
    expect(attachedReport?.disposition).toBe("passed")
    expect(attachedReport?.criteria.find(item => item.criterionId === "criterion-2")?.evidenceReferenceIds).toEqual(privateReferenceIds)
    const controlSteps = await pool!.query<{ status: string; finishReason: string; inputTokens: number; outputTokens: number; cost: string }>(
      `SELECT "status", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd" AS "cost" FROM "agent_steps"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3`, [ids.session, ids.turn, rootTaskIds[0]])
    expect(controlSteps.rows).toHaveLength(1)
    expect(controlSteps.rows[0]).toMatchObject({ status: "completed", finishReason: "stop", inputTokens: 173, outputTokens: 41 })
    expect(Number(controlSteps.rows[0]?.cost)).toBeCloseTo(0.013)
    const controlToolCalls = await pool!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_call'`, [ids.session, ids.turn, rootTaskIds[0]])
    expect(controlToolCalls.rows[0]?.count).toBe(0)
    const reservation = await pool!.query<{ status: string }>(`SELECT "status" FROM "agent_tree_budget_reservations"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3`, [ids.session, ids.turn, rootTaskIds[0]])
    expect(reservation.rows).toHaveLength(1)
    expect(reservation.rows[0]?.status).toBe("consumed")

    const publicResult = projectNativeVerificationResult(completedControl.rows[0]?.result)
    const publicResultJson = JSON.stringify(publicResult)
    expect(publicResult).toMatchObject({ nativeVerificationFeedback: { disposition: "passed", criteria: [
      { criterionId: "criterion-1", disposition: "passed", evidenceReferenceIds: expect.arrayContaining([rootPacket.target.referenceId]) },
      { criterionId: "criterion-2", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: [] },
    ] } })
    expect(publicResult).not.toHaveProperty("nativeVerificationReport")
    expect(publicResultJson.includes(answeredQuestion.answer)).toBe(false)
    expect(publicResultJson.includes(priorQuestion.answer)).toBe(false)
    for (const referenceId of privateReferenceIds) expect(publicResultJson.includes(referenceId)).toBe(false)
    expect(publicResultJson.includes(rootPacket.target.referenceId)).toBe(true)
    const [publicItems, publicEvents, publicOutbox] = await Promise.all([
      pool!.query<{ content: unknown }>(`SELECT "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3`,
        [ids.session, ids.turn, rootTaskIds[0]]),
      pool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3`,
        [ids.session, ids.turn, rootTaskIds[0]]),
      pool!.query<{ payload: unknown }>(`SELECT outbox."payload" FROM "agent_outbox" AS outbox
        JOIN "agent_events" AS event ON event."id" = outbox."payload"->>'eventId'
        WHERE outbox."aggregateId" = $1 AND event."turnId" = $2 AND event."taskId" = $3`,
        [ids.session, ids.turn, rootTaskIds[0]]),
    ])
    expect(publicEvents.rows.length).toBeGreaterThan(0)
    expect(publicOutbox.rows.length).toBeGreaterThan(0)
    const publicRecords = JSON.stringify({ items: publicItems.rows, events: publicEvents.rows, outbox: publicOutbox.rows })
    expect(publicRecords.includes(answeredQuestion.answer)).toBe(false)
    expect(publicRecords.includes(priorQuestion.answer)).toBe(false)
    for (const referenceId of privateReferenceIds) expect(publicRecords.includes(referenceId)).toBe(false)

    const recovered = await port.readRecoverableGoal(scope)
    expect(recovered).toMatchObject({ status: "passed", candidateText })
    if (!recovered || recovered.status !== "passed" || !recovered.witness) throw new Error("native_verification_candidate_not_recovered")
    const witness = recovered.witness
    const client: PoolClient = await pool!.connect()
    let proofTransactionOpen = false
    try {
      await client.query("BEGIN")
      proofTransactionOpen = true
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
      const accepted = await readNativeVerificationTerminalProofWithClient(client, {
        scope, candidateText, witness,
      })
      await client.query("ROLLBACK")
      proofTransactionOpen = false
      expect(accepted).toBe(true)
    } finally {
      if (proofTransactionOpen) await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
    const expectStaleEvidenceRejected = async (mutate: (client: PoolClient) => Promise<unknown>) => {
      const client: PoolClient = await pool!.connect()
      let transactionOpen = false
      try {
        await client.query("BEGIN")
        transactionOpen = true
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        const before = await readNativeVerificationTerminalProofWithClient(client, { scope, candidateText, witness })
        expect(before).toBe(true)
        await client.query("SAVEPOINT native_evidence_mutation")
        await mutate(client)
        const accepted = await readNativeVerificationTerminalProofWithClient(client, { scope, candidateText, witness })
        await client.query("ROLLBACK TO SAVEPOINT native_evidence_mutation")
        const restored = await readNativeVerificationTerminalProofWithClient(client, { scope, candidateText, witness })
        await client.query("ROLLBACK")
        transactionOpen = false
        expect(accepted).toBe(false)
        expect(restored).toBe(true)
      } finally {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
        client.release()
      }
    }
    const expectCommittedEvidenceRejected = async () => {
      const client: PoolClient = await pool!.connect()
      let transactionOpen = false
      try {
        await client.query("BEGIN")
        transactionOpen = true
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        const accepted = await readNativeVerificationTerminalProofWithClient(client, { scope, candidateText, witness })
        await client.query("ROLLBACK")
        transactionOpen = false
        expect(accepted).toBe(false)
      } finally {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
        client.release()
      }
    }
    const originalCall = { toolCallId: "lookup-576", toolName: "source.lookup", toolVersion: "1", status: "completed", input: { query: "fact 42" } }
    const mutateCall = async (client: PoolClient, content: unknown) => client.query(`UPDATE "agent_items" SET "revision" = "revision" + 1, "content" = $2::jsonb WHERE "id" = $1`,
      [ids.toolCallItem, JSON.stringify(content)])
    const mutateResult = async (client: PoolClient, content: unknown) => client.query(`UPDATE "agent_items" SET "revision" = "revision" + 1, "content" = $2::jsonb WHERE "id" = $1`,
      [ids.toolItem, JSON.stringify(content)])

    await expectStaleEvidenceRejected(client => mutateCall(client, { ...originalCall, toolName: "source.other" }))
    await expectStaleEvidenceRejected(client => mutateCall(client, { ...originalCall, status: "failed" }))
    await expectStaleEvidenceRejected(client => mutateCall(client, { ...originalCall, input: { query: "changed after review" } }))
    await expectStaleEvidenceRejected(client => mutateResult(client, { toolCallId: "lookup-576", output: { facts: ["changed after review"] }, errorCode: null }))
    await expectStaleEvidenceRejected(client => mutateCall(client, { ...originalCall, toolCallId: "mismatched-call" }))
    await expectStaleEvidenceRejected(async client => {
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP)`,
      [ids.duplicateToolItem, ids.session, ids.turn, ids.childStep, ids.child, JSON.stringify({ toolCallId: "lookup-576", output: toolOutput, errorCode: null })])
      const graph = await loadTaskGraph(client, scope, false)
      const state = await loadNativeVerificationOwnedState(client, scope, graph.snapshot, false)
      const node = state.snapshot?.nodes.find(value => value.taskId === ids.child)
      const target = node ? nativeVerificationTarget(state, node) : null
      expect(target).not.toBeNull()
      await expect(target ? buildNativeChildPacketContent(client, state, target) : Promise.resolve(null)).resolves.toBeNull()
    })
    await expectStaleEvidenceRejected(client => client.query(`UPDATE "agent_items"
      SET "content" = jsonb_set("content", '{answer}', $2::jsonb, false) WHERE "id" = $1`,
    [priorQuestion.itemId, JSON.stringify("Changed historical user answer without changing its item revision.")]))
    await expectStaleEvidenceRejected(client => client.query(`DELETE FROM "agent_events" WHERE "id" = $1 AND "itemId" = $2`,
    [priorQuestion.answerEventId, priorQuestion.itemId]))
    await expectStaleEvidenceRejected(client => client.query(`DELETE FROM "agent_items" WHERE "id" = $1`, [priorQuestion.resultItemId]))
    await expectStaleEvidenceRejected(client => client.query(`UPDATE "agent_turns" SET "status" = 'interrupted' WHERE "id" = $1`, [priorQuestion.turnId]))
    await expectStaleEvidenceRejected(client => client.query(`UPDATE "agent_items"
      SET "content" = jsonb_set("content", '{answer}', $2::jsonb, false) WHERE "id" = $1`,
    [answeredQuestion.itemId, JSON.stringify("Edited persisted answer with the original item revision.")]))

    const answerBaselineClient = await pool!.connect()
    try {
      await answerBaselineClient.query("BEGIN")
      await answerBaselineClient.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
      await expect(readNativeVerificationTerminalProofWithClient(answerBaselineClient, { scope, candidateText, witness })).resolves.toBe(true)
      await answerBaselineClient.query("ROLLBACK")
    } catch (error) {
      await answerBaselineClient.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally { answerBaselineClient.release() }
    await pool!.query(`UPDATE "agent_items" SET "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [answeredQuestion.itemId])
    await expectCommittedEvidenceRejected()
    await expect(port.readRecoverableGoal(scope)).resolves.toBeNull()
  }, 60_000)

  it("persists and replays an overflow-key native wait with valid long owned identities", async () => {
    const sizedId = (prefix: string, length: number) => {
      const stem = `${prefix}-${randomUUID()}`
      if (stem.length > length) throw new Error("native_verification_wait_fixture_id_invalid")
      return stem + "x".repeat(length - stem.length)
    }
    const long = {
      session: sizedId("native-wait-session", 100), turn: sizedId("native-wait-turn", 100),
      root: sizedId("native-wait-root", 120), step: sizedId("native-wait-step", 120), target: sizedId("native-wait-target", 120),
    }
    await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Long native wait fixture', 'running', 'test', CURRENT_TIMESTAMP)`, [long.session, ids.user])
    await pool!.query(`INSERT INTO "agent_turns"
      ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
       "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        $5, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
    [long.turn, long.session, ids.user, JSON.stringify({ goal: "Long native wait objective" }), ids.turnOwner])
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
       "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Long native wait objective',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
        1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [long.root, long.session, long.turn, ids.taskOwner])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [long.root])
    await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [long.root, long.turn])
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
       "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/root/native-wait-target', 1, 'analyst', 'research', 'queued', 'Wait target',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 2, CURRENT_TIMESTAMP)`,
    [long.target, long.session, long.turn, long.root])
    await pool!.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 0, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [long.step, long.session, long.turn, long.root])

    const longScope: TaskGraphExecutionScope = {
      ...scope, sessionId: long.session, turnId: long.turn, rootTaskId: long.root, parentTaskId: long.root, stepId: long.step,
    }
    const port = createPgDurableWaitPort(pool!)
    const first = await waitForNativeVerification({ port, scope: longScope, targetTaskIds: [long.target] })
    const replay = await waitForNativeVerification({
      port, scope: { ...longScope, turnLeaseOwner: "rotated-owner", turnLeaseVersion: 2 }, targetTaskIds: [long.target, long.target],
    })
    expect(first.status).toBe("waiting")
    expect(replay).toMatchObject({ waitId: first.waitId, status: "waiting" })
    const persisted = await pool!.query<{ count: number; identityBytes: number; isVersioned: boolean }>(
      `SELECT COUNT(*)::int AS "count", MAX(octet_length("idempotencyKey"))::int AS "identityBytes",
        BOOL_AND("idempotencyKey" LIKE 'native-verification:v2:%') AS "isVersioned"
       FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3`,
      [long.session, long.turn, long.root])
    expect(persisted.rows[0]).toEqual({ count: 1, identityBytes: expect.any(Number), isVersioned: true })
    expect(persisted.rows[0]!.identityBytes).toBeLessThanOrEqual(256)
  }, 30_000)
})
