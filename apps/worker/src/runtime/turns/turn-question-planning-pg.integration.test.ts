import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
import type { ModelAdapter } from "@jobcopilot/agent-model"

import { mergeCanonicalTurnQuestionContext } from "../canonical-turn-question-context.js"
import { StepContextBuilder, type StepContext } from "../context/step-context-builder.js"
import { createPgInputClaimStore } from "../context/input-claim-store.js"
import { recoverAnsweredQuestionContext } from "../question-answer-recovery.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { buildCognitiveActionAgenda } from "./cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, cognitiveAgendaReceiptIdempotencyKey } from "./cognitive-agenda-receipt.js"
import { taskGraphItemId, TASK_GRAPH_SNAPSHOT_VERSION } from "../subagents/task-graph-snapshot.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import { createPgTurnQuestionStore } from "./turn-question-store.js"
import { questionId, questionItemId, type TurnQuestionPool } from "./turn-question-store-guards.js"
import type { TurnQuestionPlanningReadOwner, TurnQuestionPlanningWaitRef } from "./turn-question-planning-contract.js"
import { readTurnQuestionPlanningHistory, readTurnQuestionPlanningWait } from "./turn-question-planning-history.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const PRIVATE_EVENT = "agent.plan.clarification"
const MANAGED_TABLES = ["agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events", "agent_outbox", "agent_inputs"] as const

function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Required planning clarification PostgreSQL test needs the disposable Agent runtime URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Planning clarification test accepts only its dedicated loopback disposable PostgreSQL URL")
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const role = `agent_clarification_${randomUUID().replaceAll("-", "")}`
const intent = {
  schemaVersion: "agent-harness.v2.ask-user-intent.v1",
  kind: "user_question",
  stage: "user_input",
  question: "Which region should I prioritize?",
  options: [{ label: "Berlin", value: "berlin" }],
} as const
const fixtures: Fixture[] = []
let admin: Pool | undefined
let writer: Pool | undefined
let runtimeRoleCreated = false
let savedRls = new Map<string, { enabled: boolean; forced: boolean }>()

type Fixture = {
  userId: string
  email: string
  sessionId: string
  turnId: string
  rootTaskId: string
  stepId: string
  callId: string
  callItemId: string
  resultItemId: string
  originalInputId: string
  originalClientMessageId: string
  consumedSteerId: string | null
  acceptedSteerId: string | null
  graphItemId: string
  agendaEventId: string
  owner: TurnExecutionOwnerFence
  inputCursor: bigint
  consumedInputIds: string[]
  planning: boolean
}

type InputSeed = {
  id: string
  clientMessageId: string
  acceptedSequence: number
  delivery: "steer" | "follow_up"
  status: "accepted" | "consumed"
  text: string
  consumedByStepId?: string | null
}

function readOwner(fixture: Fixture): TurnQuestionPlanningReadOwner {
  return { userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId, rootTaskId: fixture.rootTaskId }
}

function waitRef(fixture: Fixture, id = questionId(fixture.owner, fixture.stepId, fixture.callId)): TurnQuestionPlanningWaitRef {
  return { stepId: fixture.stepId, toolCallId: fixture.callId, waitId: id, questionItemId: questionItemId(id) }
}

function runtimePool(base: Pool, applicationName: string): TurnQuestionPool {
  return {
    async connect() {
      const client = await base.connect()
      try {
        await client.query("SELECT set_config('application_name', $1, false)", [applicationName])
        await client.query(`SET ROLE "${role}"`)
        return client
      } catch (error) {
        client.release()
        throw error
      }
    },
  }
}

