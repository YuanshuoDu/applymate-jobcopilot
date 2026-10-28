import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "../subagents/task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { createPgDirectRootTaskHistoryStore, type DirectRootTaskHistoryLoadInput } from "./root-task-history-direct-store.js"
import { OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION, updateRootObjectiveHistoryProjection } from "./objective-history-projection.js"
import { projectRootTaskHistory, type ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import { acquireRootTaskHistoryChronologyLock, appendRootTaskHistoryChronologyWitness } from "./root-task-history-chronology-witness.js"
import type { TurnLease } from "../turns/lease.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const SOURCE_SEQUENCE_STRIDE = 6
const CURRENT_START_SEQUENCE = 10_000
const FIXTURE_EVENT_SEQUENCE = 20_000
const SCHEDULED_FIXTURE_EVENT_SEQUENCE = 30_000
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

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { open, promise }
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), 10_000) }),
  ]).finally(() => { if (timeout) clearTimeout(timeout) })
}

function observeQueries(pool: PgPool, afterQuery: (sql: string, values?: readonly unknown[]) => Promise<void>): Pick<PgPool, "connect"> {
  return {
    connect: async () => {
      const client = await pool.connect()
      const originalQuery = client.query.bind(client)
      const query = async (sql: string, values?: readonly unknown[]) => {
        const result = await originalQuery(sql, values ? [...values] : undefined)
        await afterQuery(sql, values)
        return result
      }
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") return query
          const value = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined
}

type Source = Readonly<{
  turnId: string; rootTaskId: string; childId: string; finalItemId: string; sessionId: string; userId: string
  goal: string; criteria: readonly string[]; input: unknown; startSequence: number
  status?: "completed" | "failed" | "interrupted"; rootStatus?: "completed" | "failed" | "interrupted"
  correlationTargetId?: string; stepStatus?: "completed" | "streaming" | "failed"
  stepReceipt?: "missing" | "mismatched" | "duplicate"
  scoutResult?: unknown
  completedChildren?: readonly Readonly<{
    key: string; templateId: string; role: string; taskType: string; goal: string; successCriteria: readonly string[]; result?: unknown
  }>[]
  failureChildren?: readonly Readonly<{ key: string; templateId: string; role: string; taskType: string; failureReason: string }>[]
  turnSource?: string; terminalCreatedAt?: Date
}>

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip, suffix = randomUUID()
const userId = `root-history-user-${suffix}`, otherUserId = `root-history-other-user-${suffix}`
const sessionId = `root-history-session-${suffix}`, otherSessionId = `root-history-other-session-${suffix}`
const scheduledSessionId = `root-history-scheduled-session-${suffix}`
const foreignSessionId = `root-history-foreign-session-${suffix}`
const archivedSessionId = `root-history-archived-session-${suffix}`
const currentTurnId = `root-history-current-turn-${suffix}`, currentRootTaskId = `root-history-current-root-${suffix}`
const currentStepId = `root-history-current-step-${suffix}`, workerId = `worker-${suffix}`
const scheduledCurrentTurnId = `root-history-scheduled-current-turn-${suffix}`
const scheduledCurrentRootTaskId = `root-history-scheduled-current-root-${suffix}`
const scheduledCurrentStepId = `root-history-scheduled-current-step-${suffix}`
const currentStartCreatedAt = new Date("2030-01-01T00:00:00.000Z")
const objective = "Plan an engineering search"
const criteria = ["Keep the search within the saved locations"]
const scheduledSnapshot = (targetRoles: readonly string[], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
  targetRoles, targetLocations: ["Dublin"], minScore: 70,
  dailyCap: 10, requireApproval: true, autoApply: false, ...overrides,
})

function scheduledTurnInput(snapshot: unknown) {
  return { goal: objective, successCriteria: criteria, automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot }
}
function reportedScoutResult(finalItemId: string) {
  return { finalItemId, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
    structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "partial", summary: "private summary",
      evidence: [{ id: "e1", kind: "job", ref: "job-1", source: "greenhouse" }],
      candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://private.example/1", evidenceIds: ["e1"] }] } }
}
const matching: Source[] = [
  { turnId: `root-history-source-a-${suffix}`, rootTaskId: `root-history-root-a-${suffix}`, childId: `root-history-child-a-${suffix}`,
    finalItemId: `root-history-final-a-${suffix}`, sessionId, userId, goal: objective, criteria, input: { goal: ` ${objective} `, successCriteria: criteria }, startSequence: 1,
    terminalCreatedAt: new Date("2020-01-01T00:00:00.000Z"), scoutResult: reportedScoutResult(`root-history-final-a-${suffix}`) },
  { turnId: `root-history-source-b-${suffix}`, rootTaskId: `root-history-root-b-${suffix}`, childId: `root-history-child-b-${suffix}`,
    finalItemId: `root-history-final-b-${suffix}`, sessionId, userId, goal: objective, criteria,
    input: { input: { goal: objective, successCriteria: criteria } }, startSequence: 5, status: "failed",
    terminalCreatedAt: new Date("2021-01-01T00:00:00.000Z"),
    failureChildren: [
      { key: "setup", templateId: "scout", role: "scout", taskType: "job_discovery", failureReason: "selected_job_context_unavailable" },
      { key: "resume", templateId: "analyst", role: "analyst", taskType: "job_analysis", failureReason: "child_resume_unavailable" },
      { key: "output", templateId: "cover_letter_writer", role: "writer", taskType: "cover_letter", failureReason: "invalid_structured_result" },
    ] },
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
  sessionId: otherSessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 1,
  terminalCreatedAt: new Date("2022-01-01T00:00:00.000Z"),
  scoutResult: reportedScoutResult(`root-history-other-session-final-${suffix}`),
  failureChildren: [{ key: "foreign-session", templateId: "scout", role: "scout", taskType: "job_discovery", failureReason: "selected_job_context_unavailable" }] }
const crossEqualTimeHigherTurnId: Source = { turnId: `${otherSession.turnId}-z`, rootTaskId: `root-history-equal-time-root-${suffix}`,
  childId: `root-history-equal-time-child-${suffix}`, finalItemId: `root-history-equal-time-final-${suffix}`,
  sessionId: otherSessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 17,
  terminalCreatedAt: new Date("2022-01-01T00:00:00.000Z"), completedChildren: [
    { key: "analyst", templateId: "analyst", role: "analyst", taskType: "job_analysis",
      goal: "Assess a matching role", successCriteria: ["Assess the role"] },
  ] }
const crossWrongSource: Source = { turnId: `root-history-cross-source-${suffix}`, rootTaskId: `root-history-cross-source-root-${suffix}`,
  childId: `root-history-cross-source-child-${suffix}`, finalItemId: `root-history-cross-source-final-${suffix}`,
  sessionId: otherSessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 5,
  turnSource: "automation", terminalCreatedAt: new Date("2023-01-01T00:00:00.000Z") }
const crossWrongOrigin: Source = { turnId: `root-history-cross-origin-${suffix}`, rootTaskId: `root-history-cross-origin-root-${suffix}`,
  childId: `root-history-cross-origin-child-${suffix}`, finalItemId: `root-history-cross-origin-final-${suffix}`,
  sessionId: otherSessionId, userId, goal: objective, criteria,
  input: { goal: objective, successCriteria: criteria, intent: { kind: "interactive_discovery_shortlist", version: 1 } }, startSequence: 9,
  terminalCreatedAt: new Date("2024-01-01T00:00:00.000Z") }
const sameSessionUnrelated: Source[] = Array.from({ length: 65 }, (_, index): Source => {
  const unrelatedObjective = `Unrelated indexed history objective ${index}`
  return { turnId: `root-history-same-filler-${index}-${suffix}`, rootTaskId: `root-history-same-filler-root-${index}-${suffix}`,
    childId: `root-history-same-filler-child-${index}-${suffix}`, finalItemId: `root-history-same-filler-final-${index}-${suffix}`,
    sessionId, userId, goal: unrelatedObjective, criteria, input: { goal: unrelatedObjective, successCriteria: criteria },
    startSequence: 200 + index * 4, terminalCreatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)) }
})
const crossSessionWrongOriginFillers: Source[] = Array.from({ length: 65 }, (_, index): Source => ({
  turnId: `root-history-cross-filler-${index}-${suffix}`, rootTaskId: `root-history-cross-filler-root-${index}-${suffix}`,
  childId: `root-history-cross-filler-child-${index}-${suffix}`, finalItemId: `root-history-cross-filler-final-${index}-${suffix}`,
  sessionId: otherSessionId, userId, goal: objective, criteria,
  input: { goal: objective, successCriteria: criteria, intent: { kind: "interactive_discovery_shortlist", version: 1 } },
  startSequence: 200 + index * 4, terminalCreatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)),
}))
const archivedSource: Source = { turnId: `root-history-archived-${suffix}`, rootTaskId: `root-history-archived-root-${suffix}`,
  childId: `root-history-archived-child-${suffix}`, finalItemId: `root-history-archived-final-${suffix}`,
  sessionId: archivedSessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 1,
  terminalCreatedAt: new Date("2025-01-01T00:00:00.000Z") }
