import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"

import { recoverAnsweredQuestionHistory } from "../question-answer-recovery.js"
import { resumeAgentTurn } from "../wakeup/consumer.js"
import { TurnEngine } from "./turn-engine.js"
import { createPgTurnEngineStore } from "./turn-engine-store.js"
import { claimTurnLease } from "./lease.js"
import { createPgTurnQuestionStore } from "./turn-question-store.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnQuestionPool } from "./turn-question-store-guards.js"
import type { TurnQuestionIntentEnvelope } from "./turn-question-contract.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Required question store integration needs the disposable Agent runtime PostgreSQL URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Question store integration accepts only the dedicated disposable PostgreSQL URL")
  }
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), role = `agent_runtime_question_${suffix.replaceAll("-", "")}`
const callId = `question-call-${suffix}`
const ids = { user: `question-user-${suffix}`, session: `question-session-${suffix}`, turn: `question-turn-${suffix}`, root: `question-root-${suffix}`, step: `question-step-${suffix}` }
const pausedIds = { session: `question-paused-session-${suffix}`, turn: `question-paused-turn-${suffix}`, root: `question-paused-root-${suffix}`, step: `question-paused-step-${suffix}`, call: `question-paused-call-${suffix}`, item: `question-paused-item-${suffix}` }
const orphanIds = { session: `question-orphan-session-${suffix}`, turn: `question-orphan-turn-${suffix}`, root: `question-orphan-root-${suffix}`, step: `question-orphan-step-${suffix}` }
const recoveryIds = { session: `question-recovery-session-${suffix}`, turn: `question-recovery-turn-${suffix}`, root: `question-recovery-root-${suffix}`, step: `question-recovery-step-${suffix}`, call: `question-recovery-call-${suffix}`, item: `question-recovery-item-${suffix}` }
const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: ids.user, sessionId: ids.session, turnId: ids.turn, taskId: ids.root, rootTaskId: ids.root,
  ownerId: `question-lease-${suffix}`, leaseVersion: 1, leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
}
const pausedOwner: TurnExecutionOwnerFence = { ...owner, sessionId: pausedIds.session, turnId: pausedIds.turn, taskId: pausedIds.root, rootTaskId: pausedIds.root,
  ownerId: `question-paused-lease-${suffix}` }
const orphanOwner: TurnExecutionOwnerFence = { ...owner, sessionId: orphanIds.session, turnId: orphanIds.turn, taskId: orphanIds.root, rootTaskId: orphanIds.root,
  ownerId: `question-orphan-lease-${suffix}` }
const recoveryOwner: TurnExecutionOwnerFence = { ...owner, sessionId: recoveryIds.session, turnId: recoveryIds.turn, taskId: recoveryIds.root, rootTaskId: recoveryIds.root,
  ownerId: `question-recovery-lease-${suffix}` }
const intent: TurnQuestionIntentEnvelope = {
  schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input",
  question: "Which region should I prioritize?", options: [{ label: "Berlin", value: "berlin" }],
}

async function seed(pool: PgPool): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'durable question integration', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, $4,
      $5, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [ids.turn, ids.session, ids.user, owner.ownerId, owner.leaseExpiresAt])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'durable question integration',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      1, 1, $4, $5, CURRENT_TIMESTAMP)`, [ids.root, ids.session, ids.turn, owner.ownerId, owner.leaseExpiresAt])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds",
     "modelProfileSnapshot", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd", "startedAt")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb, NULL, 0, 0, 0, CURRENT_TIMESTAMP)`,
  [ids.step, ids.session, ids.turn, ids.root])
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', 'commentary', $6::jsonb, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)` ,
  [`question-call-item-${suffix}`, ids.session, ids.turn, ids.step, ids.root, JSON.stringify({ toolCallId: callId, toolName: "agent.ask_user", toolVersion: "1", input: { question: intent.question, choices: intent.options } })])
}