async function withRuntimeTransaction<T>(
  pool: TurnQuestionPool,
  userId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect() as PoolClient
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const value = await work(client)
    await client.query("COMMIT")
    committed = true
    return value
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function saveRlsState(pool: Pool): Promise<void> {
  const result = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
     FROM pg_class AS relation JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
     WHERE schema.nspname = 'public' AND relation.relname = ANY($1::text[])`, [MANAGED_TABLES],
  )
  if (result.rows.length !== MANAGED_TABLES.length) throw new Error("Planning clarification fixture could not capture all Agent table RLS states")
  savedRls = new Map(result.rows.map(row => [row.relname, { enabled: row.relrowsecurity, forced: row.relforcerowsecurity }]))
}

async function restoreRlsState(pool: Pool): Promise<void> {
  for (const [table, expected] of savedRls) {
    const current = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relation.relrowsecurity, relation.relforcerowsecurity
       FROM pg_class AS relation JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
       WHERE schema.nspname = 'public' AND relation.relname = $1`, [table],
    )
    const row = current.rows[0]
    if (!row || row.relrowsecurity === expected.enabled && row.relforcerowsecurity === expected.forced) continue
    if (row?.relforcerowsecurity && (!expected.forced || !expected.enabled)) {
      await pool.query(`ALTER TABLE public."${table}" NO FORCE ROW LEVEL SECURITY`)
    }
    if (expected.enabled && !row?.relrowsecurity) await pool.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`)
    if (!expected.enabled && row?.relrowsecurity) await pool.query(`ALTER TABLE public."${table}" DISABLE ROW LEVEL SECURITY`)
    if (expected.enabled && expected.forced) await pool.query(`ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY`)
  }
}

async function insertEvent(client: PoolClient, event: {
  id?: string
  fixture: Fixture
  sequence: number
  type: string
  actor: string
  itemId: string | null
  taskId: string | null
  correlationId: string
  causationId?: string | null
  idempotencyKey: string
  payload: unknown
}): Promise<string> {
  const id = event.id ?? randomUUID()
  await client.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
  [id, event.fixture.sessionId, event.fixture.turnId, event.itemId, event.taskId, event.sequence, event.type, event.actor,
    event.correlationId, event.causationId ?? null, event.idempotencyKey, JSON.stringify(event.payload)])
  return id
}

async function insertInput(client: PoolClient, fixture: Fixture, input: InputSeed): Promise<void> {
  const itemId = `${input.id}-item`
  const parts = [{ type: "text", text: input.text }]
  const content = { parts, clientMessageId: input.clientMessageId, source: "user", disposition: "steered" }
  await client.query(`INSERT INTO "agent_items"
    ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, 'user_message', 'completed', 'commentary', 0, $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [itemId, fixture.sessionId, fixture.turnId, JSON.stringify(content)])
  await client.query(`INSERT INTO "agent_inputs"
    ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence", "consumedByStepId", "consumedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, CASE WHEN $7 = 'consumed' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
  [input.id, fixture.sessionId, fixture.turnId, fixture.userId, input.clientMessageId, input.delivery, input.status,
    JSON.stringify(parts), input.acceptedSequence, input.consumedByStepId ?? null])
  await insertEvent(client, { fixture, sequence: input.acceptedSequence, type: "input.accepted", actor: "user",
    itemId, taskId: null, correlationId: fixture.turnId, idempotencyKey: `input.accepted:${input.clientMessageId}`,
    payload: { inputId: input.id, clientMessageId: input.clientMessageId, delivery: input.delivery, source: "user", disposition: "steered" } })
}

async function seedFixture(pool: Pool, options: { name: string; planning?: boolean; pendingSteering?: boolean }): Promise<Fixture> {
  const suffix = randomUUID()
  const fixture: Fixture = {
    userId: `planning-user-${suffix}`, email: `planning-${suffix}@example.invalid`,
    sessionId: `planning-session-${suffix}`, turnId: `planning-turn-${suffix}`, rootTaskId: `planning-root-${suffix}`,
    stepId: `planning-step-${suffix}`, callId: `planning-call-${suffix}`, callItemId: `planning-call-item-${suffix}`,
    resultItemId: `planning-result-item-${suffix}`, originalInputId: `planning-original-${suffix}`,
    originalClientMessageId: `planning-original-message-${suffix}`, consumedSteerId: null, acceptedSteerId: null,
    graphItemId: "", agendaEventId: "", owner: undefined as never, inputCursor: 1n, consumedInputIds: [],
    planning: options.planning !== false,
  }
  fixture.owner = {
    kind: "turn", userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId,
    taskId: fixture.rootTaskId, rootTaskId: fixture.rootTaskId, ownerId: `planning-lease-${suffix}`,
    leaseVersion: 1, leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [fixture.userId, fixture.email])
    await client.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, $3, 'running', 'test', CURRENT_TIMESTAMP)`, [fixture.sessionId, fixture.userId, options.name])
    const turnInput = { clientMessageId: fixture.originalClientMessageId }
    await client.query(`INSERT INTO "agent_turns"
      ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
       "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, $5, $6, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
    [fixture.turnId, fixture.sessionId, fixture.userId, JSON.stringify(turnInput), fixture.owner.ownerId, fixture.owner.leaseExpiresAt])
    await client.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
       "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', $4,
        '[]'::jsonb, '[]'::jsonb, $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        1, 1, $6, $7, CURRENT_TIMESTAMP)`,
    [fixture.rootTaskId, fixture.sessionId, fixture.turnId, options.name,
      JSON.stringify(fixture.planning ? ["agent.plan", "agent.reconcile", "agent.ask_user"] : ["agent.ask_user"]),
      fixture.owner.ownerId, fixture.owner.leaseExpiresAt])
    await client.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [fixture.rootTaskId])
    await client.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [fixture.rootTaskId, fixture.turnId])

    const steering = options.pendingSteering ? [
      { id: `planning-consumed-${suffix}`, clientMessageId: `planning-consumed-message-${suffix}`, sequence: 2,
        delivery: "steer" as const, status: "consumed" as const, text: `Consumed steer ${suffix}`, consumedByStepId: fixture.stepId },
      { id: `planning-accepted-${suffix}`, clientMessageId: `planning-accepted-message-${suffix}`, sequence: 3,
        delivery: "steer" as const, status: "accepted" as const, text: `Accepted steer ${suffix}`, consumedByStepId: null },
    ] : []
    fixture.consumedSteerId = steering[0]?.id ?? null
    fixture.acceptedSteerId = steering[1]?.id ?? null
    fixture.inputCursor = BigInt(steering.at(-1)?.sequence ?? 1)
    fixture.consumedInputIds = [fixture.originalInputId, ...(fixture.consumedSteerId ? [fixture.consumedSteerId] : [])]
    await client.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds",
       "modelProfileSnapshot", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd", "startedAt")
      VALUES ($1, $2, $3, $4, 1, 1, 'streaming', $5, $6::jsonb, '{}'::jsonb, NULL, 0, 0, 0, CURRENT_TIMESTAMP)`,
    [fixture.stepId, fixture.sessionId, fixture.turnId, fixture.rootTaskId, fixture.inputCursor.toString(), JSON.stringify(fixture.consumedInputIds)])
    await insertInput(client, fixture, { id: fixture.originalInputId, clientMessageId: fixture.originalClientMessageId, acceptedSequence: 1,
      delivery: "follow_up", status: "consumed", text: options.name, consumedByStepId: fixture.stepId })
    for (const input of steering) await insertInput(client, fixture, { ...input, acceptedSequence: input.sequence,
      consumedByStepId: input.consumedByStepId ?? undefined })
    const lastInputSequence = steering.at(-1)?.sequence ?? 1
    await client.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [fixture.sessionId, lastInputSequence])

    fixture.graphItemId = taskGraphItemId(fixture.rootTaskId)
    await client.query(`INSERT INTO "agent_items"
      ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'task_graph', 'streaming', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [fixture.graphItemId, fixture.sessionId, fixture.turnId, fixture.stepId, fixture.rootTaskId,
      JSON.stringify({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] })])
    const stepContext: StepContext = { schemaVersion: "agent-harness.v2", sessionId: fixture.sessionId, turnId: fixture.turnId,
      stepId: fixture.stepId, inputThroughSequence: fixture.inputCursor, consumedInputIds: fixture.consumedInputIds,
      canonicalJson: "{}", blocks: [], taskGraphRevision: 1 }
    const agenda = buildCognitiveActionAgenda(stepContext)
    const agendaReceipt = buildCognitiveAgendaReceipt({ sessionId: fixture.sessionId, turnId: fixture.turnId,
      taskId: fixture.rootTaskId, stepId: fixture.stepId, agenda, inputThroughSequence: fixture.inputCursor,
      consumedInputIds: fixture.consumedInputIds })
    const agendaKey = cognitiveAgendaReceiptIdempotencyKey(fixture.stepId)
    if (!agendaReceipt || !agendaKey) throw new Error("Planning clarification fixture could not build its owned agenda")
    const agendaSequence = lastInputSequence + 1
    fixture.agendaEventId = await insertEvent(client, { fixture, sequence: agendaSequence, type: "cognitive.agenda", actor: "orchestrator",
      itemId: null, taskId: fixture.rootTaskId, correlationId: fixture.stepId, idempotencyKey: agendaKey, payload: agendaReceipt })
    await client.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [fixture.sessionId, agendaSequence])
    const callInput = { question: intent.question, choices: intent.options }
    await client.query(`INSERT INTO "agent_items"
      ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', 'commentary', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [fixture.callItemId, fixture.sessionId, fixture.turnId, fixture.stepId, fixture.rootTaskId,
      JSON.stringify({ toolCallId: fixture.callId, toolName: "agent.ask_user", toolVersion: "1", input: callInput })])
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
  fixtures.push(fixture)
  return fixture
}

async function stageAndCompleteQuestion(pool: TurnQuestionPool, fixture: Fixture): Promise<void> {
  const store = createPgTurnQuestionStore(pool)
  await store.stageQuestionUsage({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId,
    finishReason: "tool_calls", usage: { inputTokens: 31, outputTokens: 9, estimatedCostUsd: 0.004 }, now: new Date() })
  const client = await admin!.connect()
  try {
    await client.query(`UPDATE "agent_items" SET "status" = 'completed', "content" = $2::jsonb,
      "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [fixture.callItemId, JSON.stringify({ toolCallId: fixture.callId, toolName: "agent.ask_user", toolVersion: "1",
      status: "completed", errorCode: null, input: { question: intent.question, choices: intent.options } })])
    await client.query(`INSERT INTO "agent_items"
      ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 'commentary', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [fixture.resultItemId, fixture.sessionId, fixture.turnId, fixture.stepId, fixture.rootTaskId,
      JSON.stringify({ toolCallId: fixture.callId, output: intent, errorCode: null })])
  } finally {
    client.release()
  }
}

function createQuestionStore(applicationName: string) {
  return createPgTurnQuestionStore(runtimePool(writer!, applicationName))
}

async function acceptSteer(fixture: Fixture, applicationName: string, inputId: string): Promise<number> {
  const client = await admin!.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('application_name', $1, false)", [applicationName])
    await client.query("SELECT set_config('app.user_id', $1, true)", [fixture.userId])
    await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [fixture.sessionId, fixture.userId])
    return await writeAcceptedSteer(client, fixture, inputId, applicationName, async sequence => {
      await client.query("COMMIT")
      committed = true
      return sequence
    })
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function writeAcceptedSteer(
  client: PoolClient,
  fixture: Fixture,
  inputId: string,
  applicationName: string,
  finish: (sequence: number) => Promise<number>,
): Promise<number> {
  const clientMessageId = `${inputId}-message`
  const text = `Current instruction ${inputId}`
  const sequence = (await client.query<{ eventSequence: string | number }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [fixture.sessionId, fixture.userId])).rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("Planning clarification fixture could not allocate a steering sequence")
  const acceptedSequence = Number(sequence)
  await insertInput(client, fixture, { id: inputId, clientMessageId, acceptedSequence, delivery: "steer", status: "accepted", text })
  return finish(acceptedSequence)
}

async function beginSessionBlocker(fixture: Fixture): Promise<{ client: PoolClient; pid: number }> {
  const client = await admin!.connect()
  await client.query("BEGIN")
  const pid = Number((await client.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]?.pid)
  await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [fixture.sessionId, fixture.userId])
  return { client, pid }
}

async function waitForLockWait(applicationName: string, blockerPid?: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const blockers = (await admin!.query<{ blockers: number[] }>(`SELECT pg_blocking_pids(waiter.pid) AS blockers
      FROM pg_stat_activity AS waiter WHERE waiter.application_name = $1 AND waiter.wait_event_type = 'Lock'`, [applicationName])).rows[0]?.blockers
    if (blockers?.length && (blockerPid === undefined || blockers.includes(blockerPid))) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Planning clarification acceptance did not reach the expected Session lock: ${applicationName}`)
}