const foreignScopeCorrelation: Source = { turnId: `root-history-foreign-step-turn-${suffix}`, rootTaskId: `root-history-foreign-step-root-${suffix}`,
  childId: `root-history-foreign-step-child-${suffix}`, finalItemId: `root-history-foreign-step-final-${suffix}`,
  sessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 24,
  correlationTargetId: `source-step-${otherSession.turnId}` }
const otherUser: Source = { turnId: `root-history-other-user-turn-${suffix}`, rootTaskId: `root-history-other-user-root-${suffix}`,
  childId: `root-history-other-user-child-${suffix}`, finalItemId: `root-history-other-user-final-${suffix}`,
  sessionId: foreignSessionId, userId: otherUserId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 1,
  failureChildren: [{ key: "foreign-user", templateId: "analyst", role: "analyst", taskType: "job_analysis", failureReason: "child_resume_unavailable" }] }
const future: Source = { turnId: `root-history-future-turn-${suffix}`, rootTaskId: `root-history-future-root-${suffix}`,
  childId: `root-history-future-child-${suffix}`, finalItemId: `root-history-future-final-${suffix}`,
  sessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 2101,
  terminalCreatedAt: new Date("2031-01-01T00:00:00.000Z") }
const equalCutoff: Source = { turnId: `root-history-equal-cutoff-${suffix}`, rootTaskId: `root-history-equal-cutoff-root-${suffix}`,
  childId: `root-history-equal-cutoff-child-${suffix}`, finalItemId: `root-history-equal-cutoff-final-${suffix}`,
  sessionId: otherSessionId, userId, goal: objective, criteria, input: { goal: objective, successCriteria: criteria }, startSequence: 13,
  terminalCreatedAt: currentStartCreatedAt }
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

function terminalEventKey(source: Source): string {
  const status = source.status ?? "completed"
  return status === "completed" ? `turn:${source.turnId}:event:turn-completed`
    : status === "failed" ? `turn:${source.turnId}:event:turn-failed:task_failed`
      : `turn:${source.turnId}:event:turn-interrupted`
}

type EventReceipt = Readonly<{
  id: string; sessionId: string; turnId: string; taskId: string; sequence: number
  itemId: string | null; type: string; correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown
}>

async function insertEventOutbox(client: PoolClient, event: EventReceipt): Promise<void> {
  const payload = { eventId: event.id, sessionId: event.sessionId, turnId: event.turnId, taskId: event.taskId,
    itemId: event.itemId, sequence: String(event.sequence), type: event.type, actor: "orchestrator",
    correlationId: event.correlationId, causationId: event.causationId, idempotencyKey: event.idempotencyKey, payload: event.payload }
  await client.query(`INSERT INTO "agent_outbox" ("id","topic","aggregateId","idempotencyKey","payload")
    VALUES ($1,'agent.events',$2,$3,$4::jsonb)`,
  [`agent-outbox-${event.id}`, event.sessionId, `agent-event:${event.id}`, JSON.stringify(payload)])
}

async function insertBoundaryEvent(client: PoolClient, event: EventReceipt, createdAt: Date): Promise<void> {
  await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor",
    "correlationId","causationId","idempotencyKey","payload","createdAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,'orchestrator',$8,$9,$10,$11::jsonb,$12)`,
  [event.id, event.sessionId, event.turnId, event.itemId, event.taskId, event.sequence, event.type, event.correlationId,
    event.causationId, event.idempotencyKey, JSON.stringify(event.payload), createdAt])
  await insertEventOutbox(client, event)
}