async function seedPausedCase(pool: PgPool): Promise<void> {
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'paused question integration', 'running', 'test', CURRENT_TIMESTAMP)`, [pausedIds.session, ids.user])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, $4,
      $5, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [pausedIds.turn, pausedIds.session, ids.user, pausedOwner.ownerId, pausedOwner.leaseExpiresAt])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'paused question integration',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      1, 1, $4, $5, CURRENT_TIMESTAMP)`, [pausedIds.root, pausedIds.session, pausedIds.turn, pausedOwner.ownerId, pausedOwner.leaseExpiresAt])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [pausedIds.root])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [pausedIds.root, pausedIds.turn])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds",
     "modelProfileSnapshot", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd", "startedAt")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb, NULL, 0, 0, 0, CURRENT_TIMESTAMP)`,
  [pausedIds.step, pausedIds.session, pausedIds.turn, pausedIds.root])
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', 'commentary', $6::jsonb, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)`,
  [pausedIds.item, pausedIds.session, pausedIds.turn, pausedIds.step, pausedIds.root, JSON.stringify({ toolCallId: pausedIds.call, toolName: "agent.ask_user", toolVersion: "1", input: { question: intent.question, choices: intent.options } })])
}

async function seedOrphanPauseCase(pool: PgPool): Promise<void> {
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'orphan pause recovery integration', 'running', 'test', CURRENT_TIMESTAMP)`, [orphanIds.session, ids.user])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, $4,
      $5, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [orphanIds.turn, orphanIds.session, ids.user, orphanOwner.ownerId, orphanOwner.leaseExpiresAt])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'orphan pause recovery integration',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      1, 1, $4, $5, CURRENT_TIMESTAMP)`, [orphanIds.root, orphanIds.session, orphanIds.turn, orphanOwner.ownerId, orphanOwner.leaseExpiresAt])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [orphanIds.root])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [orphanIds.root, orphanIds.turn])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds",
     "modelProfileSnapshot", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd", "startedAt")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb, NULL, 0, 0, 0, CURRENT_TIMESTAMP)`,
  [orphanIds.step, orphanIds.session, orphanIds.turn, orphanIds.root])

  const startedKey = `turn:${orphanIds.turn}:event:model-started:${orphanIds.step}`
  const completedKey = `turn:${orphanIds.turn}:event:model-completed:${orphanIds.step}`
  const usageKey = `turn:${orphanIds.turn}:event:model-usage:${orphanIds.step}`
  const startedId = `${startedKey}:${suffix}`, completedId = `${completedKey}:${suffix}`, usageId = `${usageKey}:${suffix}`
  const pauseId = `orphan-pause-${suffix}`, requestedAt = new Date().toISOString()
  const events = [
    { id: startedId, sequence: 1, taskId: orphanIds.root, type: "model.started", actor: "orchestrator", correlationId: orphanIds.step,
      causationId: null, idempotencyKey: startedKey, payload: { provider: "fixture", model: "fixture", taskId: orphanIds.root } },
    { id: completedId, sequence: 2, taskId: orphanIds.root, type: "model.completed", actor: "orchestrator", correlationId: orphanIds.step,
      causationId: startedId, idempotencyKey: completedKey, payload: { taskId: orphanIds.root, provider: "fixture", model: "fixture" } },
    { id: usageId, sequence: 3, taskId: orphanIds.root, type: "model.usage", actor: "orchestrator", correlationId: orphanIds.step,
      causationId: completedId, idempotencyKey: usageKey, payload: { provider: "fixture", model: "fixture", usage: { inputTokens: 13, outputTokens: 5, estimatedCostUsd: 0.024 }, taskId: orphanIds.root } },
    { id: pauseId, sequence: 4, taskId: null, type: "session.pause_requested", actor: "user", correlationId: orphanIds.turn,
      causationId: null, idempotencyKey: "agent-session-control:pause-orphan-recovery",
      payload: { turnId: orphanIds.turn, expectedRevision: 0, requestedAt } },
  ] as const
  for (const event of events) {
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [event.id, orphanIds.session, orphanIds.turn, event.taskId, event.sequence, event.type, event.actor, event.correlationId,
      event.causationId, event.idempotencyKey, JSON.stringify(event.payload)])
  }
  await pool.query(`UPDATE "agent_sessions" SET "eventSequence" = 4 WHERE "id" = $1`, [orphanIds.session])
}