async function acceptQuestionAnswer(fixture: Fixture, waitId: string, answer: string): Promise<void> {
  const itemId = questionItemId(waitId)
  const client = await admin!.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [fixture.userId])
    await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [fixture.sessionId, fixture.userId])
    const turn = await client.query<{ revision: number }>(`SELECT "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 FOR UPDATE`, [fixture.turnId, fixture.sessionId])
    const nextRevision = Number(turn.rows[0]?.revision) + 1
    const updated = await client.query(`UPDATE "agent_items" SET "status" = 'completed',
      "content" = jsonb_set(jsonb_set("content", '{answer}', $2::jsonb), '{answerAvailable}', 'true'::jsonb),
      "revision" = "revision" + 1, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "type" = 'question' AND "status" = 'started'`,
    [itemId, JSON.stringify(answer), fixture.sessionId, fixture.turnId])
    if (updated.rowCount !== 1) throw new Error("Planning clarification fixture could not seed an unanswered question")
    await client.query(`UPDATE "agent_turns" SET "status" = 'in_progress', "revision" = $2, "completedAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "sessionId" = $3`, [fixture.turnId, nextRevision, fixture.sessionId])
    const sequence = (await client.query<{ eventSequence: string | number }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
      WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [fixture.sessionId, fixture.userId])).rows[0]?.eventSequence
    if (sequence === undefined) throw new Error("Planning clarification fixture could not allocate the answer sequence")
    await insertEvent(client, { fixture, sequence: Number(sequence), type: "question.answered", actor: "user", itemId, taskId: null,
      correlationId: waitId, causationId: itemId, idempotencyKey: `agent-command:question-answer:${waitId}`,
      payload: { waitKind: "question", waitId, itemId, turnId: fixture.turnId, toolCallId: fixture.callId,
        status: "answered", nextTurnRevision: nextRevision, answerAvailable: true } })
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function seedResumedStep(fixture: Fixture, inputCursor: number): Promise<string> {
  const stepId = `${fixture.stepId}-resumed`
  const client = await admin!.connect()
  try {
    await client.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds",
       "modelProfileSnapshot", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd", "startedAt")
      VALUES ($1, $2, $3, $4, 2, 1, 'streaming', $5, '[]'::jsonb, '{}'::jsonb, NULL, 0, 0, 0, CURRENT_TIMESTAMP)`,
    [stepId, fixture.sessionId, fixture.turnId, fixture.rootTaskId, inputCursor])
  } finally {
    client.release()
  }
  return stepId
}

async function planningEvent(pool: Pool, fixture: Fixture, waitId: string): Promise<{ id: string; payload: Record<string, unknown>; sequence: number }> {
  const key = `turn:${fixture.turnId}:event:planning-clarification:${waitId}`
  const result = await pool.query<{ id: string; payload: Record<string, unknown>; sequence: string | number }>(
    `SELECT "id", "payload", "sequence" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [fixture.sessionId, key],
  )
  const row = result.rows[0]
  if (!row) throw new Error("Planning clarification receipt was not written")
  return { id: row.id, payload: row.payload, sequence: Number(row.sequence) }
}

