import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
import { executionKey } from "../turns/turn-execution-types.js"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import { writeTaskGraphSnapshot } from "./task-graph-pg-events.js"
import { parseTaskGraphSnapshot, taskGraphItemId, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { lockTaskGraphScope } from "./task-graph-pg-state.js"
import type { TaskGraphExecutionScope, TaskGraphNativeCommandInput } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"
import { createStoredAgentInputMapper, loadUnresolvedSteeringContext } from "../context/steering-reconciliation-context.js"
import { assertNoUnresolvedSteering, readSteeringReconciliationState } from "./steering-reconciliation-read.js"
import { prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import { steeringReconciliationIdempotencyKey } from "./steering-reconciliation-contract.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const EVENT_COLUMNS = '"id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"'
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Steering reconciliation needs the dedicated disposable PostgreSQL URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Steering reconciliation requires the dedicated loopback disposable URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), ids = {
  user: `steering-reconcile-user-${suffix}`, session: `steering-reconcile-session-${suffix}`,
  turn: `steering-reconcile-turn-${suffix}`, root: `steering-reconcile-root-${suffix}`,
  graphChild: `steering-reconcile-graph-child-${suffix}`,
  turnOwner: `steering-reconcile-turn-owner-${suffix}`, taskOwner: `steering-reconcile-task-owner-${suffix}`,
  originStep: `steering-reconcile-origin-${suffix}`, keepStep: `steering-reconcile-keep-${suffix}`,
  consumeStep: `steering-reconcile-consume-${suffix}`, currentStep: `steering-reconcile-current-${suffix}`,
  originalInput: `steering-reconcile-original-${suffix}`, firstSteer: `steering-reconcile-steer-1-${suffix}`,
  laterSteer: `steering-reconcile-steer-2-${suffix}`, questionItem: `steering-reconcile-question-${suffix}`,
  keepCall: `steering-reconcile-keep-call-${suffix}`, reviseCall: `steering-reconcile-revise-call-${suffix}`,
}
const runtimeRole = `steering_reconcile_runtime_${suffix.replaceAll("-", "")}`
const acceptanceApplicationName = `steer_accept_${suffix}`
const decisionApplicationName = `steer_decide_${suffix}`
const future = new Date(Date.now() + 10 * 60_000)
const executionIdentity = { kind: "turn" as const, userId: ids.user, sessionId: ids.session, turnId: ids.turn, taskId: ids.root,
  rootTaskId: ids.root, ownerId: ids.turnOwner, leaseVersion: 1, leaseExpiresAt: future }
const scope: TaskGraphExecutionScope = { userId: ids.user, sessionId: ids.session, turnId: ids.turn, rootTaskId: ids.root,
  parentTaskId: ids.root, stepId: ids.keepStep, turnLeaseOwner: ids.turnOwner, turnLeaseVersion: 1,
  parentLeaseOwner: ids.taskOwner, parentAttemptCount: 1 }
const hydrationScope = { userId: ids.user, sessionId: ids.session, turnId: ids.turn, rootTaskId: ids.root,
  parentTaskId: ids.root, turnLeaseOwner: ids.turnOwner, turnLeaseVersion: 1, parentLeaseOwner: ids.taskOwner, parentAttemptCount: 1 }
const context = (stepId: string, cursor: bigint, consumedInputIds: readonly string[]): StepContext => ({ schemaVersion: "agent-harness.v2",
  sessionId: ids.session, turnId: ids.turn, stepId, inputThroughSequence: cursor, consumedInputIds, canonicalJson: "{}", blocks: [] })
const baseGraph = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] })
const revisedGraph = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "continued-work", templateId: "analyst",
  goal: "Continue the user-requested research", successCriteria: ["Record findings"], dependsOn: [], depth: 1, taskId: ids.graphChild,
  verificationDisposition: "legacy_unverified" }] })
let adminPool: Pool | undefined
let runtimePool: Pool | undefined
let acceptancePool: Pool | undefined
let planPool: Pool | undefined
let runtimeRoleCreated = false