async function seedIncompleteCallRecovery(pool: PgPool): Promise<void> {
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt") VALUES ($1, $2, 'question call recovery', 'running', 'test', CURRENT_TIMESTAMP)`, [recoveryIds.session, ids.user])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, $4, $5, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
  [recoveryIds.turn, recoveryIds.session, ids.user, recoveryOwner.ownerId, recoveryOwner.leaseExpiresAt])
  await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'question call recovery', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, $4, $5, CURRENT_TIMESTAMP)`,
  [recoveryIds.root, recoveryIds.session, recoveryIds.turn, recoveryOwner.ownerId, recoveryOwner.leaseExpiresAt])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [recoveryIds.root])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [recoveryIds.root, recoveryIds.turn])
  await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd", "startedAt")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb, NULL, 0, 0, 0, CURRENT_TIMESTAMP)`,
  [recoveryIds.step, recoveryIds.session, recoveryIds.turn, recoveryIds.root])
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', 'commentary', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [recoveryIds.item, recoveryIds.session, recoveryIds.turn, recoveryIds.step, recoveryIds.root,
    JSON.stringify({ toolCallId: recoveryIds.call, toolName: "agent.ask_user", toolVersion: "1", input: { question: intent.question, choices: intent.options } })])
  const turnStartedId = `turn:${recoveryIds.turn}:event:turn-started`, modelStartedId = `turn:${recoveryIds.turn}:event:model-started:${recoveryIds.step}`
  const modelCompletedId = `turn:${recoveryIds.turn}:event:model-completed:${recoveryIds.step}`, modelUsageId = `turn:${recoveryIds.turn}:event:model-usage:${recoveryIds.step}`
  const callItemEventId = `turn:${recoveryIds.turn}:event:item-started:${recoveryIds.item}`, toolStartedId = `turn:${recoveryIds.turn}:event:tool-started:${recoveryIds.call}`
  const chain = [
    { id: turnStartedId, type: "turn.started", correlationId: recoveryIds.turn, causationId: null, key: `turn:${recoveryIds.turn}:event:turn-started`, itemId: null, payload: { goal: "question call recovery", taskId: recoveryIds.root, rootTaskId: recoveryIds.root } },
    { id: modelStartedId, type: "model.started", correlationId: recoveryIds.step, causationId: turnStartedId, key: `turn:${recoveryIds.turn}:event:model-started:${recoveryIds.step}`, itemId: null, payload: { provider: "fixture", model: "fixture", taskId: recoveryIds.root } },
    { id: modelCompletedId, type: "model.completed", correlationId: recoveryIds.step, causationId: modelStartedId, key: `turn:${recoveryIds.turn}:event:model-completed:${recoveryIds.step}`, itemId: null, payload: { provider: "fixture", model: "fixture", taskId: recoveryIds.root } },
    { id: modelUsageId, type: "model.usage", correlationId: recoveryIds.step, causationId: modelCompletedId, key: `turn:${recoveryIds.turn}:event:model-usage:${recoveryIds.step}`, itemId: null, payload: { provider: "fixture", model: "fixture", usage: { inputTokens: 41, outputTokens: 17, estimatedCostUsd: 0.012 }, taskId: recoveryIds.root } },
    { id: callItemEventId, type: "item.started", correlationId: recoveryIds.step, causationId: modelUsageId, key: `turn:${recoveryIds.turn}:event:item-started:${recoveryIds.item}`, itemId: recoveryIds.item, payload: { itemId: recoveryIds.item, type: "tool_call", phase: "commentary" } },
    { id: toolStartedId, type: "tool_call.started", correlationId: recoveryIds.call, causationId: callItemEventId, key: `turn:${recoveryIds.turn}:event:tool-started:${recoveryIds.call}`, itemId: recoveryIds.item, payload: { toolCallId: recoveryIds.call, toolName: "agent.ask_user", taskId: recoveryIds.root } },
  ] as const
  for (const [index, event] of chain.entries()) {
    const sequence = String(index + 1), envelope = { eventId: event.id, sessionId: recoveryIds.session, turnId: recoveryIds.turn, taskId: recoveryIds.root,
      itemId: event.itemId, sequence, type: event.type, actor: "orchestrator", correlationId: event.correlationId, causationId: event.causationId,
      idempotencyKey: event.key, payload: event.payload }
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'orchestrator', $8, $9, $10, $11::jsonb)`,
    [event.id, recoveryIds.session, recoveryIds.turn, event.itemId, recoveryIds.root, sequence, event.type, event.correlationId, event.causationId, event.key, JSON.stringify(event.payload)])
    await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.events', $2, $3, $4::jsonb)`,
      [`agent-outbox-${event.id}`, recoveryIds.session, `agent-event:${event.id}`, JSON.stringify(envelope)])
  }
  await pool.query(`UPDATE "agent_sessions" SET "eventSequence" = $1 WHERE "id" = $2`, [chain.length, recoveryIds.session])
}

