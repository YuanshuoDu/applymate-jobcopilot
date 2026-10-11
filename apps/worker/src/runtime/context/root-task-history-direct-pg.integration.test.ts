import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "../subagents/task-graph-snapshot.js"
import { createPgDirectRootTaskHistoryStore, type DirectRootTaskHistoryLoadInput } from "./root-task-history-direct-store.js"
import type { TurnLease } from "../turns/lease.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Root-task history needs the disposable PostgreSQL CI service")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Root-task history requires the dedicated disposable PostgreSQL URL")
  }
  return value
}

type Source = Readonly<{
  turnId: string; rootTaskId: string; childId: string; finalItemId: string; sessionId: string; userId: string
  goal: string; criteria: readonly string[]; input: unknown; startSequence: number
  status?: "completed" | "failed" | "interrupted"; rootStatus?: "completed" | "failed" | "interrupted"
  correlationTargetId?: string; stepStatus?: "completed" | "streaming" | "failed"
  stepReceipt?: "missing" | "mismatched" | "duplicate"
}>

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip, suffix = randomUUID()
const userId = `root-history-user-${suffix}`, otherUserId = `root-history-other-user-${suffix}`
const sessionId = `root-history-session-${suffix}`, otherSessionId = `root-history-other-session-${suffix}`
const foreignSessionId = `root-history-foreign-session-${suffix}`
const currentTurnId = `root-history-current-turn-${suffix}`, currentRootTaskId = `root-history-current-root-${suffix}`
const currentStepId = `root-history-current-step-${suffix}`, workerId = `worker-${suffix}`
const objective = "Plan an engineering search"
const criteria = ["Keep the search within the saved locations"]
const matching: Source[] = [
  { turnId: `root-history-source-a-${suffix}`, rootTaskId: `root-history-root-a-${suffix}`, childId: `root-history-child-a-${suffix}`,
    finalItemId: `root-history-final-a-${suffix}`, sessionId, userId, goal: objective, criteria, input: { goal: ` ${objective} `, successCriteria: criteria }, startSequence: 1 },
  { turnId: `root-history-source-b-${suffix}`, rootTaskId: `root-history-root-b-${suffix}`, childId: `root-history-child-b-${suffix}`,
    finalItemId: `root-history-final-b-${suffix}`, sessionId, userId, goal: objective, criteria,
    input: { input: { goal: objective, successCriteria: criteria } }, startSequence: 5, status: "failed" },
]
const mismatched: Source = { turnId: `root-history-mismatch-${suffix}`, rootTaskId: `root-history-mismatch-root-${suffix}`,
  childId: `root-history-mismatch-child-${suffix}`, finalItemId: `root-history-mismatch-final-${suffix}`, sessionId, userId,
  goal: "A different search", criteria, input: { goal: "A different search", successCriteria: criteria }, startSequence: 8 }
const changedCriteria: Source = { turnId: `root-history-criteria-${suffix}`, rootTaskId: `root-history-criteria-root-${suffix}`,
  childId: `root-history-criteria-child-${suffix}`, finalItemId: `root-history-criteria-final-${suffix}`, sessionId, userId,
  goal: objective, criteria: ["Different criterion"], input: { goal: objective, successCriteria: criteria }, startSequence: 12 }
const selectedJob: Source = { turnId: `root-history-selected-job-${suffix}`, rootTaskId: `root-history-selected-job-root-${suffix}`,
  childId: `root-history-selected-job-child-${suffix}`, finalItemId: `root-history-selected-job-final-${suffix}`, sessionId, userId,
  goal: objective, criteria, input: { input: { goal: objective, successCriteria: criteria, selectedJobPreparation: null } }, startSequence: 16 }
const otherSession: Source = { turnId: `root-history-other-session-turn-${suffix}`, rootTaskId: `root-history-other-session-root-${suffix}`,
  childId: `root-history-other-session-child-${suffix}`, finalItemId: `root-history-other-session-final-${suffix}`,
  sessionId: otherSessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 1 }
const foreignScopeCorrelation: Source = { turnId: `root-history-foreign-step-turn-${suffix}`, rootTaskId: `root-history-foreign-step-root-${suffix}`,
  childId: `root-history-foreign-step-child-${suffix}`, finalItemId: `root-history-foreign-step-final-${suffix}`,
  sessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 24,
  correlationTargetId: `source-step-${otherSession.turnId}` }
const otherUser: Source = { turnId: `root-history-other-user-turn-${suffix}`, rootTaskId: `root-history-other-user-root-${suffix}`,
  childId: `root-history-other-user-child-${suffix}`, finalItemId: `root-history-other-user-final-${suffix}`,
  sessionId: foreignSessionId, userId: otherUserId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 1 }
const future: Source = { turnId: `root-history-future-turn-${suffix}`, rootTaskId: `root-history-future-root-${suffix}`,
  childId: `root-history-future-child-${suffix}`, finalItemId: `root-history-future-final-${suffix}`,
  sessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 101 }