async function insertCurrentStartBoundary(input: Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; eventId: string; goal: string; sequence: number; createdAt: Date
}> = { userId, sessionId, turnId: currentTurnId, rootTaskId: currentRootTaskId,
  eventId: `root-history-current-start-${suffix}`, goal: objective, sequence: CURRENT_START_SEQUENCE, createdAt: currentStartCreatedAt }): Promise<void> {
  const client = await pool!.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", input.userId])
    const lock = await acquireRootTaskHistoryChronologyLock(client, input.userId)
    const event: EventReceipt = { id: input.eventId, sessionId: input.sessionId, turnId: input.turnId,
      taskId: input.rootTaskId, sequence: input.sequence, itemId: null, type: "turn.started", correlationId: input.turnId,
      causationId: null, idempotencyKey: `turn:${input.turnId}:event:turn-started`,
      payload: { goal: input.goal, taskId: input.rootTaskId, rootTaskId: input.rootTaskId } }
    await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor","correlationId","idempotencyKey","payload","createdAt")
      VALUES ($1,$2,$3,NULL,$4,$5,$6,'orchestrator',$7,$8,$9::jsonb,$10)`,
    [event.id, input.sessionId, input.turnId, input.rootTaskId, event.sequence, event.type, event.correlationId,
      event.idempotencyKey, JSON.stringify(event.payload), input.createdAt])
    await insertEventOutbox(client, event)
    await appendRootTaskHistoryChronologyWitness(client, { userId: input.userId, sessionId: input.sessionId,
      turnId: input.turnId, rootTaskId: input.rootTaskId, boundary: "turn_start", boundaryEventId: event.id }, lock)
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function insertScheduledCurrentTurn(input: unknown): Promise<TurnLease> {
  const leaseExpiresAt = new Date(Date.now() + 5 * 60_000)
  await pool!.query(`INSERT INTO "agent_turns" ("id","sessionId","userId","status","source","input","modelProfileSnapshot",
    "toolPolicySnapshot","budgetSnapshot","rootTaskId","leaseOwnerId","leaseExpiresAt","leaseStartedAt","leaseVersion","updatedAt")
    VALUES ($1,$2,$3,'in_progress','automation',$4::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$6,$7,CURRENT_TIMESTAMP,1,CURRENT_TIMESTAMP)`,
  [scheduledCurrentTurnId, scheduledSessionId, userId, JSON.stringify(input), scheduledCurrentRootTaskId, workerId, leaseExpiresAt])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id","sessionId","turnId","rootTaskId","parentTaskId","path","depth","role","taskType","status","goal",
    "constraints","successCriteria","allowedActions","context","expectedOutputSchema","modelProfileSnapshot","toolPolicySnapshot","budgetSnapshot",
    "attemptCount","maxAttempts","leaseOwner","leaseExpiresAt","completedAt","updatedAt")
    VALUES ($1,$2,$3,$1,NULL,'/scheduled-current',0,'orchestrator','root','running',$4,'[]'::jsonb,$5::jsonb,'[]'::jsonb,
      '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,1,3,$6,$7,NULL,CURRENT_TIMESTAMP)`,
  [scheduledCurrentRootTaskId, scheduledSessionId, scheduledCurrentTurnId, objective, JSON.stringify(criteria), workerId, leaseExpiresAt])
  await pool!.query(`INSERT INTO "agent_steps" ("id","sessionId","turnId","taskId","ordinal","attempt","status","inputThroughSequence","consumedInputIds","modelProfileSnapshot")
    VALUES ($1,$2,$3,$4,1,1,'streaming',0,'[]'::jsonb,'{}'::jsonb)`,
  [scheduledCurrentStepId, scheduledSessionId, scheduledCurrentTurnId, scheduledCurrentRootTaskId])
  await insertCurrentStartBoundary({ userId, sessionId: scheduledSessionId, turnId: scheduledCurrentTurnId,
    rootTaskId: scheduledCurrentRootTaskId, eventId: `root-history-scheduled-current-start-${suffix}`,
    goal: objective, sequence: CURRENT_START_SEQUENCE, createdAt: currentStartCreatedAt })
  return { turnId: scheduledCurrentTurnId, sessionId: scheduledSessionId, userId, ownerId: workerId,
    leaseVersion: 1, leaseStartedAt: new Date(), leaseExpiresAt }
}