async function appendBrokerEvent(client: PoolClient, input: {
  type: "question.answered" | "turn.wakeup"; correlationId: string; causationId: string; key: string
  payload: Record<string, unknown>; topic: "agent.session.event" | "agent.turn.wakeup"
}): Promise<string> {
  const next = await client.query<{ eventSequence: string | number | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [ids.session, ids.user])
  const sequence = String(next.rows[0]?.eventSequence)
  if (!next.rows[0]) throw new Error("Question fixture could not allocate an event sequence")
  const eventId = `question-${input.type.replaceAll(".", "-")}-${suffix}`
  const envelope = { eventId, sessionId: ids.session, turnId: ids.turn, itemId: `agent-wait:question:${input.payload.waitId}`,
    taskId: null, sequence, type: input.type, actor: "user", correlationId: input.correlationId, causationId: input.causationId,
    idempotencyKey: input.key, payload: input.payload }
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, NULL, $5, $6, 'user', $7, $8, $9, $10::jsonb)`,
  [eventId, ids.session, ids.turn, envelope.itemId, sequence, input.type, input.correlationId, input.causationId, input.key, JSON.stringify(input.payload)])
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [`agent-outbox-${eventId}`, input.topic, ids.session, `agent-event:${eventId}`, JSON.stringify(envelope)])
  return eventId
}

async function setRuntimeRole(client: PoolClient): Promise<void> { await client.query(`SET ROLE "${role}"`) }
function runtimePool(admin: PgPool): TurnQuestionPool {
  return { async connect() {
    const client = await admin.connect()
    try { await setRuntimeRole(client); return client } catch (error) { client.release(); throw error }
  } }
}

describePg("native durable user question persistence on disposable PostgreSQL", () => {
  let admin: PgPool | undefined
  let writer: PgPool | undefined
  let store: ReturnType<typeof createPgTurnQuestionStore>

  beforeAll(async () => {
    admin = new PgPool({ connectionString: databaseUrl!, max: 2 })
    await admin.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
    await admin.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events", "agent_outbox" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("eventSequence") ON "agent_sessions" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("status", "revision", "completedAt", "updatedAt") ON "agent_turns" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("status", "errorCode", "finishReason", "inputTokens", "outputTokens", "estimatedCostUsd", "completedAt") ON "agent_steps" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("status", "phase", "content", "revision", "startedAt", "completedAt", "updatedAt") ON "agent_items" TO "${role}"`)
    await admin.query(`GRANT UPDATE ("id") ON "agent_events", "agent_outbox" TO "${role}"`)
    await admin.query(`GRANT INSERT ON "agent_items", "agent_events", "agent_outbox" TO "${role}"`)
    await seed(admin)
    writer = new PgPool({ connectionString: databaseUrl!, max: 2 })
    store = createPgTurnQuestionStore(runtimePool(writer))
  })

  afterAll(async () => {
    await writer?.end()
    if (!admin) return
    await admin.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [[ids.session, pausedIds.session, orphanIds.session, recoveryIds.session]])
    await admin.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    await admin.query(`DROP OWNED BY "${role}"`)
    await admin.query(`DROP ROLE "${role}"`)
    await admin.end()
  })

  it("replays an incomplete persisted ask_user call after restart without a pause event and commits the same question", async () => {
    await seedIncompleteCallRecovery(admin!)
    let modelCalls = 0
    const executeTool = vi.fn(async ({ call }: { call: { id: string; toolName: string } }) => ({
      id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: intent, errorCode: null,
    }))
    const result = await new TurnEngine({
      lease: { turnId: recoveryIds.turn, sessionId: recoveryIds.session, ownerId: recoveryOwner.ownerId, userId: ids.user,
        leaseVersion: recoveryOwner.leaseVersion, leaseStartedAt: new Date(), leaseExpiresAt: recoveryOwner.leaseExpiresAt },
      scope: { userId: ids.user }, goal: "question call recovery", rootTaskId: recoveryIds.root,
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
      contextBuilder: { build: async () => { throw new Error("context should not be rebuilt before the recovered wait") } },
      store: createPgTurnEngineStore(runtimePool(writer!)),
      model: { id: "must-not-run", profile: {}, async *stream() { modelCalls += 1; throw new Error("model was invoked during question recovery") } },
      tools: [], executeTool: executeTool as never, now: () => new Date(), idFactory: (prefix: string) => prefix,
      toolCallRecovery: [{ action: "replay", stepId: recoveryIds.step, toolVersion: "1",
        call: { id: recoveryIds.call, name: "agent.ask_user", arguments: { question: intent.question, choices: intent.options } },
        callItem: { id: recoveryIds.item, revision: 0 } }],
    } as never).run()

    expect(result).toMatchObject({ status: "waiting_for_user" })
    expect(modelCalls).toBe(0)
    expect(executeTool).toHaveBeenCalledOnce()
    const state = await admin!.query<{ turnStatus: string; stepStatus: string; finishReason: string; inputTokens: number; outputTokens: number;
      callStatus: string; resultStatus: string; questionCount: string; pauseCount: string; terminalCount: string; questionItemId: string;
      questionStepId: string; questionStatus: string; questionId: string; questionCallId: string; questionText: string }>(
      `SELECT turn."status" AS "turnStatus", step."status" AS "stepStatus", step."finishReason", step."inputTokens", step."outputTokens",
        call."status" AS "callStatus", result."status" AS "resultStatus",
        (SELECT COUNT(*)::text FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'question') AS "questionCount",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'session.pause_requested') AS "pauseCount",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" IN ('turn.completed', 'turn.failed')) AS "terminalCount",
        question."id" AS "questionItemId", question."stepId" AS "questionStepId", question."status" AS "questionStatus",
        question."content"->>'questionId' AS "questionId", question."content"->>'toolCallId' AS "questionCallId", question."content"->>'question' AS "questionText"
       FROM "agent_turns" AS turn JOIN "agent_steps" AS step ON step."turnId" = turn."id"
       JOIN "agent_items" AS call ON call."stepId" = step."id" AND call."type" = 'tool_call'
       JOIN "agent_items" AS result ON result."stepId" = step."id" AND result."type" = 'tool_result'
       JOIN "agent_items" AS question ON question."sessionId" = turn."sessionId" AND question."turnId" = turn."id"
         AND question."stepId" = step."id" AND question."type" = 'question' AND question."content"->>'toolCallId' = $3
       WHERE turn."id" = $2 AND call."content"->>'toolCallId' = $3 AND result."content"->>'toolCallId' = $3`,
      [recoveryIds.session, recoveryIds.turn, recoveryIds.call])
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ turnStatus: "waiting_for_user", stepStatus: "waiting_for_user", finishReason: "tool_calls",
      inputTokens: 41, outputTokens: 17, callStatus: "completed", resultStatus: "completed", questionCount: "1", pauseCount: "0", terminalCount: "0" })
    expect(state.rows[0]).toMatchObject({ questionItemId: `agent-wait:question:${state.rows[0]?.questionId}`, questionStepId: recoveryIds.step,
      questionStatus: "started", questionCallId: recoveryIds.call, questionText: intent.question })
  }, 30_000)

  it("atomically cancels and replays a paused pre-intent call with restricted-role readback", async () => {
    await seedPausedCase(admin!)
    const input = { owner: pausedOwner, stepId: pausedIds.step, toolCallId: pausedIds.call,
      callArguments: { question: intent.question, choices: intent.options }, finishReason: "tool_calls",
      usage: { inputTokens: 29, outputTokens: 7, estimatedCostUsd: 0.006 }, now: new Date() }
    await expect(store.cancelPausedQuestion(input)).resolves.toBe("cancelled")
    await expect(store.cancelPausedQuestion(input)).resolves.toBe("cancelled")
    await expect(store.readPendingQuestion({ owner: pausedOwner, now: new Date() })).resolves.toEqual({ status: "none" })
    const rows = await admin!.query<{ stepStatus: string; stepErrorCode: string; finishReason: string; inputTokens: number; outputTokens: number; cost: string; callStatus: string; callContent: Record<string, unknown>; events: string; outboxes: string }>(
      `SELECT step."status" AS "stepStatus", step."errorCode" AS "stepErrorCode", step."finishReason", step."inputTokens", step."outputTokens", step."estimatedCostUsd" AS "cost",
        call."status" AS "callStatus", call."content" AS "callContent",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2) AS "events",
        (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.events') AS "outboxes"
       FROM "agent_steps" AS step JOIN "agent_items" AS call ON call."stepId" = step."id"
       WHERE step."id" = $3 AND call."id" = $4`, [pausedIds.session, pausedIds.turn, pausedIds.step, pausedIds.item])
    expect(rows.rows[0]).toMatchObject({ stepStatus: "interrupted", stepErrorCode: "session_pause_requested", finishReason: "tool_calls",
      inputTokens: 29, outputTokens: 7, callStatus: "interrupted", callContent: { status: "cancelled", errorCode: null } })
    expect(Number(rows.rows[0]?.cost)).toBeCloseTo(0.006)
    expect(rows.rows[0]?.events).toBe("3")
    expect(rows.rows[0]?.outboxes).toBe("3")
  })

  it("restores only exact usage for a paused orphan streaming Step with restricted-role readback", async () => {
    await seedOrphanPauseCase(admin!)
    const now = new Date()
    const startedKey = `turn:${orphanIds.turn}:event:model-started:${orphanIds.step}`
    const completedKey = `turn:${orphanIds.turn}:event:model-completed:${orphanIds.step}`
    const usageEventKey = `turn:${orphanIds.turn}:event:model-usage:${orphanIds.step}`
    const startedEventId = `${startedKey}:${suffix}`, completedEventId = `${completedKey}:${suffix}`, usageEventId = `${usageEventKey}:${suffix}`
    const chain = await admin!.query<{ id: string; sequence: string; type: string; actor: string; correlationId: string; causationId: string | null;
      idempotencyKey: string; payload: Record<string, unknown> }>(
      `SELECT "id", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" IN ('model.started', 'model.completed', 'model.usage') ORDER BY "sequence"`,
      [orphanIds.session, orphanIds.turn])
    expect(chain.rows).toMatchObject([
      { id: startedEventId, sequence: "1", type: "model.started", actor: "orchestrator", correlationId: orphanIds.step, causationId: null,
        idempotencyKey: startedKey, payload: { taskId: orphanIds.root, provider: "fixture", model: "fixture" } },
      { id: completedEventId, sequence: "2", type: "model.completed", actor: "orchestrator", correlationId: orphanIds.step, causationId: startedEventId,
        idempotencyKey: completedKey, payload: { taskId: orphanIds.root, provider: "fixture", model: "fixture" } },
      { id: usageEventId, sequence: "3", type: "model.usage", actor: "orchestrator", correlationId: orphanIds.step, causationId: completedEventId,
        idempotencyKey: usageEventKey, payload: { taskId: orphanIds.root, provider: "fixture", model: "fixture", usage: { inputTokens: 13, outputTokens: 5, estimatedCostUsd: 0.024 } } },
    ])
    await expect(store.readPendingQuestion({ owner: orphanOwner, now })).rejects.toMatchObject({ code: "orphan_pause_usage_recovered_reload_required" })
    await expect(store.readPendingQuestion({ owner: orphanOwner, now })).resolves.toEqual({ status: "none" })

    const rows = await admin!.query<{ status: string; errorCode: string; finishReason: string | null; inputTokens: number; outputTokens: number; cost: string;
      eventCount: string; recoveredCount: string; outboxCount: string; toolItems: string; questionItems: string; finalEvents: string;
      recoveredId: string; causationId: string; idempotencyKey: string; eventPayload: Record<string, unknown>; outboxPayload: Record<string, unknown> }>(
      `SELECT step."status", step."errorCode", step."finishReason", step."inputTokens", step."outputTokens", step."estimatedCostUsd" AS "cost",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2) AS "eventCount",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'step.completed'
          AND "idempotencyKey" LIKE 'turn:' || $2 || ':event:question-pause-orphan:%:step') AS "recoveredCount",
        (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.events') AS "outboxCount",
        (SELECT COUNT(*)::text FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "stepId" = $3
          AND "type" IN ('tool_call', 'tool_result')) AS "toolItems",
        (SELECT COUNT(*)::text FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'question') AS "questionItems",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" IN ('turn.completed', 'turn.failed')) AS "finalEvents",
        event."id" AS "recoveredId", event."causationId", event."idempotencyKey", event."payload" AS "eventPayload", outbox."payload" AS "outboxPayload"
       FROM "agent_steps" AS step JOIN "agent_events" AS event ON event."sessionId" = step."sessionId" AND event."turnId" = step."turnId"
         AND event."type" = 'step.completed' AND event."correlationId" = step."id"
       JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
       WHERE step."id" = $3`, [orphanIds.session, orphanIds.turn, orphanIds.step])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ status: "interrupted", errorCode: "session_pause_requested", finishReason: null, inputTokens: 13, outputTokens: 5,
      eventCount: "5", recoveredCount: "1", outboxCount: "1", toolItems: "0", questionItems: "0", finalEvents: "0",
      causationId: usageEventId, eventPayload: { stepId: orphanIds.step, status: "interrupted", errorCode: "session_pause_requested", toolCallCount: 0, taskId: orphanIds.root } })
    expect(Number(rows.rows[0]?.cost)).toBeCloseTo(0.024)
    expect(rows.rows[0]?.idempotencyKey).toMatch(new RegExp(`^turn:${orphanIds.turn}:event:question-pause-orphan:[a-f0-9]{64}:step$`))
    expect(rows.rows[0]?.outboxPayload).toMatchObject({ eventId: rows.rows[0]?.recoveredId, type: "step.completed", causationId: usageEventId })
  }, 30_000)

  it("serializes concurrent waits, preserves the safe broker item, and reads the same-Turn answer projection", async () => {
    const now = new Date()
    await store.stageQuestionUsage({ owner, stepId: ids.step, toolCallId: callId, finishReason: "tool_calls",
      usage: { inputTokens: 27, outputTokens: 11, estimatedCostUsd: 0.004 }, now })
    const callCompleted = await admin!.query(`UPDATE "agent_items" SET "status" = 'completed', "content" = jsonb_set(jsonb_set("content", '{status}', '"completed"'::jsonb), '{errorCode}', 'null'::jsonb),
      "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "status" = 'started'`, [`question-call-item-${suffix}`])
    expect(callCompleted.rowCount).toBe(1)
    await admin!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 'commentary', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [`question-result-item-${suffix}`, ids.session, ids.turn, ids.step, ids.root, JSON.stringify({ toolCallId: callId, output: intent, errorCode: null })])
    const input = { owner, stepId: ids.step, toolCallId: callId, now }
    const receipts = await Promise.all([store.waitForQuestion(input), store.waitForQuestion(input)])
    expect(receipts.map(value => value.disposition).sort()).toEqual(["created", "replayed"])
    expect(receipts.map(value => value.waitId)).toEqual([receipts[0]!.waitId, receipts[0]!.waitId])
    const waited = await admin!.query<{ status: string; revision: number }>(`SELECT turn."status", turn."revision" FROM "agent_turns" AS turn WHERE turn."id" = $1`, [ids.turn])
    expect(waited.rows[0]?.status).toBe("waiting_for_user")
    const question = await admin!.query<{ id: string; status: string; content: Record<string, unknown> }>(`SELECT "id", "status", "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'question'`, [ids.session, ids.turn])
    expect(question.rows).toHaveLength(1)
    expect(question.rows[0]).toMatchObject({ status: "started", content: {
      waitKind: "question", questionId: receipts[0]!.waitId, toolCallId: callId, stage: "user_input",
      question: intent.question, options: intent.options, answer: null, answerAvailable: false,
    } })
    const events = await admin!.query<{ type: string; actor: string; payload: Record<string, unknown> }>(`SELECT "type", "actor", "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "sequence"`, [ids.session, ids.turn])
    expect(events.rows.map(row => row.type)).toEqual(["step.completed", "item.started"])
    expect(events.rows[1]).toMatchObject({ actor: "orchestrator", payload: { itemId: question.rows[0]!.id, waitKind: "question", questionId: receipts[0]!.waitId, toolCallId: callId } })
    const outbox = await admin!.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.events'`, [ids.session])
    expect(outbox.rows).toHaveLength(2)

    const payload = { waitKind: "question", waitId: receipts[0]!.waitId, sessionId: ids.session, itemId: question.rows[0]!.id,
      turnId: ids.turn, toolCallId: callId, status: "answered", nextTurnRevision: receipts[0]!.nextTurnRevision + 1, answerAvailable: true }
    const answerClient = await admin!.connect()
    let answerEventId = ""
    let wakeupEventId = ""
    try {
      await answerClient.query("BEGIN")
      const answeredItem = await answerClient.query(`UPDATE "agent_items" SET "status" = 'completed', "content" = jsonb_set(jsonb_set("content", '{answer}', '"berlin"'::jsonb), '{answerAvailable}', 'true'::jsonb),
        "revision" = "revision" + 1, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "status" = 'started'`, [question.rows[0]!.id])
      expect(answeredItem.rowCount).toBe(1)
      const answeredTurn = await answerClient.query<{ revision: number }>(`UPDATE "agent_turns" SET "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "status" = 'waiting_for_user' AND "revision" = $2 RETURNING "revision"`,
        [ids.turn, receipts[0]!.nextTurnRevision])
      expect(Number(answeredTurn.rows[0]?.revision)).toBe(payload.nextTurnRevision)
      const key = `question-answer:${suffix}`
      answerEventId = await appendBrokerEvent(answerClient, { type: "question.answered", correlationId: receipts[0]!.waitId,
        causationId: question.rows[0]!.id, key, topic: "agent.session.event", payload })
      wakeupEventId = await appendBrokerEvent(answerClient, { type: "turn.wakeup", correlationId: ids.turn, causationId: answerEventId,
        key: `${key}:wakeup`, topic: "agent.turn.wakeup", payload })
      await answerClient.query("COMMIT")
    } catch (error) {
      await answerClient.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally { answerClient.release() }

    const wakeResult = await resumeAgentTurn(admin!, { eventId: wakeupEventId, sessionId: ids.session, turnId: ids.turn,
      itemId: question.rows[0]!.id, waitKind: "question", waitId: receipts[0]!.waitId, toolCallId: callId,
      status: "answered", nextTurnRevision: payload.nextTurnRevision })
    expect(wakeResult).toMatchObject({ status: "resumed", turnId: ids.turn, itemId: question.rows[0]!.id })
    const resumed = await admin!.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id" = $1`, [ids.turn])
    expect(resumed.rows[0]?.status).toBe("queued")
    const lease = await claimTurnLease(admin!, { turnId: ids.turn, sessionId: ids.session, ownerId: `question-recovery-${suffix}` })
    const resumedOwner: TurnExecutionOwnerFence = { kind: "turn", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
      taskId: ids.root, rootTaskId: ids.root, ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt }
    await expect(store.readPendingQuestion({ owner: resumedOwner, now: new Date() }))
      .resolves.toMatchObject({ status: "answered", turnId: ids.turn, waitId: receipts[0]!.waitId })
    const historyClient = await admin!.connect()
    try {
      const [steps, toolItems] = await Promise.all([
        historyClient.query(`SELECT "id", "taskId" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2`, [ids.session, ids.turn]),
        historyClient.query(`SELECT "id", "stepId", "taskId", "type", "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'tool_call'`, [ids.session, ids.turn]),
      ])
      await expect(recoverAnsweredQuestionHistory(historyClient, { lease, rootTaskId: ids.root, steps: steps.rows, toolItems: toolItems.rows, existingHistory: [] }))
        .resolves.toEqual([
          { id: `agent-question:${question.rows[0]!.id}:question`, content: { role: "assistant", type: "question", question: intent.question, options: intent.options } },
          { id: `agent-question:${question.rows[0]!.id}:answer`, content: { role: "user", type: "answer", questionId: receipts[0]!.waitId, text: "berlin" } },
        ])
    } finally { historyClient.release() }
  }, 30_000)
})