function agenda(stepId: string, cursor: bigint, planRevision: number) {
  const payload = buildCognitiveAgendaReceipt({ sessionId: ids.session, turnId: ids.turn, taskId: ids.root, stepId,
    agenda: { ...buildCognitiveActionAgenda(context(stepId, cursor, [])), planRevision }, inputThroughSequence: cursor, consumedInputIds: [] })
  if (!payload) throw new Error("steering reconciliation fixture agenda was invalid")
  return payload
}
async function insertEvent(input: { id: string; sequence: number; type: string; actor: string; itemId: string | null; taskId: string | null;
  correlationId: string; causationId?: string | null; idempotencyKey: string; payload: unknown }): Promise<void> {
  await adminPool!.query(`INSERT INTO "agent_events" (${EVENT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
  [input.id, ids.session, ids.turn, input.itemId, input.taskId, input.sequence, input.type, input.actor, input.correlationId,
    input.causationId ?? null, input.idempotencyKey, JSON.stringify(input.payload)])
}
async function insertMessage(id: string, clientMessageId: string, sequence: number, delivery: "steer" | "follow_up",
  consumedByStepId = id === ids.originalInput ? ids.originStep : sequence === 2 ? ids.keepStep : ids.consumeStep,
  parts: readonly { type: "text"; text: string }[] = [{ type: "text", text: `User steer ${id}` }]): Promise<void> {
  const content = { parts, clientMessageId, source: "user", disposition: "steered" }
  await adminPool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, NULL, 'user_message', 'completed', NULL, 0, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [`${id}-item`, ids.session, ids.turn, ids.originStep, JSON.stringify(content)])
  await adminPool!.query(`INSERT INTO "agent_inputs" ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence", "consumedByStepId", "consumedAt")
    VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7::jsonb, $8, $9, CURRENT_TIMESTAMP)`,
  [id, ids.session, ids.turn, ids.user, clientMessageId, delivery, JSON.stringify(parts), sequence,
    consumedByStepId])
  await insertEvent({ id: `${id}-accepted-event`, sequence, type: "input.accepted", actor: "user", itemId: `${id}-item`, taskId: null,
    correlationId: ids.turn, idempotencyKey: `input.accepted:${clientMessageId}`,
    payload: { inputId: id, clientMessageId, delivery, source: "user", disposition: "steered" } })
}
function restrictedCommandPool(base: Pool): PgSubagentPool {
  return { async connect() {
    const client = await base.connect()
    return new Proxy(client, { get(target, property) {
      if (property === "query") return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(target.query, target, args)
        const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : ""
        return Promise.resolve(result).then(async value => {
          if (sql === "BEGIN") {
            await Reflect.apply(target.query, target, [`SET LOCAL ROLE "${runtimeRole}"`])
            await Reflect.apply(target.query, target, ["SELECT set_config('app.user_id', $1, true)", [ids.user]])
          }
          return value
        })
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
  } }
}
async function waitForBlockedBy(applicationName: string, blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const blocked = (await adminPool!.query<{ blocked: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity AS waiter WHERE waiter.application_name = $1 AND waiter.wait_event_type = 'Lock'
        AND $2::int = ANY(pg_blocking_pids(waiter.pid))) AS blocked`, [applicationName, blockerPid])).rows[0]?.blocked
    if (blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`PostgreSQL did not report ${applicationName} blocked by backend ${blockerPid}`)
}
async function waitForAnyLockWait(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const blocked = (await adminPool!.query<{ blocked: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity AS waiter WHERE waiter.application_name = $1 AND waiter.wait_event_type = 'Lock'
        AND cardinality(pg_blocking_pids(waiter.pid)) > 0) AS blocked`, [applicationName])).rows[0]?.blocked
    if (blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`PostgreSQL did not report ${applicationName} waiting on a lock`)
}
async function acceptSteer(client: PoolClient, id: string, messageId: string, text: string): Promise<number> {
  // Mirrors the Web producer's accepted item/event/input facts; this fixture does not call its HTTP service.
  const itemId = `${id}-item`, content = { parts: [{ type: "text", text }], clientMessageId: messageId, source: "user", disposition: "steered" }
  await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, 'user_message', 'completed', 'commentary', 0, $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [itemId, ids.session, ids.turn, JSON.stringify(content)])
  const sequence = (await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [ids.session, ids.user])).rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("could not allocate user acceptance sequence")
  await client.query(`INSERT INTO "agent_events" (${EVENT_COLUMNS})
    VALUES ($1, $2, $3, $4, NULL, $5, 'input.accepted', 'user', $3, NULL, $6, $7::jsonb)`,
  [`${id}-accepted-event`, ids.session, ids.turn, itemId, sequence, `agent-command:${messageId}`,
    JSON.stringify({ inputId: id, clientMessageId: messageId, delivery: "steer", source: "user", disposition: "steered" })])
  await client.query(`INSERT INTO "agent_inputs" ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
    VALUES ($1, $2, $3, $4, $5, 'steer', 'accepted', $6::jsonb, $7)`,
  [id, ids.session, ids.turn, ids.user, messageId, JSON.stringify([{ type: "text", text }]), sequence])
  return Number(sequence)
}
async function acceptanceTransaction(input: { id: string; messageId: string; text: string; pidReady?: (pid: number) => void }): Promise<number> {
  const client = await acceptancePool!.connect()
  try {
    await client.query("BEGIN")
    const pid = Number((await client.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]?.pid)
    input.pidReady?.(pid)
    await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [ids.session, ids.user])
    const sequence = await acceptSteer(client, input.id, input.messageId, input.text)
    await client.query("COMMIT")
    return sequence
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
async function seedStep(id: string, ordinal: number, status: string, cursor: number, consumedInputIds: readonly string[]): Promise<void> {
  await adminPool!.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::jsonb, '{}'::jsonb)`,
  [id, ids.session, ids.turn, ids.root, ordinal, status, cursor, JSON.stringify(consumedInputIds)])
}
async function seedToolCall(stepId: string, callId: string, name: "agent.reconcile" | "agent.plan", input: unknown, sequence: number): Promise<void> {
  const itemId = `${callId}-item`, content = { toolCallId: callId, toolName: name, toolVersion: "1", input }
  await adminPool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', NULL, 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [itemId, ids.session, ids.turn, stepId, ids.root, JSON.stringify(content)])
  await insertEvent({ id: `${callId}-started-event`, sequence, type: "tool_call.started", actor: "orchestrator", itemId, taskId: ids.root,
    correlationId: callId, idempotencyKey: `${executionKey(executionIdentity)}:event:tool-started:${callId}`,
    payload: { toolCallId: callId, toolName: name, taskId: ids.root } })
}
async function runtimeTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await runtimePool!.connect()
  try {
    await client.query("BEGIN")
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`)
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.user])
    const value = await run(client)
    await client.query("COMMIT")
    return value
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
function operation(stepId: string, callId: string, decision: "keep" | "revise", expectedRevision = 1) {
  return { scope: { ...scope, stepId }, decision, expectedRevision, callId, rootInputId: null }
}
function loadSteeringContext(client: PoolClient) {
  return loadUnresolvedSteeringContext(client, hydrationScope, createStoredAgentInputMapper(message => new Error(message)), message => new Error(message))
}
async function beginRuntime(client: PoolClient): Promise<void> {
  await client.query("BEGIN")
  await client.query(`SET LOCAL ROLE "${runtimeRole}"`)
  await client.query("SELECT set_config('app.user_id', $1, true)", [ids.user])
}
async function lockAcceptanceSession(client: PoolClient): Promise<number> {
  await client.query("BEGIN")
  const pid = Number((await client.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]?.pid)
  await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [ids.session, ids.user])
  return pid
}
async function casGraph(client: PoolClient): Promise<number> {
  const result = await writeTaskGraphSnapshot(client, { ...scope, stepId: ids.currentStep }, revisedGraph, 1, new Date())
  return result.revision
}
async function grantEventInsert(): Promise<void> {
  await adminPool!.query(`GRANT INSERT (${EVENT_COLUMNS}) ON "agent_events" TO "${runtimeRole}"`)
}
async function seedBase(): Promise<void> {
  await adminPool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
  await adminPool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt", "eventSequence")
    VALUES ($1, $2, 'Steering reconciliation acceptance', 'running', 'test', CURRENT_TIMESTAMP, 4)`, [ids.session, ids.user])
  await adminPool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
    "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
  [ids.turn, ids.session, ids.user, JSON.stringify({ goal: "Keep the user objective", clientMessageId: `${ids.originalInput}-message` }), ids.turnOwner, future])
  await adminPool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Keep the user objective', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 2, $4, $5, CURRENT_TIMESTAMP)`,
  [ids.root, ids.session, ids.turn, ids.taskOwner, future])
  await adminPool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await adminPool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, '/root/continued-work', 1, 'analyst', 'job_analysis', 'queued', 'Continue the user-requested research',
      '[]'::jsonb, '["Record findings"]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 2, CURRENT_TIMESTAMP)`,
  [ids.graphChild, ids.session, ids.turn, ids.root])
  await adminPool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await seedStep(ids.originStep, 0, "completed", 1, [ids.originalInput])
  await seedStep(ids.keepStep, 1, "streaming", 2, [ids.firstSteer])
  await insertMessage(ids.originalInput, `${ids.originalInput}-message`, 1, "steer")
  await insertMessage(ids.firstSteer, `${ids.firstSteer}-message`, 2, "steer", ids.keepStep,
    [{ type: "text", text: "Compare staff engineer roles" }, { type: "text", text: "Keep Berlin as the location" }])
  await adminPool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'task_graph', 'streaming', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [taskGraphItemId(ids.root), ids.session, ids.turn, ids.keepStep, ids.root, JSON.stringify(baseGraph)])
  const key = steeringReconciliationIdempotencyKey(scope, ids.keepCall)
  if (!key) throw new Error("steering reconciliation fixture key was invalid")
  await insertEvent({ id: `${ids.keepStep}-agenda`, sequence: 3, type: "cognitive.agenda", actor: "orchestrator", itemId: null, taskId: ids.root,
    correlationId: ids.keepStep, idempotencyKey: `cognitive.agenda:${ids.keepStep}`, payload: agenda(ids.keepStep, 2n, 1) })
  await seedToolCall(ids.keepStep, ids.keepCall, "agent.reconcile", { decision: "keep", expectedRevision: 1 }, 4)
}