async function insertSourceBoundaryEvents(input: Readonly<{
  source: Source; startSequence: number; terminalSequence: number; terminalItemId: string | null
  terminalType: string; correlationId: string; terminalKey: string; terminalPayload: unknown
  terminalCausationId: string | null; stepReceipts: readonly EventReceipt[]; completedReceipts: readonly EventReceipt[]
  writeTerminalWitness: boolean
  startCreatedAt: Date; terminalCreatedAt: Date
}>): Promise<void> {
  const { source } = input, client = await pool!.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", source.userId])
    const lock = await acquireRootTaskHistoryChronologyLock(client, source.userId)
    const start: EventReceipt = { id: `root-history-start-${source.turnId}`, sessionId: source.sessionId,
      turnId: source.turnId, taskId: source.rootTaskId, sequence: input.startSequence, itemId: null,
      type: "turn.started", correlationId: source.turnId, causationId: null,
      idempotencyKey: `turn:${source.turnId}:event:turn-started`,
      payload: { goal: source.goal, taskId: source.rootTaskId, rootTaskId: source.rootTaskId } }
    const terminal: EventReceipt = { id: input.terminalKey, sessionId: source.sessionId,
      turnId: source.turnId, taskId: source.rootTaskId, sequence: input.terminalSequence, itemId: input.terminalItemId,
      type: input.terminalType, correlationId: input.correlationId, causationId: input.terminalCausationId,
      idempotencyKey: input.terminalKey, payload: input.terminalPayload }
    await insertBoundaryEvent(client, start, input.startCreatedAt)
    for (const receipt of input.stepReceipts) await insertBoundaryEvent(client, receipt, input.startCreatedAt)
    for (const receipt of input.completedReceipts) await insertBoundaryEvent(client, receipt, input.terminalCreatedAt)
    await insertBoundaryEvent(client, terminal, input.terminalCreatedAt)
    await appendRootTaskHistoryChronologyWitness(client, { userId: source.userId, sessionId: source.sessionId,
      turnId: source.turnId, rootTaskId: source.rootTaskId, boundary: "turn_start", boundaryEventId: start.id }, lock)
    if (input.writeTerminalWitness) await appendRootTaskHistoryChronologyWitness(client, { userId: source.userId,
      sessionId: source.sessionId, turnId: source.turnId, rootTaskId: source.rootTaskId,
      boundary: "root_terminal", boundaryEventId: terminal.id }, lock)
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function insertSource(source: Source): Promise<void> {
  const status = source.status ?? "completed"
  const rootStatus = source.rootStatus ?? status
  const terminalCreatedAt = source.terminalCreatedAt ?? new Date("2026-01-01T00:00:00.000Z")
  const startCreatedAt = new Date(terminalCreatedAt.getTime() - 1)
  const children = [
    { id: source.childId, key: "scout", templateId: "scout", role: "scout", taskType: "scout", status: "completed" as const,
      failureReason: null, goal: "Find matching roles", successCriteria: ["Find one role"], result: source.scoutResult ?? null },
    ...(source.completedChildren ?? []).map(child => ({
      id: `${source.childId}-${child.key}`, key: child.key, templateId: child.templateId, role: child.role,
      taskType: child.taskType, status: "completed" as const, failureReason: null, goal: child.goal,
      successCriteria: child.successCriteria, result: child.result ?? null,
    })),
    ...(source.failureChildren ?? []).map(failure => ({
      id: `${source.childId}-${failure.key}`, key: `failure-${failure.key}`, templateId: failure.templateId,
      role: failure.role, taskType: failure.taskType, status: "failed" as const, failureReason: failure.failureReason,
      goal: `Inspect ${failure.key} prerequisites`, successCriteria: [`Complete ${failure.key} work`],
      result: { finalText: `PRIVATE_${failure.key.toUpperCase()}_RESULT` },
    })),
  ]
  const graph = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: children.map(child => ({
    key: child.key, templateId: child.templateId, goal: child.goal, successCriteria: child.successCriteria,
    dependsOn: [], depth: 1, taskId: child.id,
  })) })
  await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
    "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $7, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
  [source.turnId, source.sessionId, source.userId, status, source.turnSource ?? "user", JSON.stringify(source.input), source.rootTaskId])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $1, NULL, '/source', 0, 'orchestrator', 'root', $4, $5, '[]'::jsonb, $6::jsonb, '[]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [source.rootTaskId, source.sessionId, source.turnId, rootStatus, source.goal, JSON.stringify(source.criteria)])
  for (const child of children) {
    await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "failureReason",
      "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, $5, 1, $6, $7, $8, $9, '[]'::jsonb, $10::jsonb, '[]'::jsonb,
        '{}'::jsonb, '{}'::jsonb, $11::jsonb, $12, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [child.id, source.sessionId, source.turnId, source.rootTaskId, `/source/${child.key}`, child.role, child.taskType, child.status,
      child.goal, JSON.stringify(child.successCriteria), child.result === null ? null : JSON.stringify(child.result), child.failureReason])
  }
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ($6, $2, $3, $4, 'agent_message', 'completed', 0, '{"text":"done"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [taskGraphItemId(source.rootTaskId), source.sessionId, source.turnId, source.rootTaskId, JSON.stringify(graph), source.finalItemId])
  const startSequence = source.startSequence * SOURCE_SEQUENCE_STRIDE
  const duplicateStepReceipt = source.stepReceipt === "duplicate"
  const itemStartedOffset = duplicateStepReceipt ? 3 : 2
  const itemCompletedOffset = duplicateStepReceipt ? 4 : 3
  const terminalOffset = status === "completed" ? (duplicateStepReceipt ? 5 : 4) : 2
  const terminalSequence = startSequence + terminalOffset
  const terminalType = status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.interrupted"
  const terminalItemId = status === "completed" ? source.finalItemId : null
  const sourceStepId = `source-step-${source.turnId}`
  const stepReceipts: EventReceipt[] = []
  if (status === "completed") {
    await pool!.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, $5, 0, '[]'::jsonb, '{}'::jsonb)`,
    [sourceStepId, source.sessionId, source.turnId, source.rootTaskId, source.stepStatus ?? "completed"])
    await pool!.query(`UPDATE "agent_items" SET "stepId"=$1,"phase"='final_answer',"revision"=1
      WHERE "id"=$2 AND "sessionId"=$3 AND "turnId"=$4 AND "taskId"=$5 AND "type"='agent_message'`,
    [sourceStepId, source.finalItemId, source.sessionId, source.turnId, source.rootTaskId])
    if (source.stepReceipt !== "missing") {
      const count = source.stepReceipt === "duplicate" ? 2 : 1
      for (let index = 0; index < count; index += 1) {
        const stepPayload = { stepId: sourceStepId, status: source.stepReceipt === "mismatched" ? "failed" : "completed", taskId: source.rootTaskId }
        const key = `turn:${source.turnId}:event:step-completed:${sourceStepId}${index ? `:duplicate-${index}` : ""}`
        stepReceipts.push({ id: `root-history-step-completed-${index}-${source.turnId}`, sessionId: source.sessionId,
          turnId: source.turnId, taskId: source.rootTaskId, sequence: startSequence + (duplicateStepReceipt && index === 1 ? 2 : 1 + index),
          itemId: null, type: "step.completed", correlationId: sourceStepId, causationId: null,
          idempotencyKey: key, payload: stepPayload })
      }
    }
  }
  const correlationId = status === "completed" ? (source.correlationTargetId ?? sourceStepId) : source.turnId
  const errorCode = status === "failed" ? "task_failed" : status === "interrupted" ? "interrupted" : undefined
  const terminalKey = terminalEventKey(source)
  const terminalPayload = status === "completed" ? { turnId: source.turnId, taskId: source.rootTaskId, finalItemId: source.finalItemId,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }
    : status === "failed" ? { turnId: source.turnId, taskId: source.rootTaskId, errorCode, finalItemId: null }
      : { turnId: source.turnId, taskId: source.rootTaskId, errorCode }
  const startEventId = `root-history-start-${source.turnId}`
  const itemStartedId = `turn:${source.turnId}:event:item-started:${source.finalItemId}`
  const itemCompletedId = `turn:${source.turnId}:event:final-completed:${source.finalItemId}:1`
  const completedReceipts: EventReceipt[] = status === "completed" ? [
    { id: itemStartedId, sessionId: source.sessionId, turnId: source.turnId, taskId: source.rootTaskId,
      sequence: startSequence + itemStartedOffset, itemId: source.finalItemId, type: "item.started",
      correlationId: sourceStepId, causationId: stepReceipts[0]?.id ?? startEventId, idempotencyKey: itemStartedId,
      payload: { itemId: source.finalItemId, type: "agent_message", phase: "final_answer" } },
    { id: itemCompletedId, sessionId: source.sessionId, turnId: source.turnId, taskId: source.rootTaskId,
      sequence: startSequence + itemCompletedOffset, itemId: source.finalItemId, type: "item.completed",
      correlationId: source.finalItemId, causationId: itemStartedId, idempotencyKey: itemCompletedId,
      payload: { itemId: source.finalItemId, status: "completed", content: { text: "done" } } },
  ] : []
  const terminalCausationId = completedReceipts[completedReceipts.length - 1]?.id ?? null
  // Keep malformed completed rows as rejection fixtures without fabricating witnesses for invalid receipts.
  const writeTerminalWitness = status !== "completed"
    || ((source.stepStatus === undefined || source.stepStatus === "completed")
      && (source.correlationTargetId === undefined || source.correlationTargetId === sourceStepId))
  await insertSourceBoundaryEvents({ source, startSequence, terminalSequence, terminalItemId,
    terminalType, correlationId, terminalKey, terminalPayload, terminalCausationId, stepReceipts, completedReceipts, writeTerminalWitness,
    startCreatedAt, terminalCreatedAt })
}

async function projectSources(sources: readonly Source[]): Promise<void> {
  const client = await pool!.connect()
  try {
    await client.query("BEGIN")
    for (const source of sources) {
      const identity = { userId: source.userId, sessionId: source.sessionId, turnId: source.turnId, rootTaskId: source.rootTaskId }
      const objectiveProjected = await updateRootObjectiveHistoryProjection(client, identity)
      if (!objectiveProjected) throw new Error(`Objective-history projection failed for ${source.turnId}`)
      const terminalProjected = await updateRootObjectiveHistoryProjection(client, identity,
        { terminalEventId: terminalEventKey(source) })
      if (!terminalProjected) throw new Error(`Objective-history terminal projection failed for ${source.turnId}`)
    }
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function deleteSourceFixtures(sources: readonly Source[]): Promise<void> {
  if (!sources.length) return
  const client = await pool!.connect(), turnIds = sources.map(source => source.turnId)
  try {
    await client.query("BEGIN")
    await client.query(`DELETE FROM "agent_outbox" WHERE "aggregateId"=$1 AND "payload"->>'turnId'=ANY($2::text[])`, [sessionId, turnIds])
    await client.query(`DELETE FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = ANY($2::text[])`, [sessionId, turnIds])
    await client.query(`DELETE FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = ANY($2::text[])`, [sessionId, turnIds])
    await client.query(`DELETE FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = ANY($2::text[])`, [sessionId, turnIds])
    await client.query(`DELETE FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = ANY($2::text[])
      AND "parentTaskId" IS NOT NULL`, [sessionId, turnIds])
    await client.query(`DELETE FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = ANY($2::text[])
      AND "parentTaskId" IS NULL`, [sessionId, turnIds])
    await client.query(`DELETE FROM "agent_turns" WHERE "sessionId" = $1 AND "id" = ANY($2::text[])`, [sessionId, turnIds])
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function setObjectiveHistoryIndexReady(ready: boolean): Promise<void> {
  const result = await pool!.query(`INSERT INTO "agent_objective_history_index_readiness" ("indexName", "semanticsVersion", "isReady")
    VALUES ($2, $3, $1) ON CONFLICT ("indexName", "semanticsVersion")
    DO UPDATE SET "isReady" = $1, "updatedAt" = CURRENT_TIMESTAMP`,
  [ready, "agent_turns_objective_history", OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION])
  if (result.rowCount !== 1) throw new Error("Objective-history readiness row could not be written")
}

async function updateCurrentTurn(source: string, input: unknown): Promise<void> {
  await pool!.query(`UPDATE "agent_turns" SET "source" = $2, "input" = $3::jsonb WHERE "id" = $1 AND "sessionId" = $4`,
    [currentTurnId, source, JSON.stringify(input), sessionId])
}

async function updateScheduledCurrentTurn(input: unknown): Promise<void> {
  await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3`,
    [scheduledCurrentTurnId, JSON.stringify(input), scheduledSessionId])
}