const inconsistentTerminal: Source = { turnId: `root-history-terminal-mismatch-turn-${suffix}`, rootTaskId: `root-history-terminal-mismatch-root-${suffix}`,
  childId: `root-history-terminal-mismatch-child-${suffix}`, finalItemId: `root-history-terminal-mismatch-final-${suffix}`,
  sessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 20,
  status: "completed", rootStatus: "failed" }
const streamingTerminalStep: Source = { turnId: `root-history-streaming-step-turn-${suffix}`, rootTaskId: `root-history-streaming-step-root-${suffix}`,
  childId: `root-history-streaming-step-child-${suffix}`, finalItemId: `root-history-streaming-step-final-${suffix}`, sessionId, userId,
  goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 28, stepStatus: "streaming" }
const failedTerminalStep: Source = { turnId: `root-history-failed-step-turn-${suffix}`, rootTaskId: `root-history-failed-step-root-${suffix}`,
  childId: `root-history-failed-step-child-${suffix}`, finalItemId: `root-history-failed-step-final-${suffix}`, sessionId, userId,
  goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 32, stepStatus: "failed" }
const missingStepReceipt: Source = { turnId: `root-history-missing-step-event-turn-${suffix}`, rootTaskId: `root-history-missing-step-event-root-${suffix}`,
  childId: `root-history-missing-step-event-child-${suffix}`, finalItemId: `root-history-missing-step-event-final-${suffix}`, sessionId, userId,
  goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 36, stepReceipt: "missing" }
const mismatchedStepReceipt: Source = { turnId: `root-history-mismatched-step-event-turn-${suffix}`, rootTaskId: `root-history-mismatched-step-event-root-${suffix}`,
  childId: `root-history-mismatched-step-event-child-${suffix}`, finalItemId: `root-history-mismatched-step-event-final-${suffix}`, sessionId, userId,
  goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 40, stepReceipt: "mismatched" }
const duplicateStepReceipt: Source = { turnId: `root-history-duplicate-step-event-turn-${suffix}`, rootTaskId: `root-history-duplicate-step-event-root-${suffix}`,
  childId: `root-history-duplicate-step-event-child-${suffix}`, finalItemId: `root-history-duplicate-step-event-final-${suffix}`, sessionId, userId,
  goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 44, stepReceipt: "duplicate" }
let pool: PgPool | undefined
let lease: TurnLease

async function insertUser(id: string): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [id, `${id}@example.invalid`])
}