async function cleanFixtureData(pool: Pool): Promise<void> {
  if (!fixtures.length) return
  const sessions = fixtures.map(fixture => fixture.sessionId)
  const users = fixtures.map(fixture => fixture.userId)
  await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [sessions])
  await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = ANY($1::text[])`, [sessions])
  await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [users])
}

async function withAdminClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await admin!.connect()
  try {
    return await work(client)
  } finally {
    client.release()
  }
}

describePg("planning clarification wait persistence on disposable PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl!, max: 10 })
    await saveRlsState(admin)
    await admin.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
    runtimeRoleCreated = true
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
    await admin.query(`GRANT SELECT ON TABLE public."agent_sessions", public."agent_turns", public."sub_agent_tasks", public."agent_steps",
      public."agent_items", public."agent_events", public."agent_outbox", public."agent_inputs" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("eventSequence") ON "agent_sessions" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("status", "revision", "completedAt", "updatedAt") ON "agent_turns" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("attemptCount") ON public."sub_agent_tasks" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("status", "errorCode", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd", "completedAt", "inputThroughSequence", "consumedInputIds") ON "agent_steps" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("status", "content", "revision", "completedAt", "updatedAt") ON "agent_items" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("status", "consumedByStepId", "consumedAt") ON "agent_inputs" TO "${role}"`)
    await admin.query(`GRANT INSERT ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt") ON "agent_items" TO "${role}"`)
    await admin.query(`GRANT INSERT ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") ON "agent_events" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("id") ON public."agent_events", public."agent_outbox" TO "${role}"`)
    await admin.query(`GRANT INSERT ("id", "topic", "aggregateId", "idempotencyKey", "payload") ON "agent_outbox" TO "${role}"`)
    writer = new Pool({ connectionString: databaseUrl!, max: 10 })
  })

  afterAll(async () => {
    await writer?.end()
    if (!admin) return
    try {
      await cleanFixtureData(admin)
      await restoreRlsState(admin)
      if (runtimeRoleCreated) {
        await admin.query(`DROP OWNED BY "${role}"`)
        await admin.query(`DROP ROLE "${role}"`)
        runtimeRoleCreated = false
      }
    } finally {
      await admin.end()
    }
  })

  it("replays the saved receipt after Step checkpoint and agenda changes or disappear", async () => {
    const fixture = await seedFixture(admin!, { name: "plan at wait", pendingSteering: true })
    const store = createQuestionStore(`clarification_wait_${fixture.turnId}`)
    await stageAndCompleteQuestion(runtimePool(writer!, `clarification_prepare_${fixture.turnId}`), fixture)
    await admin!.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{planRevision}', 'null'::jsonb) WHERE "id" = $1`, [fixture.agendaEventId])
    const first = await store.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() })
    const row = await planningEvent(admin!, fixture, first.waitId)
    expect(first).toMatchObject({ status: "waiting_for_user", disposition: "created" })
    expect(row.payload).toMatchObject({ schemaVersion: "agent-harness.v2.plan-clarification.v1", sessionId: fixture.sessionId,
      turnId: fixture.turnId, rootTaskId: fixture.rootTaskId, stepId: fixture.stepId, toolCallId: fixture.callId,
      waitId: first.waitId, questionItemId: first.itemId, observedPlanRevision: null, graphRevisionAtAsk: 1,
      inputCheckpoint: { throughSequence: fixture.inputCursor.toString(), consumedInputIds: fixture.consumedInputIds },
    })
    expect(row.payload.pendingSteers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.consumedSteerId, status: "consumed", consumedByStepId: fixture.stepId, consumingOrdinal: 1 }),
      expect.objectContaining({ id: fixture.acceptedSteerId, status: "accepted", consumedByStepId: null, consumingOrdinal: null }),
    ]))
    expect(row.sequence).toBeGreaterThan(fixture.inputCursor)
    expect(JSON.stringify(row.payload)).not.toContain(intent.question)
    expect(JSON.stringify(row.payload)).not.toContain("answer")
    const count = await admin!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [fixture.sessionId, PRIVATE_EVENT])
    expect(count.rows[0]?.count).toBe(1)
    const outbox = await admin!.query(`SELECT "id" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`agent-event:${row.id}`])
    expect(outbox.rows).toHaveLength(0)

    const laterSteerId = `planning-later-steer-${fixture.turnId}`
    const laterSteerSequence = await acceptSteer(fixture, `clarification_later_steer_${fixture.turnId}`, laterSteerId)
    await admin!.query(`UPDATE "agent_inputs" SET "status" = 'consumed', "consumedByStepId" = $2, "consumedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [laterSteerId, fixture.stepId])
    await admin!.query(`UPDATE "agent_steps" SET "inputThroughSequence" = $2, "consumedInputIds" = $3::jsonb WHERE "id" = $1`,
      [fixture.stepId, laterSteerSequence, JSON.stringify([...fixture.consumedInputIds, laterSteerId])])
    await admin!.query(`UPDATE "agent_items" SET "revision" = 2, "content" = $2::jsonb WHERE "id" = $1`,
      [fixture.graphItemId, JSON.stringify({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "later-graph-revision" }] })])
    await admin!.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{planRevision}', '99'::jsonb) WHERE "id" = $1`, [fixture.agendaEventId])
    const beforeReplay = await admin!.query<{ sequence: string; eventCount: string }>(`SELECT session."eventSequence" AS "sequence",
      (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = session."id") AS "eventCount"
      FROM "agent_sessions" AS session WHERE session."id" = $1`, [fixture.sessionId])
    const rebuiltStore = createQuestionStore(`clarification_rebuilt_${fixture.turnId}`)
    const replay = await rebuiltStore.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() })
    expect(replay).toMatchObject({ status: "waiting_for_user", disposition: "replayed", waitId: first.waitId, itemId: first.itemId })
    const afterReplay = await admin!.query<{ sequence: string; eventCount: string }>(`SELECT session."eventSequence" AS "sequence",
      (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = session."id") AS "eventCount"
      FROM "agent_sessions" AS session WHERE session."id" = $1`, [fixture.sessionId])
    expect(afterReplay.rows).toEqual(beforeReplay.rows)
    await expect(withRuntimeTransaction(runtimePool(writer!, `clarification_read_${fixture.turnId}`), fixture.userId,
      client => readTurnQuestionPlanningWait(client, readOwner(fixture), waitRef(fixture, first.waitId)))).resolves.toMatchObject({
      observedPlanRevision: null, graphRevisionAtAsk: 1, pendingSteerCount: 2, unconsumedSteerCount: 1,
      inputThroughSequence: fixture.inputCursor.toString(),
    })
    await admin!.query(`DELETE FROM "agent_events" WHERE "id" = $1`, [fixture.agendaEventId])
    const replayAfterAgendaRemoval = await rebuiltStore.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() })
    expect(replayAfterAgendaRemoval).toMatchObject({ status: "waiting_for_user", disposition: "replayed", waitId: first.waitId, itemId: first.itemId })
    const foreignFixture = await seedFixture(admin!, { name: "foreign tenant reader" })
    await expect(withRuntimeTransaction(runtimePool(writer!, `clarification_foreign_${fixture.turnId}`), foreignFixture.userId,
      client => readTurnQuestionPlanningWait(client, { ...readOwner(fixture), userId: foreignFixture.userId }, waitRef(fixture, first.waitId))))
      .resolves.toBeNull()
    const statuses = await admin!.query<{ id: string; status: string; consumedByStepId: string | null }>(
      `SELECT "id", "status", "consumedByStepId" FROM "agent_inputs" WHERE "sessionId" = $1 AND "id" = ANY($2::text[]) ORDER BY "id"`,
      [fixture.sessionId, [fixture.consumedSteerId, fixture.acceptedSteerId, `planning-later-steer-${fixture.turnId}`]])
    expect(statuses.rows.find(input => input.id === fixture.consumedSteerId)).toMatchObject({ status: "consumed", consumedByStepId: fixture.stepId })
    expect(statuses.rows.find(input => input.id === fixture.acceptedSteerId)).toMatchObject({ status: "accepted", consumedByStepId: null })
    expect(statuses.rows.find(input => input.id === laterSteerId)).toMatchObject({ status: "consumed", consumedByStepId: fixture.stepId })
    const gates = await admin!.query<{ reconciliations: number; dispatches: number }>(`SELECT
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'agent.plan.reconciliation') AS "reconciliations",
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch') AS "dispatches"`, [fixture.sessionId])
    expect(gates.rows[0]).toEqual({ reconciliations: 0, dispatches: 0 })
  })

  it("rejects malformed, foreign, and duplicate saved receipts, while missing legacy receipts replay without backfill", async () => {
    const fixture = await seedFixture(admin!, { name: "strict saved receipt" })
    const pool = runtimePool(writer!, `clarification_validate_${fixture.turnId}`)
    const store = createPgTurnQuestionStore(pool)
    await stageAndCompleteQuestion(pool, fixture)
    const wait = await store.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() })
    const ref = waitRef(fixture, wait.waitId)
    const savedReceipt = await planningEvent(admin!, fixture, wait.waitId)

    await admin!.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{inputCheckpoint,throughSequence}', '"08"'::jsonb) WHERE "id" = $1`, [savedReceipt.id])
    await expect(withRuntimeTransaction(pool, fixture.userId, client => readTurnQuestionPlanningWait(client, readOwner(fixture), ref))).rejects.toThrow()
    await admin!.query(`UPDATE "agent_events" SET "payload" = $2::jsonb WHERE "id" = $1`, [savedReceipt.id, JSON.stringify(savedReceipt.payload)])

    await admin!.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{unexpected}', '"private-corruption"'::jsonb) WHERE "id" = $1`, [savedReceipt.id])
    await expect(withRuntimeTransaction(pool, fixture.userId, client => readTurnQuestionPlanningWait(client, readOwner(fixture), ref))).rejects.toThrow()
    await admin!.query(`UPDATE "agent_events" SET "payload" = $2::jsonb WHERE "id" = $1`, [savedReceipt.id, JSON.stringify(savedReceipt.payload)])

    await admin!.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{rootTaskId}', $2::jsonb) WHERE "id" = $1`,
      [savedReceipt.id, JSON.stringify(`foreign-${fixture.rootTaskId}`)])
    await expect(withRuntimeTransaction(pool, fixture.userId, client => readTurnQuestionPlanningWait(client, readOwner(fixture), ref))).rejects.toThrow()
    await admin!.query(`UPDATE "agent_events" SET "payload" = $2::jsonb WHERE "id" = $1`, [savedReceipt.id, JSON.stringify(savedReceipt.payload)])

    const duplicateSequence = Number((await admin!.query<{ eventSequence: string }>(`SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [fixture.sessionId])).rows[0]?.eventSequence) + 1
    await admin!.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [fixture.sessionId, duplicateSequence])
    const duplicateId = await withAdminClient(client => insertEvent(client, { fixture, sequence: duplicateSequence,
      type: PRIVATE_EVENT, actor: "orchestrator", itemId: null, taskId: fixture.rootTaskId, correlationId: fixture.turnId,
      idempotencyKey: `duplicate-planning-receipt-${fixture.turnId}`, payload: savedReceipt.payload }))
    await expect(withRuntimeTransaction(pool, fixture.userId, client => readTurnQuestionPlanningWait(client, readOwner(fixture), ref))).rejects.toThrow()
    await admin!.query(`DELETE FROM "agent_events" WHERE "id" = $1`, [duplicateId])
    await admin!.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [fixture.sessionId, duplicateSequence - 1])

    await admin!.query(`DELETE FROM "agent_events" WHERE "id" = $1`, [savedReceipt.id])
    const beforeLegacyReplay = await admin!.query<{ sequence: string; eventCount: string }>(`SELECT session."eventSequence" AS "sequence",
      (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = session."id") AS "eventCount"
      FROM "agent_sessions" AS session WHERE session."id" = $1`, [fixture.sessionId])
    await expect(withRuntimeTransaction(pool, fixture.userId, client => readTurnQuestionPlanningWait(client, readOwner(fixture), ref))).resolves.toBeNull()
    const legacyReplay = await store.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() })
    expect(legacyReplay).toMatchObject({ disposition: "replayed", waitId: wait.waitId, itemId: wait.itemId })
    const afterLegacyReplay = await admin!.query<{ sequence: string; eventCount: string }>(`SELECT session."eventSequence" AS "sequence",
      (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = session."id") AS "eventCount"
      FROM "agent_sessions" AS session WHERE session."id" = $1`, [fixture.sessionId])
    expect(afterLegacyReplay.rows).toEqual(beforeLegacyReplay.rows)
    const privateEvents = await admin!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [fixture.sessionId, PRIVATE_EVENT])
    expect(privateEvents.rows).toHaveLength(0)
  })

  it("rolls back question, Step, Turn, public events and outboxes when the private receipt insert fails", async () => {
    const fixture = await seedFixture(admin!, { name: "rollback after wait writes" })
    const pool = runtimePool(writer!, `clarification_rollback_${fixture.turnId}`)
    const store = createPgTurnQuestionStore(pool)
    await stageAndCompleteQuestion(pool, fixture)
    const before = await admin!.query<{ status: string; revision: number; eventSequence: string }>(`SELECT turn."status", turn."revision", session."eventSequence"
      FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" WHERE turn."id" = $1`, [fixture.turnId])
    const reservedSequence = Number(before.rows[0]!.eventSequence) + 3
    await withAdminClient(client => insertEvent(client, { fixture, id: `planning-sequence-reservation-${fixture.turnId}`, sequence: reservedSequence,
      type: "fixture.sequence.reservation", actor: "system", itemId: null, taskId: null, correlationId: fixture.turnId,
      idempotencyKey: `planning-sequence-reservation-${fixture.turnId}`, payload: { purpose: "force private receipt rollback" } }))
    await expect(store.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() }))
      .rejects.toMatchObject({ code: "23505" })
    const after = await admin!.query<{ status: string; revision: number; eventSequence: string; stepStatus: string; questionCount: number;
      eventCount: number; outboxCount: number; privateCount: number }>(`SELECT turn."status", turn."revision", session."eventSequence", step."status" AS "stepStatus",
      (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = session."id" AND "turnId" = turn."id" AND "type" = 'question') AS "questionCount",
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = session."id" AND "turnId" = turn."id" AND "idempotencyKey" IN
        ($2, $3, $4)) AS "eventCount",
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = session."id" AND "topic" = 'agent.events') AS "outboxCount",
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = session."id" AND "type" = $5) AS "privateCount"
      FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
      JOIN "agent_steps" AS step ON step."turnId" = turn."id" AND step."id" = $6 WHERE turn."id" = $1`,
    [fixture.turnId, `turn:${fixture.turnId}:event:step-completed:${fixture.stepId}`,
      `agent-wait:agent-wait:question:${questionId(fixture.owner, fixture.stepId, fixture.callId)}:started`,
      `turn:${fixture.turnId}:event:planning-clarification:${questionId(fixture.owner, fixture.stepId, fixture.callId)}`,
      PRIVATE_EVENT, fixture.stepId])
    expect(after.rows[0]).toMatchObject({ status: before.rows[0]?.status, revision: before.rows[0]?.revision,
      eventSequence: before.rows[0]?.eventSequence, stepStatus: "streaming", questionCount: 0, eventCount: 0, outboxCount: 0, privateCount: 0 })
  })

  it("serializes Session-locked accepted steering on either side of the wait capture", async () => {
    const beforeFixture = await seedFixture(admin!, { name: "steer queued before wait" })
    const beforePool = runtimePool(writer!, `clarification_wait_after_accept_${beforeFixture.turnId}`)
    await stageAndCompleteQuestion(beforePool, beforeFixture)
    const beforeLock = await beginSessionBlocker(beforeFixture)
    const acceptFirstName = `clarify_accept_first_${beforeFixture.turnId.slice(-8)}`
    const waitAfterName = `clarify_wait_after_accept_${beforeFixture.turnId.slice(-8)}`
    let acceptBefore: Promise<number> | undefined
    let waitAfterAccept: Promise<unknown> | undefined
    let releasedBefore = false
    try {
      acceptBefore = acceptSteer(beforeFixture, acceptFirstName, `planning-before-${beforeFixture.turnId}`)
      await waitForLockWait(acceptFirstName, beforeLock.pid)
      waitAfterAccept = createPgTurnQuestionStore(runtimePool(writer!, waitAfterName))
        .waitForQuestion({ owner: beforeFixture.owner, stepId: beforeFixture.stepId, toolCallId: beforeFixture.callId, now: new Date() })
      await waitForLockWait(waitAfterName)
      await beforeLock.client.query("COMMIT")
      releasedBefore = true
      await Promise.all([acceptBefore, waitAfterAccept])
      const beforeReceipt = await planningEvent(admin!, beforeFixture, questionId(beforeFixture.owner, beforeFixture.stepId, beforeFixture.callId))
      expect(beforeReceipt.payload.pendingSteers).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `planning-before-${beforeFixture.turnId}`, status: "accepted" }),
      ]))
    } finally {
      if (!releasedBefore) await beforeLock.client.query("ROLLBACK").catch(() => undefined)
      if (acceptBefore || waitAfterAccept) await Promise.allSettled([...(acceptBefore ? [acceptBefore] : []), ...(waitAfterAccept ? [waitAfterAccept] : [])])
      beforeLock.client.release()
    }

    const afterFixture = await seedFixture(admin!, { name: "steer queued after wait" })
    const afterPool = runtimePool(writer!, `clarification_wait_before_accept_${afterFixture.turnId}`)
    await stageAndCompleteQuestion(afterPool, afterFixture)
    const afterLock = await beginSessionBlocker(afterFixture)
    const waitBeforeName = `clarify_wait_before_accept_${afterFixture.turnId.slice(-8)}`
    const acceptSecondName = `clarify_accept_second_${afterFixture.turnId.slice(-8)}`
    let waitBeforeAccept: Promise<unknown> | undefined
    let acceptAfter: Promise<number> | undefined
    let releasedAfter = false
    try {
      waitBeforeAccept = createPgTurnQuestionStore(runtimePool(writer!, waitBeforeName))
        .waitForQuestion({ owner: afterFixture.owner, stepId: afterFixture.stepId, toolCallId: afterFixture.callId, now: new Date() })
      await waitForLockWait(waitBeforeName, afterLock.pid)
      acceptAfter = acceptSteer(afterFixture, acceptSecondName, `planning-after-${afterFixture.turnId}`)
      await waitForLockWait(acceptSecondName)
      await afterLock.client.query("COMMIT")
      releasedAfter = true
      await Promise.all([waitBeforeAccept, acceptAfter])
      const afterReceipt = await planningEvent(admin!, afterFixture, questionId(afterFixture.owner, afterFixture.stepId, afterFixture.callId))
      expect(afterReceipt.payload.pendingSteers).toEqual([])
      const later = await admin!.query<{ status: string }>(`SELECT "status" FROM "agent_inputs" WHERE "id" = $1`, [`planning-after-${afterFixture.turnId}`])
      expect(later.rows).toEqual([{ status: "accepted" }])
    } finally {
      if (!releasedAfter) await afterLock.client.query("ROLLBACK").catch(() => undefined)
      if (waitBeforeAccept || acceptAfter) await Promise.allSettled([...(waitBeforeAccept ? [waitBeforeAccept] : []), ...(acceptAfter ? [acceptAfter] : [])])
      afterLock.client.release()
    }
  }, 60_000)

  it("projects SQL-seeded answered Q/A and the saved planning summary through StepContextBuilder into the Harness request", async () => {
    const fixture = await seedFixture(admin!, { name: "answer recovery with pending steering", pendingSteering: true })
    const pool = runtimePool(writer!, `clarification_answer_${fixture.turnId}`)
    const store = createPgTurnQuestionStore(pool)
    await stageAndCompleteQuestion(pool, fixture)
    const wait = await store.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() })
    const answer = "ANSWER_PRIVATE_SENTINEL: Berlin"
    await acceptQuestionAnswer(fixture, wait.waitId, answer)
    const receiptSummary = await withRuntimeTransaction(pool, fixture.userId, client => readTurnQuestionPlanningWait(client, readOwner(fixture), waitRef(fixture, wait.waitId)))
    expect(receiptSummary).toMatchObject({ observedPlanRevision: 1, graphRevisionAtAsk: 1, pendingSteerCount: 2, unconsumedSteerCount: 1 })

    const currentSteerId = `planning-current-after-answer-${fixture.turnId}`
    const currentSteerSequence = await acceptSteer(fixture, `clarification_current_steer_${fixture.turnId}`, currentSteerId)
    const pendingBeforeBuild = await admin!.query<{ status: string; consumedByStepId: string | null }>(`SELECT "status", "consumedByStepId" FROM "agent_inputs" WHERE "id" = $1`, [currentSteerId])
    expect(pendingBeforeBuild.rows).toEqual([{ status: "accepted", consumedByStepId: null }])
    const resumedStepId = await seedResumedStep(fixture, currentSteerSequence - 1)
    const durableItems = await admin!.query(`SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "createdAt"
      FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" IN ('tool_call', 'question') ORDER BY "createdAt", "id"`,
    [fixture.sessionId, fixture.turnId])
    const steps = await admin!.query(`SELECT "id", "taskId", "ordinal", "attempt" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "ordinal"`,
      [fixture.sessionId, fixture.turnId])
    const recovered = await withRuntimeTransaction(pool, fixture.userId, client => recoverAnsweredQuestionContext(client, {
      lease: { userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId }, rootTaskId: fixture.rootTaskId,
      steps: steps.rows, toolItems: durableItems.rows, existingHistory: [], maxQuestions: 64,
    }))
    expect(recovered.history.map(entry => entry.content)).toEqual([
      { role: "assistant", type: "question", question: intent.question, options: intent.options },
      { role: "user", type: "answer", questionId: wait.waitId, text: answer },
    ])
    expect(recovered.planningClarifications).toEqual([{
      observedPlanRevision: 1, graphRevisionAtAsk: 1, pendingSteerCount: 2, unconsumedSteerCount: 1,
      inputThroughSequence: fixture.inputCursor.toString(),
    }])
    const historyPair = {
      questionEntryId: `agent-question:${wait.itemId}:question`,
      answerEntryId: `agent-question:${wait.itemId}:answer`,
    }
    expect(recovered.planningClarificationHistoryPair).toEqual(historyPair)
    expect(JSON.stringify(recovered.planningClarifications)).not.toContain(fixture.consumedSteerId)
    expect(JSON.stringify(recovered.planningClarifications)).not.toContain(fixture.acceptedSteerId)
    expect(JSON.stringify(recovered.planningClarifications)).not.toContain(answer)

    const snapshot = mergeCanonicalTurnQuestionContext({
      snapshot: { system: [{ id: "harness", content: "Follow the available tools." }], profile: [],
        goal: { id: "turn-goal", content: "Find engineering roles in Europe." }, steerHistory: [],
        businessRefs: [], toolObservations: [], taskGraphRevision: 1 },
      priorHistory: [], recovered,
    })
    expect(snapshot.planningClarificationHistoryPair).toEqual(historyPair)
    const inputStore = createPgInputClaimStore(pool, { userId: fixture.userId })
    const hydrationScope = { userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId,
      rootTaskId: fixture.rootTaskId, parentTaskId: fixture.rootTaskId, turnLeaseOwner: fixture.owner.ownerId,
      turnLeaseVersion: fixture.owner.leaseVersion, parentLeaseOwner: fixture.owner.ownerId, parentAttemptCount: 1 }
    const builder = new StepContextBuilder(inputStore, undefined, () => new Date(), hydrationScope)
    const buildInput = {
      scope: { userId: fixture.userId }, sessionId: fixture.sessionId, turnId: fixture.turnId, stepId: resumedStepId,
      snapshot, rootInputId: fixture.originalInputId, taskId: fixture.rootTaskId, mode: "new" as const,
      lease: { ownerId: fixture.owner.ownerId, leaseVersion: fixture.owner.leaseVersion, now: new Date() },
    }
    const invalidSnapshot = { ...snapshot, planningClarifications: [
      recovered.planningClarifications[0]!, recovered.planningClarifications[0]!,
    ] }
    await expect(builder.build({ ...buildInput, snapshot: invalidSnapshot })).rejects.toThrow("planning_clarification_latest_only")
    const afterFailedBuild = await admin!.query<{ status: string; consumedByStepId: string | null; inputThroughSequence: string; consumedInputIds: string[] }>(
      `SELECT input."status", input."consumedByStepId", step."inputThroughSequence", step."consumedInputIds"
       FROM "agent_inputs" AS input CROSS JOIN "agent_steps" AS step
       WHERE input."id" = $1 AND step."id" = $2`, [currentSteerId, resumedStepId])
    expect(afterFailedBuild.rows).toEqual([{
      status: "accepted", consumedByStepId: null, inputThroughSequence: String(currentSteerSequence - 1), consumedInputIds: [],
    }])

    const context = await builder.build(buildInput)
    expect(context.planningClarifications).toEqual(recovered.planningClarifications)
    expect(context).not.toHaveProperty("planningClarificationHistoryPair")
    expect(context.canonicalJson).not.toContain("planningClarificationHistoryPair")
    expect(context.canonicalJson).not.toContain("questionEntryId")
    expect(context.canonicalJson).not.toContain("answerEntryId")
    expect(context.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: "steer_history", role: "data", trust: "external_untrusted", source: "steer_history" }),
      expect.objectContaining({ layer: "steer_history", role: "data", trust: "internal_record", source: "native_question_recovery",
        content: recovered.planningClarifications[0] }),
      expect.objectContaining({ layer: "pending_input", source: "user_input" }),
    ]))
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false,
      streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const tools = [{ name: "agent.plan", version: "1" }, { name: "agent.reconcile", version: "1" }, { name: "agent.ask_user", version: "1" }]
    const request = buildModelRequest({ context, model, tools, sessionId: fixture.sessionId, turnId: fixture.turnId,
      stepId: resumedStepId, userId: fixture.userId, taskId: fixture.rootTaskId, signal: new AbortController().signal })
    const messages = request.messages.map(message => JSON.stringify(message))
    const serializedMessages = messages.join("\n")
    const systemMessages = JSON.stringify(request.messages.filter(message => message.role === "system"))
    const questionIndex = messages.findIndex(message => message.includes(intent.question))
    const answerIndex = messages.findIndex(message => message.includes(answer))
    const summaryIndex = messages.findIndex(message => message.includes("native_question_recovery"))
    expect(questionIndex).toBeGreaterThanOrEqual(0)
    expect(answerIndex).toBe(questionIndex + 1)
    expect(summaryIndex).toBe(answerIndex + 1)
    expect(serializedMessages).toContain("Accepted steer")
    expect(serializedMessages).toContain(`Current instruction ${currentSteerId}`)
    expect(messages[summaryIndex]).toContain(String(recovered.planningClarifications[0]!.graphRevisionAtAsk))
    expect(messages[summaryIndex]).not.toContain(wait.waitId)
    expect(messages[summaryIndex]).not.toContain(intent.question)
    expect(messages[summaryIndex]).not.toContain(answer)
    expect(systemMessages).toContain("Compare that pair's answer with the refreshed current TaskGraph and full current pending user instructions")
    expect(systemMessages).toContain("agent.plan")
    expect(systemMessages).toContain("agent.reconcile")
    expect(systemMessages).toContain("agent.ask_user")
    expect(systemMessages).not.toContain(intent.question)
    expect(systemMessages).not.toContain(answer)
    expect(systemMessages).not.toContain(fixture.consumedSteerId!)
    expect(systemMessages).not.toContain(fixture.acceptedSteerId!)
    expect(systemMessages).not.toContain(currentSteerId)
    expect(systemMessages).toContain("not a keep/revise decision, approval, PASS or success evidence")
    expect(systemMessages).not.toContain(historyPair.questionEntryId)
    expect(systemMessages).not.toContain(historyPair.answerEntryId)
    expect(JSON.stringify(request.metadata)).not.toContain(wait.waitId)
    expect(JSON.stringify(request.metadata)).not.toContain(answer)
    expect(JSON.stringify(request.metadata)).not.toContain("graphRevisionAtAsk")
    const currentStatus = await admin!.query<{ status: string; consumedByStepId: string | null }>(`SELECT "status", "consumedByStepId" FROM "agent_inputs" WHERE "id" = $1`, [currentSteerId])
    expect(currentStatus.rows).toEqual([{ status: "consumed", consumedByStepId: resumedStepId }])
    const gates = await admin!.query<{ reconciliations: number; dispatches: number; passed: number }>(`SELECT
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'agent.plan.reconciliation') AS "reconciliations",
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch') AS "dispatches",
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'native_verification.passed') AS "passed"`, [fixture.sessionId])
    expect(gates.rows[0]).toEqual({ reconciliations: 0, dispatches: 0, passed: 0 })
  })

  it("keeps nonplanning roots on ordinary question waits without a private planning event", async () => {
    const fixture = await seedFixture(admin!, { name: "nonplanning question", planning: false })
    await admin!.query(`REVOKE UPDATE ("attemptCount") ON public."sub_agent_tasks" FROM "${role}"`)
    const pool = runtimePool(writer!, `clarification_nonplanning_${fixture.turnId}`)
    const store = createPgTurnQuestionStore(pool)
    await stageAndCompleteQuestion(pool, fixture)
    const wait = await store.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() })
    expect(wait.disposition).toBe("created")
    const rows = await admin!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [fixture.sessionId, PRIVATE_EVENT])
    expect(rows.rows).toHaveLength(0)
    const replay = await store.waitForQuestion({ owner: fixture.owner, stepId: fixture.stepId, toolCallId: fixture.callId, now: new Date() })
    expect(replay).toMatchObject({ disposition: "replayed", waitId: wait.waitId })
    const after = await admin!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [fixture.sessionId, PRIVATE_EVENT])
    expect(after.rows).toHaveLength(0)
  })
})