async function updateTurnInputJson(turnId: string, inputJson: string): Promise<void> {
  await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [turnId, inputJson])
}

async function withObjectiveHistoryIndexReady<T>(run: () => Promise<T>): Promise<T> {
  await setObjectiveHistoryIndexReady(true)
  try {
    return await run()
  } finally {
    await setObjectiveHistoryIndexReady(false)
  }
}

describePg("direct Root-task history PostgreSQL source validation", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    lease = { turnId: currentTurnId, sessionId, userId, ownerId: workerId, leaseVersion: 1,
      leaseStartedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 5 * 60_000) }
    await insertUser(userId)
    await insertUser(otherUserId)
    await insertSession(sessionId, userId, FIXTURE_EVENT_SEQUENCE)
    await insertSession(otherSessionId, userId, FIXTURE_EVENT_SEQUENCE)
    await insertSession(foreignSessionId, otherUserId, FIXTURE_EVENT_SEQUENCE)
    await insertSession(archivedSessionId, userId, FIXTURE_EVENT_SEQUENCE)
    await pool.query(`UPDATE "agent_sessions" SET "status" = 'archived' WHERE "id" = $1`, [archivedSessionId])
    for (const source of matching) await insertSource(source)
    await insertSource(mismatched)
    await insertSource(changedCriteria)
    await insertSource(selectedJob)
    await insertSource(otherSession)
    await insertSource(crossEqualTimeHigherTurnId)
    await insertSource(crossWrongSource)
    await insertSource(crossWrongOrigin)
    await insertSource(archivedSource)
    await insertSource(equalCutoff)
    await insertSource(foreignScopeCorrelation)
    await insertSource(otherUser)
    await insertSource(inconsistentTerminal)
    await insertSource(streamingTerminalStep)
    await insertSource(failedTerminalStep)
    await insertSource(missingStepReceipt)
    await insertSource(mismatchedStepReceipt)
    await insertSource(duplicateStepReceipt)
    for (const source of crossSessionWrongOriginFillers) await insertSource(source)
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
    await insertCurrentStartBoundary()
    await insertSource(future)
    await projectSources([...matching, otherSession, crossEqualTimeHigherTurnId, crossWrongOrigin, equalCutoff, future,
      ...crossSessionWrongOriginFillers])
  })

  afterAll(async () => {
    if (pool) {
      await setObjectiveHistoryIndexReady(false).catch(() => undefined)
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`,
        [[sessionId, otherSessionId, scheduledSessionId, foreignSessionId, archivedSessionId]]).catch(() => undefined)
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
    expect(history.map(item => item.terminalSequence)).toEqual([32n, 10n])
    expect(history.map(item => item.taskGraph.nodes.length)).toEqual([4, 1])
    expect(history[0]?.nodeLessons?.map(lesson => lesson?.executionFailureCategory)).toEqual([
      undefined, "execution_setup_unavailable", "resume_state_unavailable", "structured_output_invalid",
    ])
    expect(history[0]?.nodeLessons?.slice(1).every(lesson => lesson?.criterionFailures.length === 0
      && lesson.successfulRepairs === undefined)).toBe(true)
    const projectedHistory = projectRootTaskHistory(history)
    expect(projectedHistory?.content).toMatchObject({ kind: "root_task_history", advisoryOnly: true, notCurrentEvidence: true })
    const projectedTurns = (projectedHistory?.content as { turns: Array<{ nodes: readonly unknown[] }> } | undefined)?.turns
    expect(projectedTurns).toHaveLength(2)
    expect(projectedTurns?.[0]?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ lesson: expect.objectContaining({ executionFailureCategory: "execution_setup_unavailable" }) }),
      expect.objectContaining({ lesson: expect.objectContaining({ executionFailureCategory: "resume_state_unavailable" }) }),
      expect.objectContaining({ lesson: expect.objectContaining({ executionFailureCategory: "structured_output_invalid" }) }),
    ]))
    expect(JSON.stringify(projectedHistory)).not.toMatch(/selected_job_context_unavailable|child_resume_unavailable|invalid_structured_result|PRIVATE_(SETUP|RESUME|OUTPUT|FOREIGN-SESSION|FOREIGN-USER)_RESULT/)
    expect(history.some(item => item.sourceTurnId === matching[0]!.turnId)).toBe(true)
    expect(history.some(item => [mismatched.turnId, changedCriteria.turnId, selectedJob.turnId,
      otherSession.turnId, foreignScopeCorrelation.turnId, otherUser.turnId, future.turnId, inconsistentTerminal.turnId,
      streamingTerminalStep.turnId, failedTerminalStep.turnId, missingStepReceipt.turnId, mismatchedStepReceipt.turnId,
      duplicateStepReceipt.turnId].includes(item.sourceTurnId))).toBe(false)
  })

  it("reloads owner-scoped history and merges only witnessed terminal-before-start outcomes by xid8", async () => {
    const input: DirectRootTaskHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, now: new Date(), crossSessionRootTaskHistoryEnabled: true }
    const history = await createPgDirectRootTaskHistoryStore(pool!).load(input)

    expect(history.map(item => item.sourceTurnId)).toEqual([
      equalCutoff.turnId, crossEqualTimeHigherTurnId.turnId, otherSession.turnId, matching[1]!.turnId, matching[0]!.turnId,
    ])
    const xids = history.map(item => BigInt(item.terminalXid8!))
    expect(xids.every((xid, index) => index === 0 || xids[index - 1]! > xid)).toBe(true)
    expect(history.every(item => typeof item.terminalWitnessEventId === "string")).toBe(true)
    expect(history[1]?.taskGraph.nodes).toHaveLength(2)
    expect(history[1]?.nodeLessons?.[1]?.executionFailureCategory).toBeUndefined()
    expect(history[1]?.reportedOutputs).toBeUndefined()
    expect(history[2]?.nodeLessons?.[1]?.executionFailureCategory).toBe("execution_setup_unavailable")
    expect(history[3]?.reportedOutputs).toEqual([{ role: "scout", candidateCount: 1, resultStatus: "partial" }])
    expect(history.map(item => item.sourceSessionDiffers)).toEqual([true, true, false, false])
    expect(history.some(item => [crossWrongSource.turnId, crossWrongOrigin.turnId, archivedSource.turnId,
      foreignScopeCorrelation.turnId, otherUser.turnId, future.turnId].includes(item.sourceTurnId))).toBe(false)
    expect(projectRootTaskHistory(history, true)?.content).toMatchObject({ kind: "root_task_history", advisoryOnly: true, notCurrentEvidence: true })
  })

  it("rechecks a source session lifecycle change after the bounded terminal scan", async () => {
    const input: DirectRootTaskHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, now: new Date(), crossSessionRootTaskHistoryEnabled: true }
    for (const status of ["archived", "aborted"] as const) {
      const scan = gate(), resume = gate()
      let paused = false
      const observed = observeQueries(pool!, async sql => {
        if (!paused && sql.includes('event."sessionId" <> $1')) {
          paused = true
          scan.open()
          await resume.promise
        }
      })
      const pending = createPgDirectRootTaskHistoryStore(observed).load(input)
      await scan.promise
      try {
        await pool!.query(`UPDATE "agent_sessions" SET "status" = $2 WHERE "id" = $1`, [otherSessionId, status])
      } finally {
        resume.open()
      }
      const history = await pending
      expect(history.some(item => item.sourceTurnId === otherSession.turnId)).toBe(false)
      await pool!.query(`UPDATE "agent_sessions" SET "status" = 'running' WHERE "id" = $1`, [otherSessionId])
    }
  })

  it("skips a locked cross-session source instead of blocking its graph reload", async () => {
    const input: DirectRootTaskHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, now: new Date(), crossSessionRootTaskHistoryEnabled: true }
    const blocker = await pool!.connect()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await blocker.query("BEGIN")
      await blocker.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [otherSessionId])
      const history = await Promise.race([
        createPgDirectRootTaskHistoryStore(pool!).load(input),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("cross-session graph reload blocked")), 3_000) }),
      ])
      expect(history.some(item => item.sourceTurnId === otherSession.turnId)).toBe(false)
      expect(history.map(item => item.sourceTurnId)).toEqual([matching[1]!.turnId, matching[0]!.turnId])
    } finally {
      if (timeout) clearTimeout(timeout)
      await blocker.query("ROLLBACK").catch(() => undefined)
      blocker.release()
    }
  })

  it("finds exact same-session objectives behind more than 64 newer unrelated indexed outcomes", async () => {
    for (const source of sameSessionUnrelated) await insertSource(source)
    await projectSources(sameSessionUnrelated)
    await withObjectiveHistoryIndexReady(async () => {
      const graphLoads: string[] = []
      const observed = observeQueries(pool!, async (sql, values) => {
        if (sql.includes('FROM "agent_items" AS item')) graphLoads.push(String(values?.[2]))
      })
      const input: DirectRootTaskHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
        rootAttemptCount: 2, stepId: currentStepId, now: new Date(), objectiveHistoryIndexEnabled: true }
      const history = await createPgDirectRootTaskHistoryStore(observed).load(input)

      expect(history.map(item => item.sourceTurnId)).toEqual([matching[1]!.turnId, matching[0]!.turnId])
      expect(graphLoads).toEqual([matching[1]!.turnId, matching[0]!.turnId])
      const fillerTurnIds = new Set(sameSessionUnrelated.map(source => source.turnId))
      expect(graphLoads.filter(turnId => fillerTurnIds.has(turnId))).toEqual([])
    })
  })

  it("filters changed typed contracts before the indexed limit and keeps fallback recall bounded", async () => {
    const requirements = (candidateMinimum: number, reverse = false) => {
      const rows = [
        { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: candidateMinimum } },
        { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
      ]
      return { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: reverse ? rows.reverse() : rows }
    }
    const currentInput = { goal: objective, successCriteria: criteria, verificationRequirements: requirements(2) }
    const base = (suffix: string, startSequence: number, value: unknown): Source => ({
      turnId: `root-history-contract-${suffix}-${suffix === "old" ? "old" : "current"}-${randomUUID()}`,
      rootTaskId: `root-history-contract-root-${randomUUID()}`, childId: `root-history-contract-child-${randomUUID()}`,
      finalItemId: `root-history-contract-final-${randomUUID()}`, sessionId, userId, goal: objective, criteria,
      input: { goal: objective, successCriteria: criteria, verificationRequirements: value }, startSequence,
    })
    const exactOld = base("match", 600, requirements(2, true))
    const exactRecent = base("match", 960, requirements(2))
    const changed = Array.from({ length: 65 }, (_, index) => base(`changed-${index}`, 700 + index * 4, requirements(3)))
    const sources = [exactOld, ...changed, exactRecent]
    const originalInput = { goal: objective, successCriteria: criteria }

    await updateCurrentTurn("user", currentInput)
    try {
      for (const source of sources) await insertSource(source)
      await projectSources(sources)
      const input: DirectRootTaskHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
        rootAttemptCount: 2, stepId: currentStepId, now: new Date(), objectiveHistoryIndexEnabled: true }

      const indexed = await withObjectiveHistoryIndexReady(() => createPgDirectRootTaskHistoryStore(pool!).load(input))
      expect(indexed.map(item => item.sourceTurnId)).toEqual([exactRecent.turnId, exactOld.turnId])

      const fallback = await createPgDirectRootTaskHistoryStore(pool!).load({ ...input, objectiveHistoryIndexEnabled: false })
      expect(fallback.map(item => item.sourceTurnId)).toEqual([exactRecent.turnId])
      expect(fallback.some(item => changed.some(source => source.turnId === item.sourceTurnId))).toBe(false)
    } finally {
      try { await updateCurrentTurn("user", originalInput) }
      finally { await deleteSourceFixtures(sources) }
    }
  })

  it("holds readiness through indexed candidate selection while an explicit reset is attempted", async () => {
    await withObjectiveHistoryIndexReady(async () => {
      const readinessRead = gate(), continueCandidateSelection = gate()
      let readinessPaused = false
      let candidateSql: string | undefined
      const observed = observeQueries(pool!, async sql => {
        if (!readinessPaused && sql.includes('FROM "agent_objective_history_index_readiness"')) {
          readinessPaused = true
          readinessRead.open()
          await continueCandidateSelection.promise
        }
        if (sql.includes("WITH terminal_window")) candidateSql = sql
      })
      const input: DirectRootTaskHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
        rootAttemptCount: 2, stepId: currentStepId, now: new Date(), objectiveHistoryIndexEnabled: true }
      let reader: Promise<readonly ValidatedRootTaskHistoryOutcome[]> | undefined
      let resetter: PoolClient | undefined
      try {
        reader = createPgDirectRootTaskHistoryStore(observed).load(input)
        await withTimeout(readinessRead.promise, "readiness row was not read")

        resetter = await pool!.connect()
        await resetter.query("BEGIN")
        await resetter.query("SET LOCAL lock_timeout = '1000ms'")
        let resetError: unknown
        let resetCommitted = false
        try {
          await resetter.query(`UPDATE "agent_objective_history_index_readiness"
            SET "isReady" = FALSE, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "indexName" = $1 AND "semanticsVersion" = $2`,
          ["agent_turns_objective_history", OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION])
          await resetter.query("COMMIT")
          resetCommitted = true
        } catch (error: unknown) {
          resetError = error
          await resetter.query("ROLLBACK").catch(() => undefined)
        }
        expect(resetCommitted).toBe(false)
        expect(errorCode(resetError)).toBe("55P03")

        continueCandidateSelection.open()
        const history = await withTimeout(reader, "indexed candidate selection did not finish")
        expect(candidateSql).toContain('FROM "agent_turns" AS turn')
        expect(history.map(item => item.sourceTurnId)).toEqual([matching[1]!.turnId, matching[0]!.turnId])
      } finally {
        continueCandidateSelection.open()
        if (resetter) {
          await resetter.query("ROLLBACK").catch(() => undefined)
          resetter.release()
        }
        if (reader) await reader.catch(() => undefined)
      }
    })
  })

  it("filters more than 64 newer cross-session wrong-origin rows before loading graphs", async () => {
    await withObjectiveHistoryIndexReady(async () => {
      const graphLoads: string[] = []
      const observed = observeQueries(pool!, async (sql, values) => {
        if (sql.includes('FROM "agent_items" AS item')) graphLoads.push(String(values?.[2]))
      })
      const input: DirectRootTaskHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
        rootAttemptCount: 2, stepId: currentStepId, now: new Date(), crossSessionRootTaskHistoryEnabled: true,
        objectiveHistoryIndexEnabled: true }
      const history = await createPgDirectRootTaskHistoryStore(observed).load(input)

      expect(history.map(item => item.sourceTurnId)).toEqual([
        equalCutoff.turnId, crossEqualTimeHigherTurnId.turnId, otherSession.turnId, matching[1]!.turnId, matching[0]!.turnId,
      ])
      const xids = history.map(item => BigInt(item.terminalXid8!))
      expect(xids.every((xid, index) => index === 0 || xids[index - 1]! > xid)).toBe(true)
      expect(graphLoads).toEqual(history.map(item => item.sourceTurnId))
      const fillerTurnIds = new Set(crossSessionWrongOriginFillers.map(source => source.turnId))
      expect(graphLoads.filter(turnId => fillerTurnIds.has(turnId))).toEqual([])
      expect(history.some(item => [crossWrongOrigin.turnId, future.turnId].includes(item.sourceTurnId))).toBe(false)
    })
  })

  it("keeps matching scheduled history behind malformed and mismatched rows in indexed and legacy windows", async () => {
    const targetRoles = ["Platform Engineer"]
    const validSnapshot = scheduledSnapshot(targetRoles)
    const malformedSameSession: Source[] = Array.from({ length: 65 }, (_, index): Source => ({
      turnId: `root-history-scheduled-malformed-${index}-${suffix}`, rootTaskId: `root-history-scheduled-malformed-root-${index}-${suffix}`,
      childId: `root-history-scheduled-malformed-child-${index}-${suffix}`, finalItemId: `root-history-scheduled-malformed-final-${index}-${suffix}`,
      sessionId: scheduledSessionId, userId, turnSource: "automation", goal: objective, criteria,
      input: scheduledTurnInput(scheduledSnapshot(targetRoles, { autoApply: "false" })),
      startSequence: 500 + index * 4, terminalCreatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)),
    }))
    const mismatchGroup = (dimension: "targetRoles" | "targetLocations" | "minScore", firstSequence: number, day: number): Source[] =>
      Array.from({ length: 65 }, (_, index): Source => {
        const roles = dimension === "targetRoles" ? ["Different role"] : targetRoles
        const overrides = dimension === "targetLocations" ? { targetLocations: ["Berlin"] }
          : dimension === "minScore" ? { minScore: 71 } : {}
        return {
          turnId: `root-history-scheduled-${dimension}-mismatch-${index}-${suffix}`,
          rootTaskId: `root-history-scheduled-${dimension}-mismatch-root-${index}-${suffix}`,
          childId: `root-history-scheduled-${dimension}-mismatch-child-${index}-${suffix}`,
          finalItemId: `root-history-scheduled-${dimension}-mismatch-final-${index}-${suffix}`,
          sessionId: scheduledSessionId, userId, turnSource: "automation", goal: objective, criteria,
          input: scheduledTurnInput(scheduledSnapshot(roles, overrides)),
          startSequence: firstSequence + index * 4, terminalCreatedAt: new Date(Date.UTC(2025, 0, day, 0, 0, index)),
        }
      })
    const mismatchedRoles = mismatchGroup("targetRoles", 800, 2)
    // Keep each six-event Turn range unique within this session. The earlier
    // baseline fixture reserves sequences 12606–12610 for its future Turn.
    const mismatchedLocations = mismatchGroup("targetLocations", 1120, 3)
    const mismatchedMinScores = mismatchGroup("minScore", 1380, 4)
    const hugeExponentMalformed: Source = {
      turnId: `root-history-scheduled-huge-number-${suffix}`, rootTaskId: `root-history-scheduled-huge-number-root-${suffix}`,
      childId: `root-history-scheduled-huge-number-child-${suffix}`, finalItemId: `root-history-scheduled-huge-number-final-${suffix}`,
      sessionId: scheduledSessionId, userId, turnSource: "automation", goal: objective, criteria,
      input: scheduledTurnInput(scheduledSnapshot(targetRoles)), startSequence: 760,
      terminalCreatedAt: new Date("2025-01-01T00:00:01.000Z"),
    }
    const matchingSameSession: Source = {
      turnId: `root-history-scheduled-match-same-${suffix}`, rootTaskId: `root-history-scheduled-match-same-root-${suffix}`,
      childId: `root-history-scheduled-match-same-child-${suffix}`, finalItemId: `root-history-scheduled-match-same-final-${suffix}`,
      sessionId: scheduledSessionId, userId, turnSource: "automation", goal: objective, criteria,
      input: scheduledTurnInput(validSnapshot), startSequence: 460, terminalCreatedAt: new Date("2021-01-01T00:00:00.000Z"),
    }
    const numericBoundarySnapshot = scheduledSnapshot(targetRoles, { minScore: 100 })
    const numericBoundaryMatch: Source = {
      turnId: `root-history-scheduled-number-match-${suffix}`, rootTaskId: `root-history-scheduled-number-match-root-${suffix}`,
      childId: `root-history-scheduled-number-match-child-${suffix}`, finalItemId: `root-history-scheduled-number-match-final-${suffix}`,
      sessionId: scheduledSessionId, userId, turnSource: "automation", goal: objective, criteria,
      input: scheduledTurnInput(numericBoundarySnapshot), startSequence: 470,
      terminalCreatedAt: new Date("2022-01-01T00:00:00.000Z"),
    }
    const matchingCrossSession: Source = {
      turnId: `root-history-scheduled-match-cross-${suffix}`, rootTaskId: `root-history-scheduled-match-cross-root-${suffix}`,
      childId: `root-history-scheduled-match-cross-child-${suffix}`, finalItemId: `root-history-scheduled-match-cross-final-${suffix}`,
      sessionId: otherSessionId, userId, turnSource: "automation", goal: objective, criteria,
      input: scheduledTurnInput(validSnapshot), startSequence: 790, terminalCreatedAt: new Date("2020-01-01T00:00:00.000Z"),
    }
    const mismatchedCriteria = [...mismatchedRoles, ...mismatchedLocations, ...mismatchedMinScores]
    const sources = [...malformedSameSession, ...mismatchedCriteria, hugeExponentMalformed,
      matchingSameSession, numericBoundaryMatch, matchingCrossSession]
    await insertSession(scheduledSessionId, userId, SCHEDULED_FIXTURE_EVENT_SEQUENCE)
    await pool!.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [otherSessionId, SCHEDULED_FIXTURE_EVENT_SEQUENCE])
    for (const source of sources) await insertSource(source)
    const hugeExponentInput = JSON.stringify(hugeExponentMalformed.input).replace('"minScore":70', '"minScore":1e10000')
    const preciseBoundaryInput = JSON.stringify(numericBoundaryMatch.input)
      .replace('"minScore":100', '"minScore":100.00000000000000000000000001')
      .replace('"dailyCap":10', '"dailyCap":10.00000000000000000000000001')
    await updateTurnInputJson(hugeExponentMalformed.turnId, hugeExponentInput)
    await updateTurnInputJson(numericBoundaryMatch.turnId, preciseBoundaryInput)
    await projectSources(sources)
    const scheduledLease = await insertScheduledCurrentTurn(scheduledTurnInput(validSnapshot))

    try {
      for (const crossSession of [false, true]) {
        for (const indexed of [false, true]) {
          const graphLoads: string[] = []
          const observed = observeQueries(pool!, async (sql, values) => {
            if (sql.includes('FROM "agent_items" AS item')) graphLoads.push(String(values?.[2]))
          })
          const input: DirectRootTaskHistoryLoadInput = {
            lease: scheduledLease, rootTaskId: scheduledCurrentRootTaskId, rootAttemptCount: 1, stepId: scheduledCurrentStepId, now: new Date(),
            ...(crossSession ? { crossSessionRootTaskHistoryEnabled: true } : {}),
            ...(indexed ? { objectiveHistoryIndexEnabled: true } : { objectiveHistoryIndexEnabled: false }),
          }
          const run = () => createPgDirectRootTaskHistoryStore(observed).load(input)
          const history = indexed ? await withObjectiveHistoryIndexReady(run) : await run()
          const expected = crossSession ? [matchingSameSession.turnId, matchingCrossSession.turnId] : [matchingSameSession.turnId]
          expect(new Set(history.map(item => item.sourceTurnId))).toEqual(new Set(expected))
          expect(graphLoads).toEqual(history.map(item => item.sourceTurnId))
          const rejectedIds = new Set([...malformedSameSession, ...mismatchedCriteria, hugeExponentMalformed].map(source => source.turnId))
          expect(graphLoads.some(turnId => rejectedIds.has(turnId))).toBe(false)
        }
      }

      await updateScheduledCurrentTurn(scheduledTurnInput(numericBoundarySnapshot))
      for (const crossSession of [false, true]) {
        for (const indexed of [false, true]) {
          const graphLoads: string[] = []
          const observed = observeQueries(pool!, async (sql, values) => {
            if (sql.includes('FROM "agent_items" AS item')) graphLoads.push(String(values?.[2]))
          })
          const input: DirectRootTaskHistoryLoadInput = {
            lease: scheduledLease, rootTaskId: scheduledCurrentRootTaskId, rootAttemptCount: 1, stepId: scheduledCurrentStepId, now: new Date(),
            ...(crossSession ? { crossSessionRootTaskHistoryEnabled: true } : {}),
            ...(indexed ? { objectiveHistoryIndexEnabled: true } : { objectiveHistoryIndexEnabled: false }),
          }
          const run = () => createPgDirectRootTaskHistoryStore(observed).load(input)
          const history = indexed ? await withObjectiveHistoryIndexReady(run) : await run()
          expect(history.map(item => item.sourceTurnId)).toEqual([numericBoundaryMatch.turnId])
          expect(graphLoads).toEqual([numericBoundaryMatch.turnId])
        }
      }
    } finally {
      await updateScheduledCurrentTurn(scheduledTurnInput(validSnapshot))
    }

    const manualSource: Source = {
      turnId: `root-history-manual-source-${suffix}`, rootTaskId: `root-history-manual-root-${suffix}`,
      childId: `root-history-manual-child-${suffix}`, finalItemId: `root-history-manual-final-${suffix}`,
      sessionId, userId, turnSource: "automation", goal: objective, criteria,
      input: { goal: objective, successCriteria: criteria, automationRunMode: "manual", scheduledAutomationSnapshot: { schemaVersion: "invalid" } },
      startSequence: 490, terminalCreatedAt: new Date("2022-01-01T00:00:00.000Z"),
    }
    const legacyAutomationSource: Source = {
      turnId: `root-history-legacy-automation-source-${suffix}`, rootTaskId: `root-history-legacy-automation-root-${suffix}`,
      childId: `root-history-legacy-automation-child-${suffix}`, finalItemId: `root-history-legacy-automation-final-${suffix}`,
      sessionId, userId, turnSource: "automation", goal: objective, criteria,
      input: { goal: objective, successCriteria: criteria }, startSequence: 495,
      terminalCreatedAt: new Date("2022-01-02T00:00:00.000Z"),
    }
    await insertSource(manualSource)
    await insertSource(legacyAutomationSource)
    await projectSources([manualSource, legacyAutomationSource])
    await updateCurrentTurn("automation", { goal: objective, successCriteria: criteria, automationRunMode: "manual" })
    try {
      const legacyHistory = await createPgDirectRootTaskHistoryStore(pool!).load({
        lease, rootTaskId: currentRootTaskId, rootAttemptCount: 2, stepId: currentStepId, now: new Date(),
        objectiveHistoryIndexEnabled: false,
      })
      expect(legacyHistory.map(item => item.sourceTurnId)).toContain(manualSource.turnId)
      expect(legacyHistory.map(item => item.sourceTurnId)).toContain(legacyAutomationSource.turnId)
      const indexedHistory = await withObjectiveHistoryIndexReady(() => createPgDirectRootTaskHistoryStore(pool!).load({
        lease, rootTaskId: currentRootTaskId, rootAttemptCount: 2, stepId: currentStepId, now: new Date(),
        objectiveHistoryIndexEnabled: true,
      }))
      expect(indexedHistory.map(item => item.sourceTurnId)).toContain(manualSource.turnId)
      expect(indexedHistory.map(item => item.sourceTurnId)).toContain(legacyAutomationSource.turnId)
      expect(indexedHistory.map(item => item.sourceTurnId)).toContain(matching[0]!.turnId)
      expect(indexedHistory.map(item => item.sourceTurnId)).toContain(matching[1]!.turnId)
      const scheduledTurnIds = new Set([...malformedSameSession, ...mismatchedCriteria, hugeExponentMalformed,
        matchingSameSession, numericBoundaryMatch, matchingCrossSession].map(source => source.turnId))
      expect(indexedHistory.some(item => scheduledTurnIds.has(item.sourceTurnId))).toBe(false)
    } finally {
      await updateCurrentTurn("user", { goal: objective, successCriteria: criteria })
    }
  }, 30_000)
})