describePg("durable steering reconciliation PostgreSQL acceptance", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl!, max: 3 })
    await seedBase()
    await adminPool.query(`CREATE ROLE "${runtimeRole}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
    runtimeRoleCreated = true
    await adminPool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`)
    await adminPool.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_inputs", "agent_items", "agent_events", "agent_outbox" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT UPDATE ("updatedAt") ON "agent_sessions", "agent_turns", "sub_agent_tasks" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT UPDATE ("status") ON "agent_steps" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT UPDATE ("eventSequence") ON "agent_sessions" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT INSERT ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt") ON "agent_items" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT UPDATE ("stepId", "revision", "content", "status", "completedAt", "updatedAt") ON "agent_items" TO "${runtimeRole}"`)
    await grantEventInsert()
    runtimePool = new Pool({ connectionString: databaseUrl!, max: 3, application_name: decisionApplicationName })
    acceptancePool = new Pool({ connectionString: databaseUrl!, max: 2, application_name: acceptanceApplicationName })
    planPool = new Pool({ connectionString: databaseUrl!, max: 2, application_name: `steer_plan_${suffix}` })
  })
  afterAll(async () => {
    await runtimePool?.end()
    await acceptancePool?.end()
    await planPool?.end()
    if (!adminPool) return
    await adminPool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    if (runtimeRoleCreated) {
      await adminPool.query(`DROP OWNED BY "${runtimeRole}"`)
      await adminPool.query(`DROP ROLE IF EXISTS "${runtimeRole}"`)
    }
    await adminPool.end()
  })

  it("replays keep across a question/rebuild, blocks a later steer on an empty checkpoint, and atomically rolls back a denied revise receipt", async () => {
    const keep = operation(ids.keepStep, ids.keepCall, "keep")
    await runtimeTransaction(async client => {
      const before = await loadSteeringContext(client)
      expect(before).toMatchObject([{ id: ids.firstSteer, content: [
        { type: "text", text: "Compare staff engineer roles" }, { type: "text", text: "Keep Berlin as the location" },
      ] }])
      const prepared = await prepareSteeringReconciliation(client, keep)
      expect(prepared?.steerInputIds).toEqual([ids.firstSteer])
      if (!prepared) throw new Error("expected keep receipt")
      await writeSteeringReconciliationReceipt(client, prepared, 1)
      expect(await loadSteeringContext(client)).toEqual([])
    })
    await adminPool!.query(`UPDATE "agent_steps" SET "status" = 'completed' WHERE "id" = $1`, [ids.keepStep])
    const questionIntent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input", question: "Which direction?", options: [] }
    await adminPool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, NULL, 'user_question', 'completed', NULL, 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.questionItem, ids.session, ids.turn, ids.keepStep, JSON.stringify({ questionId: ids.questionItem, intent: questionIntent, answer: "Continue" })])
    await insertEvent({ id: `${ids.questionItem}-answered`, sequence: 6, type: "question.answered", actor: "user", itemId: ids.questionItem, taskId: null,
      correlationId: ids.questionItem, idempotencyKey: `question.answered:${ids.questionItem}`, payload: { questionId: ids.questionItem, answer: "Continue" } })
    await runtimeTransaction(async client => expect(await loadSteeringContext(client)).toEqual([]))
    await seedStep(ids.consumeStep, 2, "completed", 7, [ids.laterSteer])
    await insertMessage(ids.laterSteer, `${ids.laterSteer}-message`, 7, "steer")
    await seedStep(ids.currentStep, 3, "streaming", 7, [])
    await insertEvent({ id: `${ids.currentStep}-agenda`, sequence: 8, type: "cognitive.agenda", actor: "orchestrator", itemId: null, taskId: ids.root,
      correlationId: ids.currentStep, idempotencyKey: `cognitive.agenda:${ids.currentStep}`, payload: agenda(ids.currentStep, 7n, 1) })
    await seedToolCall(ids.currentStep, ids.reviseCall, "agent.plan", { expectedRevision: 1, nodes: [{ key: "continued-work" }] }, 9)
    await adminPool!.query(`UPDATE "agent_sessions" SET "eventSequence" = 9 WHERE "id" = $1`, [ids.session])

    const revise = operation(ids.currentStep, ids.reviseCall, "revise")
    await runtimeTransaction(async client => {
      const state = await readSteeringReconciliationState(client, revise.scope)
      expect(state.resolvedInputIds).toEqual([ids.firstSteer])
      expect(state.unresolvedInputs.map(input => input.id)).toEqual([ids.laterSteer])
      expect((await loadSteeringContext(client)).map(input => input.id)).toEqual([ids.laterSteer])
      await expect(assertNoUnresolvedSteering(client, revise.scope)).rejects.toThrow("steering_reconciliation_pending")
    })

    const laterContent = { parts: [{ type: "text", text: `User steer ${ids.laterSteer}` }],
      clientMessageId: `${ids.laterSteer}-message`, source: "user", disposition: "steered" }
    await adminPool!.query(`UPDATE "agent_events" SET "itemId" = NULL WHERE "id" = $1`, [`${ids.laterSteer}-accepted-event`])
    try {
      await expect(runtimeTransaction(client => loadSteeringContext(client))).rejects.toThrow("steering_reconciliation_acceptance_invalid")
    } finally {
      await adminPool!.query(`UPDATE "agent_events" SET "itemId" = $2 WHERE "id" = $1`, [`${ids.laterSteer}-accepted-event`, `${ids.laterSteer}-item`])
    }
    await adminPool!.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{parts,0,text}', to_jsonb('changed steering text'::text)) WHERE "id" = $1`,
      [`${ids.laterSteer}-item`])
    try {
      await expect(runtimeTransaction(client => loadSteeringContext(client))).rejects.toThrow("Accepted user steering content changed")
    } finally {
      await adminPool!.query(`UPDATE "agent_items" SET "content" = $2::jsonb WHERE "id" = $1`, [`${ids.laterSteer}-item`, JSON.stringify(laterContent)])
    }

    await adminPool!.query(`REVOKE INSERT (${EVENT_COLUMNS}) ON "agent_events" FROM "${runtimeRole}"`)
    await expect(runtimeTransaction(async client => {
      const prepared = await prepareSteeringReconciliation(client, revise)
      if (!prepared) throw new Error("expected revise receipt")
      const revision = await casGraph(client)
      await writeSteeringReconciliationReceipt(client, prepared, revision)
    })).rejects.toThrow(/permission denied/i)
    const afterDenied = await adminPool!.query<{ revision: number; eventSequence: string; receipts: number }>(`SELECT item."revision", session."eventSequence"::text AS "eventSequence",
      (SELECT COUNT(*)::int FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."type" = 'agent.plan.reconciliation') AS "receipts"
      FROM "agent_items" AS item JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
      WHERE item."id" = $2 AND session."id" = $1`, [ids.session, taskGraphItemId(ids.root)])
    expect(afterDenied.rows[0]).toEqual({ revision: 1, eventSequence: "9", receipts: 1 })

    await grantEventInsert()
    await runtimeTransaction(async client => {
      const prepared = await prepareSteeringReconciliation(client, revise)
      if (!prepared) throw new Error("expected revise receipt")
      const revision = await casGraph(client)
      expect(revision).toBe(2)
      await writeSteeringReconciliationReceipt(client, prepared, revision)
      const state = await readSteeringReconciliationState(client, revise.scope)
      expect(state.currentRevision).toBe(2)
      expect(state.resolvedInputIds).toEqual([ids.firstSteer, ids.laterSteer].sort())
      expect(state.unresolvedInputs).toEqual([])
    })
    const final = await adminPool!.query<{ revision: number; eventSequence: string; receiptCount: number; itemId: string | null; actor: string; outboxCount: number }>(`SELECT graph."revision", session."eventSequence"::text AS "eventSequence",
      (SELECT COUNT(*)::int FROM "agent_events" AS receipt WHERE receipt."sessionId" = $1 AND receipt."type" = 'agent.plan.reconciliation') AS "receiptCount",
      receipt."itemId", receipt."actor", (SELECT COUNT(*)::int FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || receipt."id") AS "outboxCount"
      FROM "agent_items" AS graph JOIN "agent_sessions" AS session ON session."id" = graph."sessionId"
      JOIN "agent_events" AS receipt ON receipt."sessionId" = session."id" AND receipt."type" = 'agent.plan.reconciliation'
      WHERE session."id" = $1 AND graph."id" = $2 AND receipt."causationId" = $3 ORDER BY receipt."sequence" DESC LIMIT 1`,
    [ids.session, taskGraphItemId(ids.root), ids.currentStep])
    expect(final.rows[0]).toEqual({ revision: 2, eventSequence: "10", receiptCount: 2, itemId: null, actor: "orchestrator", outboxCount: 0 })
  })

  it("serializes accepted steering against keep, revise, and native dispatch in either lock order", async () => {
    const commandPort = createPgTaskGraphCommandPort(restrictedCommandPool(runtimePool!))
    const planCommandPort = createPgTaskGraphCommandPort(restrictedCommandPool(planPool!))
    const decisionStep = `steering-race-decision-${suffix}`, decisionCall = `steering-race-call-${suffix}`
    const priorSteer = `steering-race-prior-${suffix}`, afterDecisionSteer = `steering-race-after-${suffix}`
    const afterKeepSteer = `steering-race-keep-after-${suffix}`, afterKeepCall = `steering-race-keep-call-${suffix}`
    const lastStep = `steering-race-last-step-${suffix}`, lastCall = `steering-race-last-call-${suffix}`
    const lastPlanCall = `steering-race-last-plan-call-${suffix}`
    const lastSteer = `steering-race-last-${suffix}`, dispatchStep = `steering-race-dispatch-${suffix}`
    await adminPool!.query(`UPDATE "agent_steps" SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [ids.currentStep])
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $2::jsonb WHERE "id" = $1`,
      [ids.root, JSON.stringify(["agent.plan", "jobs.search", "jobs.get"])])

    const decisionSequence = 11
    await seedStep(decisionStep, 4, "streaming", decisionSequence, [ids.originalInput, ids.firstSteer, ids.laterSteer, priorSteer])
    await insertMessage(priorSteer, `${priorSteer}-message`, decisionSequence, "steer", decisionStep)
    await insertEvent({ id: `${decisionStep}-agenda`, sequence: 12, type: "cognitive.agenda", actor: "orchestrator", itemId: null, taskId: ids.root,
      correlationId: decisionStep, idempotencyKey: `cognitive.agenda:${decisionStep}`, payload: agenda(decisionStep, BigInt(decisionSequence), 2) })
    await seedToolCall(decisionStep, decisionCall, "agent.reconcile", { decision: "keep", expectedRevision: 2 }, 13)
    await adminPool!.query(`UPDATE "agent_sessions" SET "eventSequence" = 13 WHERE "id" = $1`, [ids.session])
    const decision = operation(decisionStep, decisionCall, "keep", 2)

    const decisionClient = await runtimePool!.connect()
    let decisionOpen = true
    try {
      await beginRuntime(decisionClient)
      const decisionPid = Number((await decisionClient.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]?.pid)
      await lockTaskGraphScope(decisionClient, decision.scope, true)
      let resolveAcceptancePid!: (pid: number) => void
      const acceptancePid = new Promise<number>(resolve => { resolveAcceptancePid = resolve })
      const laterAcceptance = acceptanceTransaction({ id: afterDecisionSteer, messageId: `${afterDecisionSteer}-message`,
        text: "Preserve this newly accepted constraint", pidReady: resolveAcceptancePid })
      await waitForBlockedBy(acceptanceApplicationName, decisionPid)
      const prepared = await prepareSteeringReconciliation(decisionClient, decision)
      expect(prepared?.steerInputIds).toEqual([priorSteer])
      if (!prepared) throw new Error("expected the decision to resolve only the earlier accepted steer")
      await writeSteeringReconciliationReceipt(decisionClient, prepared, 2)
      await decisionClient.query("COMMIT")
      decisionOpen = false
      const acceptedSequence = await laterAcceptance
      expect(acceptedSequence).toBeGreaterThan(decisionSequence)
      expect(await acceptancePid).toBeGreaterThan(0)
    } finally {
      if (decisionOpen) await decisionClient.query("ROLLBACK").catch(() => undefined)
      decisionClient.release()
    }

    const afterKeepSequence = (await adminPool!.query<{ acceptedSequence: string }>(`SELECT "acceptedSequence"::text AS "acceptedSequence" FROM "agent_inputs" WHERE "id" = $1`, [afterDecisionSteer])).rows[0]
    if (!afterKeepSequence) throw new Error("the post-decision steer was not persisted")
    await seedStep(`steering-race-after-step-${suffix}`, 5, "streaming", Number(afterKeepSequence.acceptedSequence),
      [ids.originalInput, ids.firstSteer, ids.laterSteer, priorSteer])
    await insertEvent({ id: `steering-race-after-agenda-${suffix}`, sequence: Number(afterKeepSequence.acceptedSequence) + 1,
      type: "cognitive.agenda", actor: "orchestrator", itemId: null, taskId: ids.root, correlationId: `steering-race-after-step-${suffix}`,
      idempotencyKey: `cognitive.agenda:steering-race-after-step-${suffix}`,
      payload: agenda(`steering-race-after-step-${suffix}`, BigInt(afterKeepSequence.acceptedSequence), 2) })
    await adminPool!.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [ids.session, Number(afterKeepSequence.acceptedSequence) + 1])
    const postDecisionScope = { ...scope, stepId: `steering-race-after-step-${suffix}` }
    const pendingBeforeDispatch = await runtimeTransaction(client => readSteeringReconciliationState(client, { ...postDecisionScope, stepId: undefined }))
    expect(pendingBeforeDispatch.resolvedInputIds).toContain(priorSteer)
    expect(pendingBeforeDispatch.unresolvedInputs.map(input => input.id)).toEqual([afterDecisionSteer])
    const dispatchInput = (stepId: string, key: string): TaskGraphNativeCommandInput => ({
      scope: { ...scope, stepId }, request: { kind: "spawn", idempotencyKey: key, role: "auditor", taskType: "audit",
        goal: "Inspect the scoped task", constraints: ["read only"], successCriteria: ["record findings"], context: {} },
    })
    const beforeDispatch = await adminPool!.query(`SELECT graph."revision",
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch') AS dispatches
      FROM "agent_items" AS graph WHERE graph."id" = $3`, [ids.session, ids.root, taskGraphItemId(ids.root)])
    await expect(commandPort.appendNativeCoordination!(dispatchInput(postDecisionScope.stepId, `blocked-after-decision-${suffix}`)))
      .rejects.toThrow("steering_reconciliation_pending")
    expect((await adminPool!.query(`SELECT graph."revision",
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch') AS dispatches
      FROM "agent_items" AS graph WHERE graph."id" = $3`, [ids.session, ids.root, taskGraphItemId(ids.root)])).rows).toEqual(beforeDispatch.rows)

    await adminPool!.query(`UPDATE "agent_steps" SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [postDecisionScope.stepId])
    const afterKeepAccepted = Number(afterKeepSequence.acceptedSequence)
    await seedStep(afterKeepSteer, 6, "streaming", afterKeepAccepted,
      [ids.originalInput, ids.firstSteer, ids.laterSteer, priorSteer, afterDecisionSteer])
    await adminPool!.query(`UPDATE "agent_inputs" SET "status" = 'consumed', "consumedByStepId" = $2, "consumedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [afterDecisionSteer, afterKeepSteer])
    const afterKeepEventSequence = Number((await adminPool!.query<{ eventSequence: string }>(`SELECT "eventSequence"::text AS "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [ids.session])).rows[0]?.eventSequence)
    await insertEvent({ id: `${afterKeepSteer}-agenda`, sequence: afterKeepEventSequence + 1, type: "cognitive.agenda", actor: "orchestrator", itemId: null,
      taskId: ids.root, correlationId: afterKeepSteer, idempotencyKey: `cognitive.agenda:${afterKeepSteer}`,
      payload: agenda(afterKeepSteer, BigInt(afterKeepAccepted), 2) })
    await seedToolCall(afterKeepSteer, afterKeepCall, "agent.reconcile", { decision: "keep", expectedRevision: 2 }, afterKeepEventSequence + 2)
    await adminPool!.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [ids.session, afterKeepEventSequence + 2])
    await expect(commandPort.reconcileSteering!(operation(afterKeepSteer, afterKeepCall, "keep", 2))).resolves.toEqual({
      decision: "keep", revision: 2, reconciledInputCount: 1,
    })

    await adminPool!.query(`UPDATE "agent_steps" SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [afterKeepSteer])
    const staleCursor = Number((await adminPool!.query<{ eventSequence: string }>(`SELECT "eventSequence"::text AS "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [ids.session])).rows[0]?.eventSequence)
    await seedStep(lastStep, 7, "streaming", staleCursor, [ids.originalInput, ids.firstSteer, ids.laterSteer, priorSteer, afterDecisionSteer])
    await insertEvent({ id: `${lastStep}-agenda`, sequence: staleCursor + 1, type: "cognitive.agenda", actor: "orchestrator", itemId: null,
      taskId: ids.root, correlationId: lastStep, idempotencyKey: `cognitive.agenda:${lastStep}`, payload: agenda(lastStep, BigInt(staleCursor), 2) })
    await seedToolCall(lastStep, lastCall, "agent.reconcile", { decision: "keep", expectedRevision: 2 }, staleCursor + 2)
    const reviseProposal = { expectedRevision: 2, nodes: [{ key: `race-revise-${suffix}`, templateId: "analyst",
      goal: "Continue the original research", successCriteria: ["Record findings"], dependsOn: [] }] }
    const reviseInput = { scope: { ...scope, stepId: lastStep }, proposal: reviseProposal,
      templates: { analyst: { role: "analyst", taskType: "job_analysis", allowedActions: [] } } }
    await seedToolCall(lastStep, lastPlanCall, "agent.plan", reviseProposal, staleCursor + 3)
    await adminPool!.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [ids.session, staleCursor + 3])
    const beforeStaleDecision = await adminPool!.query(`SELECT graph."revision", graph."content",
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch') AS dispatches,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'agent.plan.reconciliation') AS receipts,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "itemId" = $3 AND "payload"->>'kind' = 'proposal') AS plans
      FROM "agent_items" AS graph WHERE graph."id" = $3`, [ids.session, ids.root, taskGraphItemId(ids.root)])
    const acceptanceClient = await acceptancePool!.connect()
    let acceptanceOpen = true
    try {
      const acceptancePid = await lockAcceptanceSession(acceptanceClient)
      const staleKeep = commandPort.reconcileSteering!(operation(lastStep, lastCall, "keep", 2))
      const staleRevise = planCommandPort.appendAndScheduleWithReconciliation!(reviseInput,
        operation(lastStep, lastPlanCall, "revise", 2))
      await waitForBlockedBy(decisionApplicationName, acceptancePid)
      await waitForAnyLockWait(`steer_plan_${suffix}`)
      const acceptedSequence = await acceptSteer(acceptanceClient, lastSteer, `${lastSteer}-message`, "A steer arriving during keep")
      await acceptanceClient.query("COMMIT")
      acceptanceOpen = false
      expect(acceptedSequence).toBeGreaterThan(staleCursor + 3)
      await expect(staleKeep).rejects.toThrow("steering_reconciliation_unconsumed_input")
      await expect(staleRevise).rejects.toThrow("steering_reconciliation_unconsumed_input")
      expect((await adminPool!.query(`SELECT graph."revision", graph."content",
        (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
        (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch') AS dispatches,
        (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'agent.plan.reconciliation') AS receipts,
        (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "itemId" = $3 AND "payload"->>'kind' = 'proposal') AS plans
        FROM "agent_items" AS graph WHERE graph."id" = $3`, [ids.session, ids.root, taskGraphItemId(ids.root)])).rows).toEqual(beforeStaleDecision.rows)
    } finally {
      if (acceptanceOpen) await acceptanceClient.query("ROLLBACK").catch(() => undefined)
      acceptanceClient.release()
    }

    const receiptRows = await adminPool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'agent.plan.reconciliation' ORDER BY "sequence"`, [ids.session])
    expect(receiptRows.rows).toHaveLength(4)
    expect(JSON.stringify(receiptRows.rows.map(row => row.payload))).not.toContain(lastSteer)
    expect((await adminPool!.query<{ revision: number }>(`SELECT "revision" FROM "agent_items" WHERE "id" = $1`, [taskGraphItemId(ids.root)])).rows[0]?.revision).toBe(2)

    await adminPool!.query(`UPDATE "agent_steps" SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [lastStep])
    const lastCursor = Number((await adminPool!.query<{ sequence: string }>(`SELECT "acceptedSequence"::text AS sequence FROM "agent_inputs" WHERE "id" = $1`, [lastSteer])).rows[0]?.sequence)
    await seedStep(dispatchStep, 8, "streaming", lastCursor,
      [ids.originalInput, ids.firstSteer, ids.laterSteer, priorSteer, afterDecisionSteer, lastSteer])
    await adminPool!.query(`UPDATE "agent_inputs" SET "status" = 'consumed', "consumedByStepId" = $2, "consumedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [lastSteer, dispatchStep])
    await insertEvent({ id: `${dispatchStep}-agenda`, sequence: lastCursor + 1, type: "cognitive.agenda", actor: "orchestrator", itemId: null,
      taskId: ids.root, correlationId: dispatchStep, idempotencyKey: `cognitive.agenda:${dispatchStep}`, payload: agenda(dispatchStep, BigInt(lastCursor), 2) })
    await adminPool!.query(`UPDATE "agent_sessions" SET "eventSequence" = $2 WHERE "id" = $1`, [ids.session, lastCursor + 1])
    const consumedPending = await runtimeTransaction(client => readSteeringReconciliationState(client, { ...scope, stepId: dispatchStep }))
    expect(consumedPending.unresolvedInputs).toEqual([expect.objectContaining({ id: lastSteer, status: "consumed", consumedByStepId: dispatchStep })])
    const beforeLastDispatch = await adminPool!.query(`SELECT graph."revision",
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch') AS dispatches
      FROM "agent_items" AS graph WHERE graph."id" = $3`, [ids.session, ids.root, taskGraphItemId(ids.root)])
    await expect(commandPort.appendNativeCoordination!(dispatchInput(dispatchStep, `blocked-after-keep-${suffix}`)))
      .rejects.toThrow("steering_reconciliation_pending")
    expect((await adminPool!.query(`SELECT graph."revision",
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch') AS dispatches
      FROM "agent_items" AS graph WHERE graph."id" = $3`, [ids.session, ids.root, taskGraphItemId(ids.root)])).rows).toEqual(beforeLastDispatch.rows)
  })
})
