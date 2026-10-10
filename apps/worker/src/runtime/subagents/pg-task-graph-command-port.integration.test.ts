import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"

import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import type { TaskGraphReadScope, TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"
import { canonicalTaskGraphJson, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { assertNoUnresolvedSteering } from "./steering-reconciliation-ledger.js"
import { transaction } from "./pg-store-persistence.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import { steeringReconciliationIdempotencyKey, STEERING_RECONCILIATION_EVENT_TYPE } from "./steering-reconciliation-contract.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const ANALYST_VERIFICATION = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const

function dedicatedDisposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (process.env.CI !== "true" && !required) return null
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) {
      throw new Error("Required TaskGraph PostgreSQL integration tests need AGENT_RUNTIME_PG_TEST_URL and AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
    }
    return null
  }

  const url = new URL(value)
  if (
    url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("TaskGraph PostgreSQL integration tests require the dedicated disposable CI service URL")
  }
  return value
}

const databaseUrl = dedicatedDisposableUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip

type Fixture = {
  readonly userId: string
  readonly foreignUserId: string
  readonly foreignSessionId: string
  readonly foreignTurnId: string
  readonly foreignRootTaskId: string
  readonly foreignStepId: string
  readonly foreignItemId: string
  readonly foreignEventId: string
  readonly foreignOutboxId: string
  readonly foreignInputId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly stepId: string
  readonly originStepId: string
  readonly keepStepId: string
  readonly laterStepId: string
  readonly originalInputId: string
  readonly originalClientMessageId: string
  readonly firstSteerInputId: string
  readonly firstSteerClientMessageId: string
  readonly secondSteerInputId: string
  readonly secondSteerClientMessageId: string
  readonly planCallId: string
  readonly keepCallId: string
  readonly turnLeaseOwner: string
  readonly parentLeaseOwner: string
}

function fixture(): Fixture {
  const suffix = randomUUID()
  return {
    userId: `p3-task-graph-user-${suffix}`,
    foreignUserId: `p3-task-graph-foreign-user-${suffix}`,
    foreignSessionId: `p3-task-graph-foreign-session-${suffix}`,
    foreignTurnId: `p3-task-graph-foreign-turn-${suffix}`,
    foreignRootTaskId: `p3-task-graph-foreign-root-${suffix}`,
    foreignStepId: `p3-task-graph-foreign-step-${suffix}`,
    foreignItemId: `p3-task-graph-foreign-item-${suffix}`,
    foreignEventId: `p3-task-graph-foreign-event-${suffix}`,
    foreignOutboxId: `p3-task-graph-foreign-outbox-${suffix}`,
    foreignInputId: `p3-task-graph-foreign-input-${suffix}`,
    sessionId: `p3-task-graph-session-${suffix}`,
    turnId: `p3-task-graph-turn-${suffix}`,
    rootTaskId: `p3-task-graph-root-${suffix}`,
    stepId: `p3-task-graph-step-${suffix}`,
    originStepId: `p3-task-graph-origin-step-${suffix}`,
    keepStepId: `p3-task-graph-keep-step-${suffix}`,
    laterStepId: `p3-task-graph-later-step-${suffix}`,
    originalInputId: `p3-task-graph-original-input-${suffix}`,
    originalClientMessageId: `p3-task-graph-original-client-${suffix}`,
    firstSteerInputId: `p3-task-graph-first-steer-${suffix}`,
    firstSteerClientMessageId: `p3-task-graph-first-steer-client-${suffix}`,
    secondSteerInputId: `p3-task-graph-second-steer-${suffix}`,
    secondSteerClientMessageId: `p3-task-graph-second-steer-client-${suffix}`,
    planCallId: `p3-task-graph-plan-call-${suffix}`,
    keepCallId: `p3-task-graph-keep-call-${suffix}`,
    turnLeaseOwner: `p3-turn-owner-${suffix}`,
    parentLeaseOwner: `p3-parent-owner-${suffix}`,
  }
}

function scheduleInput(value: Fixture): TaskGraphScheduleInput {
  return {
    scope: {
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
      rootTaskId: value.rootTaskId, parentTaskId: value.rootTaskId, stepId: value.stepId,
      turnLeaseOwner: value.turnLeaseOwner, turnLeaseVersion: 1,
      parentLeaseOwner: value.parentLeaseOwner, parentAttemptCount: 1,
    },
    proposal: {
      expectedRevision: 0,
      nodes: Array.from({ length: 8 }, (_, index) => ({
        key: `task-${index + 1}`,
        templateId: "analyst",
        goal: `Complete graph task ${index + 1}`,
        successCriteria: [`Task ${index + 1} completed`],
        verification: ANALYST_VERIFICATION,
        dependsOn: index === 0 ? [] : [`task-${index}`],
      })),
    },
    templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
  }
}

async function seed(pool: PgPool, value: Fixture): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES
    ($1, $2, CURRENT_TIMESTAMP), ($3, $4, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`, value.foreignUserId, `${value.foreignUserId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'P3 TaskGraph command-port integration test', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.sessionId, value.userId,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Foreign tenant visibility probe', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.foreignSessionId, value.foreignUserId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [
    value.turnId, value.sessionId, value.userId, value.turnLeaseOwner,
  ])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
     "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'P3 TaskGraph command-port integration test',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [
    value.rootTaskId, value.sessionId, value.turnId, value.parentLeaseOwner,
  ])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [value.rootTaskId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [value.rootTaskId, value.turnId])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [
      value.stepId, value.sessionId, value.turnId, value.rootTaskId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [
    value.foreignTurnId, value.foreignSessionId, value.foreignUserId, `foreign-${value.turnLeaseOwner}`,
  ])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
     "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Foreign tenant visibility probe',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":4,"maxDepth":4,"maxFanOut":4,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [
    value.foreignRootTaskId, value.foreignSessionId, value.foreignTurnId, `foreign-${value.parentLeaseOwner}`,
  ])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [value.foreignRootTaskId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [value.foreignRootTaskId, value.foreignTurnId])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [
    value.foreignStepId, value.foreignSessionId, value.foreignTurnId, value.foreignRootTaskId,
  ])
  await pool.query(`INSERT INTO "agent_items"
    ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'task_graph', 'started', '{}'::jsonb, CURRENT_TIMESTAMP)`, [
    value.foreignItemId, value.foreignSessionId, value.foreignTurnId, value.foreignStepId, value.foreignRootTaskId,
  ])
  await pool.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "payload")
    VALUES ($1, $2, $3, $4, $5, 1, 'task_graph.fixture', 'system', $6, '{}'::jsonb)`, [
    value.foreignEventId, value.foreignSessionId, value.foreignTurnId, value.foreignItemId,
    value.foreignRootTaskId, value.foreignTurnId,
  ])
  await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'task_graph.fixture', $2, $3, '{}'::jsonb)`, [
    value.foreignOutboxId, value.foreignSessionId, value.foreignOutboxId,
  ])
  await pool.query(`INSERT INTO "agent_inputs" ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
    VALUES ($1, $2, $3, $4, $5, 'steer', 'accepted', '[]'::jsonb, 1)`, [
    value.foreignInputId, value.foreignSessionId, value.foreignTurnId, value.foreignUserId, `${value.foreignInputId}-client`,
  ])
}