async function insertSession(id: string, owner: string, sequence: number): Promise<void> {
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt")
    VALUES ($1, $2, $3, 'running', 'test', $4, CURRENT_TIMESTAMP)`, [id, owner, objective, sequence])
}

async function insertSource(source: Source): Promise<void> {
  const status = source.status ?? "completed"
  const rootStatus = source.rootStatus ?? status
  const graph = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "scout", templateId: "scout",
    goal: "Find matching roles", successCriteria: ["Find one role"], dependsOn: [], depth: 1, taskId: source.childId }] })
  await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
    "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, $4, 'user', $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $6, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
  [source.turnId, source.sessionId, source.userId, status, JSON.stringify(source.input), source.rootTaskId])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $1, NULL, '/source', 0, 'orchestrator', 'root', $4, $5, '[]'::jsonb, $6::jsonb, '[]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [source.rootTaskId, source.sessionId, source.turnId, rootStatus, source.goal, JSON.stringify(source.criteria)])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, '/source/scout', 1, 'scout', 'scout', 'completed', 'Find matching roles', '[]'::jsonb, '["Find one role"]'::jsonb,
      '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP)`,
  [source.childId, source.sessionId, source.turnId, source.rootTaskId])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ($6, $2, $3, $4, 'agent_message', 'completed', 0, '{"text":"done"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [taskGraphItemId(source.rootTaskId), source.sessionId, source.turnId, source.rootTaskId, JSON.stringify(graph), source.finalItemId])
  const terminalSequence = source.startSequence + (status === "completed" ? 3 : 2)
  const terminalType = status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.interrupted"
  const terminalItemId = status === "completed" ? source.finalItemId : null
  const sourceStepId = `source-step-${source.turnId}`
  if (status === "completed") {
    await pool!.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, $5, 0, '[]'::jsonb, '{}'::jsonb)`,
    [sourceStepId, source.sessionId, source.turnId, source.rootTaskId, source.stepStatus ?? "completed"])
    if (source.stepReceipt !== "missing") {
      const count = source.stepReceipt === "duplicate" ? 2 : 1
      for (let index = 0; index < count; index += 1) {
        const stepPayload = { stepId: sourceStepId, status: source.stepReceipt === "mismatched" ? "failed" : "completed", taskId: source.rootTaskId }
        const key = `turn:${source.turnId}:event:step-completed:${sourceStepId}${index ? `:duplicate-${index}` : ""}`
        await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
          VALUES ($1, $2, $3, NULL, $4, $5, 'step.completed', 'orchestrator', $6, $7, $8::jsonb)`,
        [`root-history-step-completed-${index}-${source.turnId}`, source.sessionId, source.turnId, source.rootTaskId,
          source.startSequence + 1 + index, sourceStepId, key, JSON.stringify(stepPayload)])
      }
    }
  }
  const correlationId = status === "completed" ? (source.correlationTargetId ?? sourceStepId) : source.turnId
  const errorCode = status === "failed" ? "task_failed" : status === "interrupted" ? "interrupted" : undefined
  const terminalKey = status === "completed" ? `turn:${source.turnId}:event:turn-completed`
    : status === "failed" ? `turn:${source.turnId}:event:turn-failed:${errorCode}` : `turn:${source.turnId}:event:turn-interrupted`
  const terminalPayload = status === "completed" ? { turnId: source.turnId, taskId: source.rootTaskId, finalItemId: source.finalItemId }
    : status === "failed" ? { turnId: source.turnId, taskId: source.rootTaskId, errorCode, finalItemId: null }
      : { turnId: source.turnId, taskId: source.rootTaskId, errorCode }
  await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, NULL, $4, $5, 'turn.started', 'orchestrator', $3, $6, $7::jsonb),
      ($8, $2, $3, $9, $4, $10, $11, 'orchestrator', $12, $13, $14::jsonb)`,
  [`root-history-start-${source.turnId}`, source.sessionId, source.turnId, source.rootTaskId, source.startSequence,
    `turn:${source.turnId}:event:turn-started`, JSON.stringify({ goal: source.goal, taskId: source.rootTaskId, rootTaskId: source.rootTaskId }),
    `root-history-terminal-${source.turnId}`, terminalItemId, terminalSequence, terminalType, correlationId, terminalKey,
    JSON.stringify(terminalPayload)])
}

describePg("direct Root-task history PostgreSQL source validation", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    lease = { turnId: currentTurnId, sessionId, userId, ownerId: workerId, leaseVersion: 1,
      leaseStartedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 5 * 60_000) }
    await insertUser(userId)
    await insertUser(otherUserId)
    await insertSession(sessionId, userId, 100)
    await insertSession(otherSessionId, userId, 4)
    await insertSession(foreignSessionId, otherUserId, 4)
    for (const source of matching) await insertSource(source)
    await insertSource(mismatched)
    await insertSource(changedCriteria)
    await insertSource(selectedJob)
    await insertSource(otherSession)
    await insertSource(foreignScopeCorrelation)
    await insertSource(otherUser)
    await insertSource(future)
    await insertSource(inconsistentTerminal)
    await insertSource(streamingTerminalStep)
    await insertSource(failedTerminalStep)
    await insertSource(missingStepReceipt)
    await insertSource(mismatchedStepReceipt)
    await insertSource(duplicateStepReceipt)
    const input = { goal: objective, successCriteria: criteria }
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
      "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6,
        CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
    [currentTurnId, sessionId, userId, JSON.stringify(input), currentRootTaskId, workerId])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $1, NULL, '/current', 0, 'orchestrator', 'root', 'running', $4, '[]'::jsonb, $5::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 3, $6, CURRENT_TIMESTAMP + INTERVAL '5 minutes', NULL, CURRENT_TIMESTAMP)`,
    [currentRootTaskId, sessionId, currentTurnId, objective, JSON.stringify(criteria), workerId])
    await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [currentStepId, sessionId, currentTurnId, currentRootTaskId])
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, NULL, $4, 100, 'turn.started', 'orchestrator', $3, $5, $6::jsonb)`,
    [`root-history-current-start-${suffix}`, sessionId, currentTurnId, currentRootTaskId,
      `turn:${currentTurnId}:event:turn-started`, JSON.stringify({ goal: objective, taskId: currentRootTaskId, rootTaskId: currentRootTaskId })])
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [[userId, otherUserId]]).catch(() => undefined)
      await pool.end()
    }
  })

  it("returns same-user/session Roots with the exact canonical objective and a distinct source Root ID", async () => {
    const input: DirectRootTaskHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, now: new Date() }
    const history = await createPgDirectRootTaskHistoryStore(pool!).load(input)

    expect(history.map(item => item.sourceTurnId)).toEqual([matching[1]!.turnId, matching[0]!.turnId])
    expect(history.map(item => item.sourceRootTaskId)).toEqual([matching[1]!.rootTaskId, matching[0]!.rootTaskId])
    expect(history.map(item => item.terminalSequence)).toEqual([7n, 4n])
    expect(history.every(item => item.taskGraph.nodes.length === 1)).toBe(true)
    expect(history.some(item => item.sourceTurnId === matching[0]!.turnId)).toBe(true)
    expect(history.some(item => [mismatched.turnId, changedCriteria.turnId, selectedJob.turnId,
      otherSession.turnId, foreignScopeCorrelation.turnId, otherUser.turnId, future.turnId, inconsistentTerminal.turnId,
      streamingTerminalStep.turnId, failedTerminalStep.turnId, missingStepReceipt.turnId, mismatchedStepReceipt.turnId,
      duplicateStepReceipt.turnId].includes(item.sourceTurnId))).toBe(false)
  })
})