async function graphRows(pool: PgPool, value: Fixture): Promise<Record<string, unknown>> {
  const [children, item, events, outbox] = await Promise.all([
    pool.query(`SELECT "id", "status" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`, [value.sessionId, value.rootTaskId]),
    pool.query(`SELECT "id", "revision" FROM "agent_items" WHERE "sessionId" = $1 AND "taskId" = $2 AND "type" = 'task_graph'`, [value.sessionId, value.rootTaskId]),
    pool.query(`SELECT "id", "idempotencyKey" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [value.sessionId, taskGraphProposalKey(value.rootTaskId, 0)]),
    pool.query(`SELECT "topic", "idempotencyKey" FROM "agent_outbox" WHERE "aggregateId" = $1 ORDER BY "idempotencyKey"`, [value.sessionId]),
  ])
  return { children: children.rows, item: item.rows, events: events.rows, outbox: outbox.rows }
}

function readScope(value: Fixture): TaskGraphReadScope {
  return {
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    rootTaskId: value.rootTaskId, parentTaskId: value.rootTaskId,
    turnLeaseOwner: value.turnLeaseOwner, turnLeaseVersion: 1,
    parentLeaseOwner: value.parentLeaseOwner, parentAttemptCount: 1,
  }
}

async function nextEventSequence(pool: PgPool, value: Fixture): Promise<bigint> {
  const result = await pool.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 RETURNING "eventSequence"`, [value.sessionId])
  const sequence = result.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("TaskGraph reconciliation fixture could not allocate an event sequence")
  return BigInt(sequence)
}

async function insertReconciliationEvent(pool: PgPool, value: Fixture, event: {
  readonly id: string; readonly sequence: bigint; readonly type: string; readonly actor: string
  readonly itemId: string | null; readonly taskId: string | null; readonly correlationId: string
  readonly idempotencyKey: string; readonly payload: unknown; readonly causationId?: string | null
}): Promise<void> {
  await pool.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`, [
    event.id, value.sessionId, value.turnId, event.itemId, event.taskId, event.sequence.toString(), event.type, event.actor,
    event.correlationId, event.causationId ?? null, event.idempotencyKey, JSON.stringify(event.payload),
  ])
}

async function seedReconciliationStep(pool: PgPool, value: Fixture, step: {
  readonly id: string; readonly ordinal: number; readonly status: "streaming" | "completed"
  readonly cursor: bigint; readonly consumedInputIds: readonly string[]
}): Promise<void> {
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::jsonb, '{}'::jsonb)`, [
    step.id, value.sessionId, value.turnId, value.rootTaskId, step.ordinal, step.status, step.cursor.toString(), JSON.stringify(step.consumedInputIds),
  ])
}

async function seedReconciliationInput(pool: PgPool, value: Fixture, input: {
  readonly id: string; readonly clientMessageId: string; readonly delivery: "follow_up" | "steer"
  readonly sequence: bigint; readonly consumedByStepId: string; readonly text: string; readonly disposition: string
}): Promise<void> {
  const content = { parts: [{ type: "text", text: input.text }], clientMessageId: input.clientMessageId, source: "user", disposition: input.disposition }
  const itemId = `${input.id}-message`
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, 'user_message', 'completed', $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    itemId, value.sessionId, value.turnId, JSON.stringify(content),
  ])
  await pool.query(`INSERT INTO "agent_inputs"
    ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence", "consumedByStepId", "consumedAt")
    VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7::jsonb, $8, $9, CURRENT_TIMESTAMP)`, [
    input.id, value.sessionId, value.turnId, value.userId, input.clientMessageId, input.delivery,
    JSON.stringify([{ type: "text", text: input.text }]), input.sequence.toString(), input.consumedByStepId,
  ])
  await insertReconciliationEvent(pool, value, {
    id: `${input.id}-accepted`, sequence: input.sequence, type: "input.accepted", actor: "user", itemId, taskId: null,
    correlationId: value.turnId, idempotencyKey: `input.accepted:${input.clientMessageId}`,
    payload: { inputId: input.id, clientMessageId: input.clientMessageId, delivery: input.delivery, source: "user", disposition: input.disposition },
  })
}

async function seedAcceptedReconciliationSteer(pool: PgPool, value: Fixture, input: {
  readonly id: string; readonly clientMessageId: string; readonly sequence: bigint; readonly text: string
}): Promise<void> {
  const disposition = "steered", itemId = `${input.id}-message`
  const content = { parts: [{ type: "text", text: input.text }], clientMessageId: input.clientMessageId, source: "user", disposition }
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, 'user_message', 'completed', $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    itemId, value.sessionId, value.turnId, JSON.stringify(content),
  ])
  await pool.query(`INSERT INTO "agent_inputs" ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
    VALUES ($1, $2, $3, $4, $5, 'steer', 'accepted', $6::jsonb, $7)`, [
    input.id, value.sessionId, value.turnId, value.userId, input.clientMessageId,
    JSON.stringify([{ type: "text", text: input.text }]), input.sequence.toString(),
  ])
  await insertReconciliationEvent(pool, value, {
    id: `${input.id}-accepted`, sequence: input.sequence, type: "input.accepted", actor: "user", itemId, taskId: null,
    correlationId: value.turnId, idempotencyKey: `input.accepted:${input.clientMessageId}`,
    payload: { inputId: input.id, clientMessageId: input.clientMessageId, delivery: "steer", source: "user", disposition },
  })
}

async function seedReconciliationAgenda(pool: PgPool, value: Fixture, step: {
  readonly id: string; readonly sequence: bigint; readonly cursor: bigint; readonly planRevision: number
  readonly consumedInputIds: readonly string[]
}): Promise<void> {
  const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: value.sessionId, turnId: value.turnId,
    stepId: step.id, inputThroughSequence: step.cursor, consumedInputIds: step.consumedInputIds, blocks: [], canonicalJson: "{}",
    taskGraphRevision: step.planRevision }
  const receipt = buildCognitiveAgendaReceipt({ sessionId: value.sessionId, turnId: value.turnId, taskId: value.rootTaskId,
    stepId: step.id, inputThroughSequence: step.cursor, consumedInputIds: step.consumedInputIds,
    agenda: buildCognitiveActionAgenda(context) })
  if (!receipt) throw new Error("TaskGraph reconciliation fixture agenda was invalid")
  await insertReconciliationEvent(pool, value, {
    id: `${step.id}-agenda`, sequence: step.sequence, type: COGNITIVE_AGENDA_EVENT_TYPE, actor: "orchestrator",
    itemId: null, taskId: value.rootTaskId, correlationId: step.id, idempotencyKey: `cognitive.agenda:${step.id}`, payload: receipt,
  })
}

async function seedReconciliationToolCall(pool: PgPool, value: Fixture, call: {
  readonly id: string; readonly stepId: string; readonly toolName: "agent.plan" | "agent.reconcile"
  readonly input: unknown; readonly sequence: bigint
}): Promise<void> {
  const itemId = `${call.id}-item`
  const content = { toolCallId: call.id, toolName: call.toolName, toolVersion: "1", input: call.input }
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    itemId, value.sessionId, value.turnId, call.stepId, value.rootTaskId, JSON.stringify(content),
  ])
  await insertReconciliationEvent(pool, value, {
    id: `${call.id}-started`, sequence: call.sequence, type: "tool_call.started", actor: "orchestrator", itemId,
    taskId: value.rootTaskId, correlationId: call.id, idempotencyKey: `turn:${value.turnId}:event:tool-started:${call.id}`,
    // Root Turn lifecycle receipts intentionally omit toolVersion from this event; it remains on the item.
    payload: { toolCallId: call.id, toolName: call.toolName, taskId: value.rootTaskId },
  })
}

const TENANT_TABLES = ["agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events", "agent_outbox", "agent_inputs"] as const
const TENANT_POLICIES: ReadonlyArray<readonly [string, string, string]> = [
  ["agent_sessions", "session", `"userId" = public.app_current_user_id()`],
  ["agent_turns", "turn", `"userId" = public.app_current_user_id() AND EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["sub_agent_tasks", "task", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_steps", "step", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_items", "item", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_events", "event", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_outbox", "outbox", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "aggregateId" AND session."userId" = public.app_current_user_id())`],
  ["agent_inputs", "input", `"userId" = public.app_current_user_id() AND EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
]

type SetupState = {
  readonly originalRls: Map<string, boolean>
  readonly policies: Array<{ table: string; name: string; existedBefore: boolean }>
  shouldDropUserIdFunction: boolean
  shouldDropRole: boolean
}

async function installTaskGraphTenantRls(pool: PgPool, policyPrefix: string, setup: SetupState): Promise<void> {
  const prior = await pool.query<{ tableName: string; enabled: boolean }>(`SELECT relation.relname AS "tableName", relation.relrowsecurity AS enabled
    FROM pg_class AS relation WHERE relation.oid = ANY(ARRAY[
      'public."agent_sessions"'::regclass, 'public."agent_turns"'::regclass, 'public."sub_agent_tasks"'::regclass,
      'public."agent_steps"'::regclass, 'public."agent_items"'::regclass, 'public."agent_events"'::regclass,
      'public."agent_outbox"'::regclass, 'public."agent_inputs"'::regclass
    ])`)
  for (const table of TENANT_TABLES) {
    const row = prior.rows.find(candidate => candidate.tableName === table)
    if (!row) throw new Error(`TaskGraph RLS setup could not observe prior state for ${table}`)
    setup.originalRls.set(table, row.enabled)
  }
  const currentUserFunction = await pool.query<{ exists: boolean }>(`SELECT to_regprocedure('public.app_current_user_id()') IS NOT NULL AS exists`)
  const functionExists = currentUserFunction.rows[0]?.exists
  if (functionExists === undefined) throw new Error("TaskGraph RLS setup could not observe app_current_user_id()")
  setup.shouldDropUserIdFunction = !functionExists
  if (setup.shouldDropUserIdFunction) {
    await pool.query(`CREATE FUNCTION public.app_current_user_id() RETURNS text LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$`)
  }
  for (const table of TENANT_TABLES) await pool.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`)

  for (const [table, suffix, predicate] of TENANT_POLICIES) {
    const name = `${policyPrefix}_${suffix}`
    const existingPolicy = await pool.query<{ exists: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_policy WHERE polrelid = to_regclass($1) AND polname = $2
    ) AS exists`, [`public."${table}"`, name])
    const existedBefore = existingPolicy.rows[0]?.exists
    if (existedBefore === undefined) throw new Error(`TaskGraph RLS setup could not observe policy ${name}`)
    setup.policies.push({ table, name, existedBefore })
    await pool.query(`CREATE POLICY "${name}" ON public."${table}" USING (${predicate}) WITH CHECK (${predicate})`)
  }
}

function restrictedTransactionPool(basePool: PgPool, roleName: string, userId: string, failOutboxForSession?: string): PgSubagentPool {
  return {
    async connect() {
      const client = await basePool.connect()
      const transactionScopedClient = new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return (...args: unknown[]) => {
              const query = args[0]
              const sql = typeof query === "string" ? query.trim().toUpperCase() : ""
              const result: unknown = Reflect.apply(target.query, target, args)
              return Promise.resolve(result).then(async value => {
                if (sql === "BEGIN") {
                  await Reflect.apply(target.query, target, [`SET LOCAL ROLE "${roleName}"`])
                  await Reflect.apply(target.query, target, ["SELECT set_config('app.user_id', $1, true)", [userId]])
                  if (failOutboxForSession) {
                    await Reflect.apply(target.query, target, [
                      "SELECT set_config('applymate.task_graph_fail_session', $1, true)", [failOutboxForSession],
                    ])
                  }
                }
                return value
              })
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      return transactionScopedClient
    },
  }
}

describeWithPostgres("PostgreSQL TaskGraph command port (P3 acceptance slice)", () => {
  const owner = fixture()
  const additionalFixtures: Fixture[] = []
  const roleName = `applymate_task_graph_${randomUUID().replaceAll("-", "")}`
  const policyPrefix = `tg_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  let adminPool: PgPool | undefined
  let commandPool: PgPool | undefined
  const setup: SetupState = {
    originalRls: new Map<string, boolean>(),
    policies: [],
    shouldDropUserIdFunction: false,
    shouldDropRole: false,
  }

  beforeAll(async () => {
    adminPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    const roleState = await adminPool.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`, [roleName])
    const roleExisted = roleState.rows[0]?.exists
    if (roleExisted === undefined) throw new Error("TaskGraph RLS setup could not observe the test role")
    setup.shouldDropRole = !roleExisted
    await adminPool.query(`CREATE ROLE "${roleName}" NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
    await adminPool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
    await installTaskGraphTenantRls(adminPool, policyPrefix, setup)
    await adminPool.query(`GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO "${roleName}"`)
    await adminPool.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events", "agent_outbox", "agent_inputs" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("id") ON "agent_turns" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("id") ON "agent_steps" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("eventSequence") ON "agent_sessions" TO "${roleName}"`)
    await adminPool.query(`GRANT INSERT ON "sub_agent_tasks" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("status", "updatedAt") ON "sub_agent_tasks" TO "${roleName}"`)
    await adminPool.query(`GRANT INSERT ON "agent_items" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("stepId", "revision", "content", "status", "completedAt", "updatedAt") ON "agent_items" TO "${roleName}"`)
    await adminPool.query(`GRANT INSERT ON "agent_events", "agent_outbox" TO "${roleName}"`)
    await seed(adminPool, owner)
    commandPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
  })

  afterAll(async () => {
    const failures: Error[] = []
    const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
      try {
        await action()
      } catch (cause) {
        failures.push(new Error(`TaskGraph integration cleanup failed to ${label}: ${String(cause)}`))
      }
    }

    if (commandPool) await attempt("close command pool", () => commandPool!.end())
    if (adminPool) {
      const fixtures = [owner, ...additionalFixtures]
      const sessionIds = fixtures.flatMap(value => [value.sessionId, value.foreignSessionId])
      const userIds = fixtures.flatMap(value => [value.userId, value.foreignUserId])
      await attempt("delete fixture outbox rows", () => adminPool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [sessionIds]))
      await attempt("delete fixture users and cascaded rows", () => adminPool!.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [userIds]))
      for (const policy of setup.policies) {
        if (!policy.existedBefore) {
          await attempt(`drop policy ${policy.name}`, () => adminPool!.query(`DROP POLICY IF EXISTS "${policy.name}" ON public."${policy.table}"`))
        }
      }
      for (const table of TENANT_TABLES) {
        const previouslyEnabled = setup.originalRls.get(table)
        if (previouslyEnabled !== undefined) {
          const action = previouslyEnabled ? "ENABLE" : "DISABLE"
          await attempt(`restore RLS state for ${table}`, () => adminPool!.query(`ALTER TABLE public."${table}" ${action} ROW LEVEL SECURITY`))
        }
      }
      if (setup.shouldDropRole) {
        let roleExists = false
        await attempt("check for test role", async () => {
          const result = await adminPool!.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`, [roleName])
          roleExists = result.rows[0]?.exists === true
        })
        if (roleExists) await attempt("drop test role privileges", () => adminPool!.query(`DROP OWNED BY "${roleName}"`))
        await attempt("drop test role", () => adminPool!.query(`DROP ROLE IF EXISTS "${roleName}"`))
      }
      if (setup.shouldDropUserIdFunction) {
        await attempt("drop test helper function", () => adminPool!.query(`DROP FUNCTION IF EXISTS public.app_current_user_id()`))
      }
      await attempt("close admin pool", () => adminPool!.end())
    }
    if (failures.length > 0) throw new AggregateError(failures, "TaskGraph PostgreSQL integration cleanup was incomplete")
  })

  it("persists and freshly reads an 8-node depth-8 graph, replays once, and fences foreign scope", async () => {
    const input = scheduleInput(owner)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, owner.userId))
    const emptyRows = await graphRows(adminPool!, owner)

    const roleProbe = await commandPool!.connect()
    try {
      await roleProbe.query("BEGIN")
      await roleProbe.query(`SET LOCAL ROLE "${roleName}"`)
      await roleProbe.query("SELECT set_config('app.user_id', $1, true)", [owner.userId])
      const roleState = await roleProbe.query<{ tenantScope: string; roleName: string; isSuperuser: boolean; bypassesRls: boolean; tableName: string; ownsTable: boolean; tableRlsEnabled: boolean; rowSecurityActive: boolean }>(`SELECT current_setting('app.user_id', true) AS "tenantScope", role.rolname AS "roleName", role.rolsuper AS "isSuperuser", role.rolbypassrls AS "bypassesRls",
          relation.relname AS "tableName", pg_get_userbyid(relation.relowner) = current_user AS "ownsTable",
          relation.relrowsecurity AS "tableRlsEnabled", row_security_active(relation.oid) AS "rowSecurityActive"
        FROM pg_roles AS role CROSS JOIN pg_class AS relation
        WHERE role.rolname = current_user AND relation.oid = ANY(ARRAY[
          'public."agent_sessions"'::regclass, 'public."agent_turns"'::regclass, 'public."sub_agent_tasks"'::regclass,
          'public."agent_steps"'::regclass, 'public."agent_items"'::regclass, 'public."agent_events"'::regclass,
          'public."agent_outbox"'::regclass, 'public."agent_inputs"'::regclass
        ]) ORDER BY relation.relname`)
      expect(roleState.rows).toEqual([...TENANT_TABLES].sort().map(tableName => ({
        tenantScope: owner.userId, roleName, isSuperuser: false, bypassesRls: false, tableName, ownsTable: false,
        tableRlsEnabled: true, rowSecurityActive: true,
      })))
      const turnLockPrivileges = await roleProbe.query<{ canLockTurn: boolean; canRewriteLease: boolean }>(`SELECT
          has_column_privilege(current_user, 'public."agent_turns"', 'id', 'UPDATE') AS "canLockTurn",
          has_column_privilege(current_user, 'public."agent_turns"', 'leaseOwnerId', 'UPDATE') AS "canRewriteLease"`)
      expect(turnLockPrivileges.rows).toEqual([{ canLockTurn: true, canRewriteLease: false }])
      const stepLockPrivileges = await roleProbe.query<{
        canLockStep: boolean
        canRewriteStepStatus: boolean
        canRewriteStepSnapshot: boolean
      }>(`SELECT
          has_column_privilege(current_user, 'public."agent_steps"', 'id', 'UPDATE') AS "canLockStep",
          has_column_privilege(current_user, 'public."agent_steps"', 'status', 'UPDATE') AS "canRewriteStepStatus",
          has_column_privilege(current_user, 'public."agent_steps"', 'modelProfileSnapshot', 'UPDATE') AS "canRewriteStepSnapshot"`)
      expect(stepLockPrivileges.rows).toEqual([{
        canLockStep: true, canRewriteStepStatus: false, canRewriteStepSnapshot: false,
      }])
      const foreignRows: ReadonlyArray<{ table: typeof TENANT_TABLES[number]; id: string }> = [
        { table: "agent_sessions", id: owner.foreignSessionId },
        { table: "agent_turns", id: owner.foreignTurnId },
        { table: "sub_agent_tasks", id: owner.foreignRootTaskId },
        { table: "agent_steps", id: owner.foreignStepId },
        { table: "agent_items", id: owner.foreignItemId },
        { table: "agent_events", id: owner.foreignEventId },
        { table: "agent_outbox", id: owner.foreignOutboxId },
        { table: "agent_inputs", id: owner.foreignInputId },
      ]
      for (const { table, id } of foreignRows) {
        const seeded = await adminPool!.query(`SELECT "id" FROM public."${table}" WHERE "id" = $1`, [id])
        expect(seeded.rows, `${table} foreign fixture is present`).toEqual([{ id }])
        const hidden = await roleProbe.query(`SELECT "id" FROM public."${table}" WHERE "id" = $1`, [id])
        expect(hidden.rows, `${table} foreign fixture is hidden from the owner scope`).toEqual([])
      }
    } finally {
      await roleProbe.query("ROLLBACK")
      roleProbe.release()
    }

    const foreignUser = { ...input, scope: { ...input.scope, userId: owner.foreignUserId } }
    await expect(command.appendAndSchedule(foreignUser)).rejects.toThrow("task_graph_session_fenced")
    const wrongSession = { ...input, scope: { ...input.scope, sessionId: owner.foreignSessionId } }
    await expect(command.appendAndSchedule(wrongSession)).rejects.toThrow("task_graph_session_fenced")
    const wrongTurn = { ...input, scope: { ...input.scope, turnId: `foreign-${owner.turnId}` } }
    await expect(command.appendAndSchedule(wrongTurn)).rejects.toThrow("task_graph_turn_fenced")
    const wrongRoot = {
      ...input,
      scope: { ...input.scope, rootTaskId: `foreign-${owner.rootTaskId}`, parentTaskId: `foreign-${owner.rootTaskId}` },
    }
    await expect(command.appendAndSchedule(wrongRoot)).rejects.toThrow("task_graph_turn_fenced")
    const staleTurnLease = { ...input, scope: { ...input.scope, turnLeaseOwner: "stale-turn-owner" } }
    await expect(command.appendAndSchedule(staleTurnLease)).rejects.toThrow("task_graph_turn_fenced")
    const staleTurnVersion = { ...input, scope: { ...input.scope, turnLeaseVersion: 2 } }
    await expect(command.appendAndSchedule(staleTurnVersion)).rejects.toThrow("task_graph_turn_fenced")
    await adminPool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`, [owner.turnId])
    try {
      await expect(command.appendAndSchedule(input)).rejects.toThrow("task_graph_turn_fenced")
    } finally {
      await adminPool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "id" = $1`, [owner.turnId])
    }
    const staleParentLease = { ...input, scope: { ...input.scope, parentLeaseOwner: "stale-parent-owner" } }
    await expect(command.appendAndSchedule(staleParentLease)).rejects.toThrow("task_graph_parent_fenced")
    const staleParentAttempt = { ...input, scope: { ...input.scope, parentAttemptCount: 2 } }
    await expect(command.appendAndSchedule(staleParentAttempt)).rejects.toThrow("task_graph_parent_fenced")
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`, [owner.rootTaskId])
    try {
      await expect(command.appendAndSchedule(input)).rejects.toThrow("task_graph_parent_fenced")
    } finally {
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "id" = $1`, [owner.rootTaskId])
    }
    expect(await graphRows(adminPool!, owner)).toEqual(emptyRows)

    const accepted = await command.appendAndSchedule(input)
    expect(accepted).toMatchObject({
      status: "accepted", revision: 1,
      nodes: [{ key: "task-1", status: "queued" }, ...Array.from({ length: 7 }, (_, index) => ({ key: `task-${index + 2}`, status: "waiting" }))],
    })
    expect(Buffer.byteLength(JSON.stringify(input.proposal), "utf8")).toBeLessThanOrEqual(TASK_GRAPH_LIMITS.maxProposalBytes)
    expect(accepted.nodes).toHaveLength(8)
    expect(accepted.readyTaskIds).toEqual([accepted.nodes[0]!.taskId])
    expect(accepted.nodes[7]!.taskId).not.toBe(accepted.nodes[0]!.taskId)

    const childRows = await adminPool!.query<{ goal: string; status: string }>(
      `SELECT "goal", "status" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "goal"`,
      [owner.sessionId, owner.rootTaskId],
    )
    expect(childRows.rows).toEqual(Array.from({ length: 8 }, (_, index) => ({
      goal: `Complete graph task ${index + 1}`,
      status: index === 0 ? "queued" : "waiting",
    })))
    const dispatchRows = await adminPool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1`,
      [owner.sessionId],
    )
    expect(dispatchRows.rows).toHaveLength(1)
    expect(dispatchRows.rows[0]!.payload).toMatchObject({ taskId: accepted.readyTaskIds[0], sessionId: owner.sessionId, rootTaskId: owner.rootTaskId })

    const beforeReplay = await graphRows(adminPool!, owner)
    await commandPool!.end()
    commandPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const reopened = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, owner.userId))
    const freshlyRead = await reopened.readCurrent(readScope(owner))
    expect(freshlyRead.revision).toBe(1)
    expect(freshlyRead.nodes).toHaveLength(8)
    expect(freshlyRead.nodes[0]).toMatchObject({ key: "task-1", taskId: accepted.nodes[0]!.taskId, status: "queued", readiness: "ready" })
    expect(freshlyRead.nodes[7]).toMatchObject({ key: "task-8", taskId: accepted.nodes[7]!.taskId, dependsOn: ["task-7"], status: "waiting", readiness: "waiting_for_dependencies" })
    const snapshotRow = await adminPool!.query<{ content: unknown }>(
      `SELECT "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "type" = 'task_graph'`,
      [taskGraphItemId(owner.rootTaskId), owner.sessionId],
    )
    const persistedSnapshot = snapshotRow.rows[0]?.content as { nodes?: Array<{ depth: number }> } | undefined
    expect(persistedSnapshot?.nodes?.map(node => node.depth)).toEqual(Array.from({ length: 8 }, (_, index) => index + 1))
    expect(Buffer.byteLength(canonicalTaskGraphJson(persistedSnapshot), "utf8")).toBeLessThanOrEqual(TASK_GRAPH_LIMITS.maxSnapshotBytes)

    const duplicate = await reopened.appendAndSchedule(input)
    expect(duplicate).toEqual({ ...accepted, status: "duplicate" })
    expect(await graphRows(adminPool!, owner)).toEqual(beforeReplay)
    const planEvents = await adminPool!.query(
      `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
      [owner.sessionId, taskGraphProposalKey(owner.rootTaskId, 0)],
    )
    expect(planEvents.rows).toHaveLength(1)
    expect(beforeReplay.item).toEqual([{ id: taskGraphItemId(owner.rootTaskId), revision: 1 }])
  }, 60_000)

  it("replays a no-steer revise before ledger preparation and leaves later accepted steer unresolved", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = '["agent.plan"]'::jsonb WHERE "id" = $1`, [value.rootTaskId])
    await adminPool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [value.turnId, JSON.stringify({
      input: { goal: "Find roles", clientMessageId: value.originalClientMessageId },
    })])

    await seedReconciliationStep(adminPool!, value, {
      id: value.originStepId, ordinal: 0, status: "completed", cursor: 1n, consumedInputIds: [value.originalInputId],
    })
    const originalSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationInput(adminPool!, value, {
      id: value.originalInputId, clientMessageId: value.originalClientMessageId, delivery: "follow_up",
      sequence: originalSequence, consumedByStepId: value.originStepId, text: "Complete original user task reference", disposition: "submitted",
    })
    await adminPool!.query(`UPDATE "agent_steps" SET "inputThroughSequence" = $2, "consumedInputIds" = $3::jsonb WHERE "id" = $1`, [
      value.stepId, originalSequence.toString(), JSON.stringify([value.originalInputId]),
    ])
    const agendaSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.stepId, sequence: agendaSequence, cursor: originalSequence, planRevision: 0, consumedInputIds: [value.originalInputId],
    })
    const callSequence = await nextEventSequence(adminPool!, value)
    const input = scheduleInput(value)
    const operation = { scope: input.scope, decision: "revise" as const, expectedRevision: 0, callId: value.planCallId, rootInputId: value.originalInputId }
    await seedReconciliationToolCall(adminPool!, value, {
      id: value.planCallId, stepId: value.stepId, toolName: "agent.plan", input: input.proposal, sequence: callSequence,
    })

    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const accepted = await command.appendAndScheduleWithReconciliation!(input, operation)
    expect(accepted).toMatchObject({ status: "accepted", revision: 1 })
    const graphAfterCommit = await graphRows(adminPool!, value)
    expect((await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [
      value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])).rows).toEqual([])

    const laterSequence = await nextEventSequence(adminPool!, value)
    await seedAcceptedReconciliationSteer(adminPool!, value, {
      id: value.secondSteerInputId, clientMessageId: value.secondSteerClientMessageId,
      sequence: laterSequence, text: "Keep the newly accepted requirement pending",
    })
    await expect(command.appendAndScheduleWithReconciliation!(input, operation)).resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await graphRows(adminPool!, value)).toEqual(graphAfterCommit)
    expect((await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [
      value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])).rows).toEqual([])
    expect((await adminPool!.query(`SELECT "status", "consumedByStepId" FROM "agent_inputs" WHERE "id" = $1`, [value.secondSteerInputId])).rows)
      .toEqual([{ status: "accepted", consumedByStepId: null }])
    await expect(transaction(restrictedTransactionPool(commandPool!, roleName, value.userId), client =>
      assertNoUnresolvedSteering(client, readScope(value)))).rejects.toThrow("steering_reconciliation_pending")
  }, 60_000)

  it("commits planner revise and keep receipts atomically, replaying only before a later Step consumes fresh steer", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = '["agent.plan"]'::jsonb WHERE "id" = $1`, [value.rootTaskId])
    await adminPool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [value.turnId, JSON.stringify({
      input: { goal: "Find roles", clientMessageId: value.originalClientMessageId },
    })])

    await seedReconciliationStep(adminPool!, value, {
      id: value.originStepId, ordinal: 0, status: "completed", cursor: 1n, consumedInputIds: [value.originalInputId],
    })
    const originalSequence = await nextEventSequence(adminPool!, value)
    expect(originalSequence).toBe(1n)
    await seedReconciliationInput(adminPool!, value, {
      id: value.originalInputId, clientMessageId: value.originalClientMessageId, delivery: "follow_up",
      sequence: originalSequence, consumedByStepId: value.originStepId, text: "Complete original user task reference", disposition: "submitted",
    })
    const firstSteerSequence = await nextEventSequence(adminPool!, value)
    await adminPool!.query(`UPDATE "agent_steps" SET "inputThroughSequence" = $2, "consumedInputIds" = $3::jsonb WHERE "id" = $1`, [
      value.stepId, firstSteerSequence.toString(), JSON.stringify([value.originalInputId, value.firstSteerInputId]),
    ])
    await seedReconciliationInput(adminPool!, value, {
      id: value.firstSteerInputId, clientMessageId: value.firstSteerClientMessageId, delivery: "steer",
      sequence: firstSteerSequence, consumedByStepId: value.stepId, text: "Please also compare remote roles", disposition: "steered",
    })
    const planAgendaSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.stepId, sequence: planAgendaSequence, cursor: firstSteerSequence, planRevision: 0,
      consumedInputIds: [value.originalInputId, value.firstSteerInputId],
    })
    const planCallSequence = await nextEventSequence(adminPool!, value)
    const input = scheduleInput(value)
    const planOperation = {
      scope: input.scope, decision: "revise" as const, expectedRevision: 0, callId: value.planCallId, rootInputId: value.originalInputId,
    }
    await seedReconciliationToolCall(adminPool!, value, {
      id: value.planCallId, stepId: value.stepId, toolName: "agent.plan", input: input.proposal, sequence: planCallSequence,
    })

    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const accepted = await command.appendAndScheduleWithReconciliation!(input, planOperation)
    expect(accepted).toMatchObject({ status: "accepted", revision: 1 })
    const firstReceipt = await adminPool!.query<{ id: string; payload: unknown }>(`SELECT "id", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "type" = $2 ORDER BY "sequence"`, [value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE])
    expect(firstReceipt.rows).toHaveLength(1)
    const receiptPayload = firstReceipt.rows[0]!.payload as { steerInputIds?: string[] }
    expect(receiptPayload.steerInputIds).toEqual([value.firstSteerInputId])
    expect(JSON.stringify(receiptPayload)).not.toContain("Please also compare remote roles")
    expect((await adminPool!.query(`SELECT "id" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [
      `agent-event:${firstReceipt.rows[0]!.id}`,
    ])).rows).toEqual([])
    const acceptedCounts = await graphRows(adminPool!, value)

    await commandPool!.end()
    commandPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const reopened = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, value.userId))
    await expect(reopened.appendAndScheduleWithReconciliation!(input, planOperation)).resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await graphRows(adminPool!, value)).toEqual(acceptedCounts)
    expect((await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [
      value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])).rows).toHaveLength(1)

    const secondSteerSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationStep(adminPool!, value, {
      id: value.keepStepId, ordinal: 2, status: "streaming", cursor: secondSteerSequence,
      consumedInputIds: [value.originalInputId, value.firstSteerInputId, value.secondSteerInputId],
    })
    await seedReconciliationInput(adminPool!, value, {
      id: value.secondSteerInputId, clientMessageId: value.secondSteerClientMessageId, delivery: "steer",
      sequence: secondSteerSequence, consumedByStepId: value.keepStepId, text: "Keep the plan and retain this requirement", disposition: "steered",
    })
    const keepAgendaSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.keepStepId, sequence: keepAgendaSequence, cursor: secondSteerSequence, planRevision: 1,
      consumedInputIds: [value.originalInputId, value.firstSteerInputId, value.secondSteerInputId],
    })
    const keepCallSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationToolCall(adminPool!, value, {
      id: value.keepCallId, stepId: value.keepStepId, toolName: "agent.reconcile",
      input: { decision: "keep", expectedRevision: 1 }, sequence: keepCallSequence,
    })

    await expect(reopened.appendAndScheduleWithReconciliation!(input, planOperation)).resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await graphRows(adminPool!, value)).toEqual(acceptedCounts)
    const receiptsAfterReplay = await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [
      value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])
    expect(receiptsAfterReplay.rows).toHaveLength(1)
    expect((await adminPool!.query(`SELECT "status", "consumedByStepId" FROM "agent_inputs" WHERE "id" = $1`, [value.secondSteerInputId])).rows)
      .toEqual([{ status: "consumed", consumedByStepId: value.keepStepId }])
    await expect(transaction(restrictedTransactionPool(commandPool!, roleName, value.userId), client =>
      assertNoUnresolvedSteering(client, readScope(value)))).rejects.toThrow("steering_reconciliation_pending")
    const rawRootPlan = { ...input, scope: { ...input.scope, stepId: value.keepStepId }, proposal: { ...input.proposal, expectedRevision: 1 } }
    await expect(reopened.appendAndSchedule(rawRootPlan)).rejects.toThrow("steering_reconciliation_pending")
    expect(await graphRows(adminPool!, value)).toEqual(acceptedCounts)
    const keep = await reopened.reconcileSteering!({
      scope: { ...input.scope, stepId: value.keepStepId }, decision: "keep", expectedRevision: 1,
      callId: value.keepCallId, rootInputId: value.originalInputId,
    })
    expect(keep).toEqual({ decision: "keep", revision: 1, reconciledInputCount: 1 })
    const receipts = await adminPool!.query<{ id: string; type: string; payload: unknown }>(`SELECT "id", "type", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "type" = $2 ORDER BY "sequence"`, [value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE])
    expect(receipts.rows).toHaveLength(2)
    expect((receipts.rows[1]!.payload as { steerInputIds?: string[] }).steerInputIds).toEqual([value.secondSteerInputId])
    expect((await adminPool!.query(`SELECT "id" FROM "agent_outbox" WHERE "idempotencyKey" = ANY($1::text[])`, [
      receipts.rows.map(row => `agent-event:${row.id}`),
    ])).rows).toEqual([])
    expect((await reopened.readCurrent(readScope(value))).revision).toBe(1)
  }, 60_000)

  it("recovers an expired TaskGraph child lease across fresh Worker stores without losing or duplicating receipts", async () => {
    const recoveryOwner = fixture()
    additionalFixtures.push(recoveryOwner)
    await seed(adminPool!, recoveryOwner)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = jsonb_set(
      "budgetSnapshot", '{subagentPolicy,maxAttempts}', '3'::jsonb
    ) WHERE "id" = $1`, [recoveryOwner.rootTaskId])

    const input = {
      ...scheduleInput(recoveryOwner),
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [], maxAttempts: 3 } },
    }
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, recoveryOwner.userId))
    const accepted = await command.appendAndSchedule(input)
    expect(accepted.status).toBe("accepted")
    const childTaskId = accepted.readyTaskIds[0]
    expect(childTaskId).toBeTruthy()
    const dispatchKey = `subagent-dispatch:${childTaskId}`
    const policy = { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 3 }
    const openStore = () => {
      const pool = new PgPool({ connectionString: databaseUrl!, max: 1 })
      return { pool, store: new PgSubagentTaskStore(pool) }
    }
    const activePools = new Set<PgPool>()
    const retirePool = async (pool: PgPool): Promise<void> => {
      await pool.end()
      activePools.delete(pool)
    }
    const markDispatchPublishedAndExpire = async (expectedAttemptCount: number): Promise<void> => {
      const published = await adminPool!.query<{ attemptCount: number }>(`UPDATE "agent_outbox"
        SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1,
            "lastError" = 'simulated dispatch delivery'
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2
          AND "publishedAt" IS NULL
        RETURNING "attemptCount"`, [recoveryOwner.sessionId, dispatchKey])
      expect(published.rows).toHaveLength(1)
      expect(Number(published.rows[0]!.attemptCount)).toBe(expectedAttemptCount)
      const expired = await adminPool!.query(`UPDATE "sub_agent_tasks"
        SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running'`, [childTaskId, recoveryOwner.sessionId])
      expect(expired.rowCount).toBe(1)
    }

    try {
      const first = openStore()
      activePools.add(first.pool)
      const firstLease = await first.store.claim({
        taskId: childTaskId!, sessionId: recoveryOwner.sessionId, ownerId: "worker-before-restart",
        policy, now: new Date(),
      })
      expect(firstLease).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: "worker-before-restart" })
      await markDispatchPublishedAndExpire(1)
      await retirePool(first.pool)

      const second = openStore()
      activePools.add(second.pool)
      const firstRecovery = await second.store.recoverExpired({ now: new Date(), limit: 10 })
      expect(firstRecovery).toMatchObject([{ id: childTaskId, status: "queued", attemptCount: 1, leaseOwner: null, leaseExpiresAt: null }])
      const firstPersisted = await second.store.get(childTaskId!, recoveryOwner.sessionId)
      expect(firstPersisted).toMatchObject({ status: "queued", attemptCount: 1, leaseOwner: null, leaseExpiresAt: null })
      const firstDispatch = await adminPool!.query<{ attemptCount: number; publishedAt: Date | null; lastError: string | null }>(
        `SELECT "attemptCount", "publishedAt", "lastError" FROM "agent_outbox"
          WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
        [recoveryOwner.sessionId, dispatchKey],
      )
      expect(firstDispatch.rows).toMatchObject([{ attemptCount: 2, publishedAt: null, lastError: null }])
      await retirePool(second.pool)

      expect(firstRecovery[0]?.nextAttemptAt).toBeInstanceOf(Date)
      const retryAt = firstRecovery[0]!.nextAttemptAt!.getTime()
      const retryDelay = Math.max(0, retryAt - Date.now())
      if (retryDelay > 0) await new Promise(resolve => setTimeout(resolve, retryDelay + 100))

      const third = openStore()
      activePools.add(third.pool)
      const secondLease = await third.store.claim({
        taskId: childTaskId!, sessionId: recoveryOwner.sessionId, ownerId: "worker-after-restart",
        policy, now: new Date(),
      })
      expect(secondLease).toMatchObject({ status: "running", attemptCount: 2, leaseOwner: "worker-after-restart" })
      await markDispatchPublishedAndExpire(3)
      await retirePool(third.pool)

      const fourth = openStore()
      activePools.add(fourth.pool)
      const secondRecovery = await fourth.store.recoverExpired({ now: new Date(), limit: 10 })
      expect(secondRecovery).toMatchObject([{ id: childTaskId, status: "queued", attemptCount: 2, leaseOwner: null, leaseExpiresAt: null }])
      const finalPersisted = await fourth.store.get(childTaskId!, recoveryOwner.sessionId)
      expect(finalPersisted).toMatchObject({ status: "queued", attemptCount: 2, leaseOwner: null, leaseExpiresAt: null })

      const graph = await command.readCurrent(readScope(recoveryOwner))
      expect(graph.revision).toBe(5)
      expect(graph.nodes[0]).toMatchObject({ key: "task-1", taskId: childTaskId, status: "queued", readiness: "ready" })

      const timeline = await adminPool!.query<{ type: string; idempotencyKey: string | null; payload: unknown }>(
        `SELECT "type", "idempotencyKey", "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "itemId" = $2 ORDER BY "sequence"`,
        [recoveryOwner.sessionId, taskGraphItemId(recoveryOwner.rootTaskId)],
      )
      const idempotencyKeys = timeline.rows.map(row => row.idempotencyKey)
      expect(timeline.rows).toHaveLength(5)
      expect(new Set(idempotencyKeys).size).toBe(5)
      expect(timeline.rows.map(row => {
        const payload = row.payload as { kind?: unknown; event?: { type?: unknown } }
        return payload.kind === "lifecycle" ? payload.event?.type : payload.kind
      })).toEqual(["proposal", "task.started", "task.retrying", "task.started", "task.retrying"])

      const item = await adminPool!.query<{ revision: number }>(
        `SELECT "revision" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "type" = 'task_graph'`,
        [taskGraphItemId(recoveryOwner.rootTaskId), recoveryOwner.sessionId],
      )
      expect(item.rows).toEqual([{ revision: 5 }])
      const dispatchRows = await adminPool!.query<{ idempotencyKey: string; attemptCount: number; publishedAt: Date | null; lastError: string | null }>(
        `SELECT "idempotencyKey", "attemptCount", "publishedAt", "lastError" FROM "agent_outbox"
          WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
        [recoveryOwner.sessionId, dispatchKey],
      )
      expect(dispatchRows.rows).toMatchObject([{ idempotencyKey: dispatchKey, attemptCount: 4, publishedAt: null, lastError: null }])
      const streamedEvents = await adminPool!.query<{ count: number; uniqueKeys: number }>(
        `SELECT COUNT(*)::int AS count, COUNT(DISTINCT "idempotencyKey")::int AS "uniqueKeys"
          FROM "agent_outbox" WHERE "topic" = 'agent.session.event' AND "aggregateId" = $1
            AND "payload"->>'itemId' = $2`,
        [recoveryOwner.sessionId, taskGraphItemId(recoveryOwner.rootTaskId)],
      )
      expect(streamedEvents.rows).toEqual([{ count: 5, uniqueKeys: 5 }])
    } finally {
      await Promise.all([...activePools].map(pool => pool.end()))
    }
  }, 60_000)

  it("rolls back every graph write when the final event-outbox insert fails", async () => {
    const rollbackOwner = fixture()
    additionalFixtures.push(rollbackOwner)
    await seed(adminPool!, rollbackOwner)
    const input = scheduleInput(rollbackOwner)
    const before = await graphRows(adminPool!, rollbackOwner)
    const sequenceBefore = await adminPool!.query<{ eventSequence: string }>(
      `SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [rollbackOwner.sessionId],
    )
    const triggerName = `tg_fail_${randomUUID().replaceAll("-", "")}`
    const functionName = `${triggerName}_fn`
    await adminPool!.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $task_graph_test$
      BEGIN
        IF NEW."topic" = 'agent.session.event'
          AND NEW."aggregateId" = current_setting('applymate.task_graph_fail_session', true) THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'injected task graph late-write failure';
        END IF;
        RETURN NEW;
      END
      $task_graph_test$`)
    await adminPool!.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."agent_outbox"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`)
    const failingPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    try {
      const command = createPgTaskGraphCommandPort(
        restrictedTransactionPool(failingPool, roleName, rollbackOwner.userId, rollbackOwner.sessionId),
      )
      await expect(command.appendAndSchedule(input)).rejects.toThrow("injected task graph late-write failure")
      expect(await graphRows(adminPool!, rollbackOwner)).toEqual(before)
      expect((await command.readCurrent(readScope(rollbackOwner))).revision).toBe(0)
      const sequenceAfter = await adminPool!.query<{ eventSequence: string }>(
        `SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [rollbackOwner.sessionId],
      )
      expect(sequenceAfter.rows).toEqual(sequenceBefore.rows)
    } finally {
      await failingPool.end()
      await adminPool!.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."agent_outbox"`)
      await adminPool!.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`)
    }
  }, 60_000)

  it("serializes concurrent same-revision replays and rejects conflicting content without duplicate writes", async () => {
    const concurrentOwner = fixture()
    additionalFixtures.push(concurrentOwner)
    await seed(adminPool!, concurrentOwner)
    const input = scheduleInput(concurrentOwner)
    const racingPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    try {
      const command = createPgTaskGraphCommandPort(restrictedTransactionPool(racingPool, roleName, concurrentOwner.userId))
      const [first, second] = await Promise.all([
        command.appendAndSchedule(input),
        command.appendAndSchedule(input),
      ])
      const accepted = [first, second].filter(receipt => receipt.status === "accepted")
      const duplicates = [first, second].filter(receipt => receipt.status === "duplicate")
      expect(accepted).toHaveLength(1)
      expect(duplicates).toHaveLength(1)
      expect({ ...duplicates[0], status: "accepted" }).toEqual(accepted[0])

      const committed = await graphRows(adminPool!, concurrentOwner)
      expect(committed.children).toHaveLength(input.proposal.nodes.length)
      expect(committed.item).toEqual([{ id: taskGraphItemId(concurrentOwner.rootTaskId), revision: 1 }])
      expect(committed.events).toHaveLength(1)
      expect(committed.outbox).toHaveLength(2)

      const conflicting = {
        ...input,
        proposal: {
          ...input.proposal,
          nodes: input.proposal.nodes.map((node, index) => index === 0 ? { ...node, goal: "Conflicting same-revision proposal" } : node),
        },
      }
      await expect(command.appendAndSchedule(conflicting)).rejects.toThrow("TaskGraph proposal key was already used")
      expect(await graphRows(adminPool!, concurrentOwner)).toEqual(committed)
    } finally {
      await racingPool.end()
    }
  }, 60_000)
})
