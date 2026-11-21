import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
import { redactAgentEvent } from "@jobcopilot/shared"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { createCanonicalTurnContextBuilder } from "../canonical-turn-context-builder.js"
import type { DirectRootTaskHistoryReader } from "../canonical-turn-root-task-history.js"
import { createPgInputClaimStore } from "./input-claim-store.js"
import type { TurnLease } from "../turns/lease.js"
import { withRootTaskHistorySessionAuthorization } from "./root-task-history-session-memory.js"
import { readRetrySourceSteeringObservation } from "./retry-source-steering.js"

type WebPrisma = {
  $connect(): Promise<void>; $disconnect(): Promise<void>
  user: { create(args: { data: { id: string; email: string } }): Promise<unknown> }
}
const webRequire = createRequire(new URL("../../../../web/package.json", import.meta.url))
const PrismaClient = (webRequire("@prisma/client") as {
  PrismaClient: new (options: { datasources: { db: { url: string } } }) => WebPrisma
}).PrismaClient
const DATABASE_NAME = "applymate_agent_brain_ci"

function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Retry source steering tests require disposable PostgreSQL")
    return null
  }
  const url = new URL(value)
  const localDisposable = url.port === "15433" && process.env.AGENT_REPLAN_PROOF_LOCAL_DISPOSABLE === "1"
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || (url.port !== "5432" && !localDisposable)
    || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) throw new Error("Retry source steering tests require the dedicated loopback disposable URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID()
let prisma: WebPrisma | undefined, pool: Pool | undefined
const users = new Set<string>()
type Fixture = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; stepId: string; lease: TurnLease }>
const GOAL = "Find platform engineering roles"
const CRITERIA = ["Use the user's accepted role preferences"]
const OBJECTIVE_TEXT = "I am looking for platform engineering roles."
const ORIGINAL_INPUT = { goal: GOAL, content: [{ type: "text", text: OBJECTIVE_TEXT }],
  intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }
const PRIOR_STEER = "Prefer platform engineering roles in Dublin."

async function createUser(): Promise<string> {
  const id = `retry-steering-user-${randomUUID()}`
  users.add(id)
  await prisma!.user.create({ data: { id, email: `${id}@example.invalid` } })
  return id
}

async function createSession(userId: string): Promise<string> {
  const id = `retry-steering-session-${randomUUID()}`
  await pool!.query(`INSERT INTO "agent_sessions" ("id","userId","goal","status","source","eventSequence","updatedAt")
    VALUES ($1,$2,$3,'running','user',0,CURRENT_TIMESTAMP)`, [id, userId, GOAL])
  return id
}

async function createTurn(userId: string, sessionId: string, terminal: boolean): Promise<Fixture> {
  const now = new Date(), expires = new Date(now.getTime() + 300_000)
  const turnId = `retry-steering-turn-${randomUUID()}`, rootTaskId = `retry-steering-root-${randomUUID()}`
  const stepId = `retry-steering-step-${randomUUID()}`, ownerId = `retry-steering-owner-${randomUUID()}`
  await pool!.query(`INSERT INTO "agent_turns" ("id","sessionId","userId","status","source","executionMode","input",
    "modelProfileSnapshot","toolPolicySnapshot","budgetSnapshot","rootTaskId","leaseOwnerId","leaseExpiresAt","leaseStartedAt","leaseVersion","completedAt","updatedAt")
    VALUES ($1,$2,$3,$4,'user','canonical_task_graph',$5::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$6,$7,$8,$9,1,$10,$9)`,
  [turnId, sessionId, userId, terminal ? "failed" : "in_progress", JSON.stringify(ORIGINAL_INPUT), rootTaskId,
    terminal ? null : ownerId, terminal ? null : expires, now, terminal ? now : null])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id","sessionId","turnId","rootTaskId","parentTaskId","path","depth","role","taskType",
    "status","goal","constraints","successCriteria","allowedActions","context","expectedOutputSchema","result","failureReason",
    "attemptCount","maxAttempts","leaseOwner","leaseExpiresAt","completedAt","updatedAt")
    VALUES ($1,$2,$3,$1,NULL,$4,0,'orchestrator','root',$5,$6,'[]'::jsonb,$7::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$8::jsonb,$9,1,2,$10,$11,$12,$13)`,
  [rootTaskId, sessionId, turnId, `/${rootTaskId}`, terminal ? "failed" : "running", GOAL,
    JSON.stringify(CRITERIA), JSON.stringify(terminal ? { status: "failed", errorCode: "provider_error" } : {}),
    terminal ? "provider_error" : null, terminal ? null : ownerId, terminal ? null : expires,
    terminal ? now : null, now])
  await pool!.query(`INSERT INTO "agent_steps" ("id","sessionId","turnId","taskId","ordinal","attempt","status","inputThroughSequence","consumedInputIds","modelProfileSnapshot")
    VALUES ($1,$2,$3,$4,1,1,$5,0,'[]'::jsonb,'{}'::jsonb)`, [stepId, sessionId, turnId, rootTaskId, terminal ? "failed" : "streaming"])
  return { userId, sessionId, turnId, rootTaskId, stepId, lease: {
    userId, sessionId, turnId, ownerId, leaseVersion: 1, leaseStartedAt: now, leaseExpiresAt: expires,
  } }
}

async function acceptInput(fixture: Fixture, delivery: "steer" | "follow_up", disposition: string, text: string) {
  const inputId = randomUUID(), itemId = randomUUID(), eventId = randomUUID(), clientMessageId = randomUUID()
  const parts = [{ type: "text", text }], source = "user"
  const route = { sessionId: fixture.sessionId, turnId: fixture.turnId, itemId, taskId: null,
    actor: "user" as const, correlationId: fixture.turnId, causationId: null, outboxTopic: "agent.session.event" as const }
  const payload = redactAgentEvent({ type: "input.accepted", body: "", data: { inputId, clientMessageId, delivery, disposition, source }, routing: route }).data
  if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("Accepted input sanitizer rejected the fixture")
  const itemContent = { clientMessageId, disposition, parts, source }
  const client = await pool!.connect()
  try {
    await client.query("BEGIN")
    const allocated = await client.query<{ eventSequence: string }>(`UPDATE "agent_sessions" SET "eventSequence"="eventSequence"+1
      WHERE "id"=$1 AND "userId"=$2 RETURNING "eventSequence"::text`, [fixture.sessionId, fixture.userId])
    const sequence = allocated.rows[0]?.eventSequence
    if (!sequence) throw new Error("Could not allocate accepted input sequence")
    await client.query(`INSERT INTO "agent_items" ("id","sessionId","turnId","type","status","phase","revision","content","startedAt","completedAt","updatedAt")
      VALUES ($1,$2,$3,'user_message','completed','commentary',0,$4::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [itemId, fixture.sessionId, fixture.turnId, JSON.stringify(itemContent)])
    const key = `agent-command:${clientMessageId}`
    await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor","correlationId","causationId","idempotencyKey","payload")
      VALUES ($1,$2,$3,$4,NULL,$5,'input.accepted','user',$3,NULL,$6,$7::jsonb)`,
    [eventId, fixture.sessionId, fixture.turnId, itemId, sequence, key, JSON.stringify(payload)])
    await client.query(`INSERT INTO "agent_inputs" ("id","sessionId","targetTurnId","userId","clientMessageId","delivery","status","content","acceptedSequence")
      VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7::jsonb,$8)`,
    [inputId, fixture.sessionId, fixture.turnId, fixture.userId, clientMessageId, delivery, JSON.stringify(parts), sequence])
    const outboxPayload = { eventId, sessionId: fixture.sessionId, turnId: fixture.turnId, taskId: null, itemId,
      sequence, type: "input.accepted", actor: "user", correlationId: fixture.turnId, causationId: null,
      idempotencyKey: key, payload }
    await client.query(`INSERT INTO "agent_outbox" ("id","topic","aggregateId","idempotencyKey","payload")
      VALUES ($1,'agent.events',$2,$3,$4::jsonb)`, [`agent-outbox-${eventId}`, fixture.sessionId,
      `agent-event:${eventId}`, JSON.stringify(outboxPayload)])
    await client.query("COMMIT")
    return { inputId, sequence }
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function readObservation(fixture: Fixture) {
  const client: PoolClient = await pool!.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    const result = await withRootTaskHistorySessionAuthorization(client, { scope: { userId: fixture.userId },
      lease: fixture.lease, rootTaskId: fixture.rootTaskId, rootAttemptCount: 1, stepId: fixture.stepId,
      environmentGateEnabled: false }, async (transactionClient) => {
      const row = await transactionClient.query<{ input: unknown }>(`SELECT "input" FROM "agent_turns"
        WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3`, [fixture.turnId, fixture.sessionId, fixture.userId])
      return readRetrySourceSteeringObservation(transactionClient, { userId: fixture.userId }, {
        sessionId: fixture.sessionId, turnId: fixture.turnId, rootTaskId: fixture.rootTaskId, turnInput: row.rows[0]?.input,
      })
    })
    await client.query("COMMIT")
    return result.workResult
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function buildContext(fixture: Fixture, rootInputId: string) {
  const scope = { userId: fixture.userId }
  const reader: DirectRootTaskHistoryReader = { load: async () => [], loadWithClient: async () => [] }
  const builder = createCanonicalTurnContextBuilder({ pool: pool!, store: createPgInputClaimStore(pool!, scope), scope,
    lease: fixture.lease, rootTaskId: fixture.rootTaskId, rootAttemptCount: 1,
    turnInput: await persistedTurnInput(fixture),
    rootTaskObjective: { goal: GOAL, successCriteria: CRITERIA }, planningEnabled: true, selectedJobMode: false,
    crossSessionRootTaskHistoryEnabled: false, rootTaskHistoryDirectReader: reader,
    currentRootBudgetReader: async () => ({ kind: "turn_budget_current", status: "unavailable", advisoryOnly: true,
      pointInTime: true, notPermission: true, notReservation: true, notCompletionEvidence: true }) })
  const now = new Date()
  return builder.build({ scope, sessionId: fixture.sessionId, turnId: fixture.turnId, stepId: fixture.stepId,
    rootInputId, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    lease: { ownerId: fixture.lease.ownerId, leaseVersion: fixture.lease.leaseVersion, now }, now })
}

async function persistedTurnInput(fixture: Fixture): Promise<unknown> {
  const result = await pool!.query<{ input: Record<string, unknown> }>(`SELECT "input" FROM "agent_turns"
    WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3`, [fixture.turnId, fixture.sessionId, fixture.userId])
  return result.rows[0]?.input
}

describePg("retry source steering PostgreSQL ownership", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    pool = new Pool({ connectionString: databaseUrl!, application_name: `retry-source-steering-${suffix}`, max: 6 })
    await prisma.$connect(); await pool.query("SELECT 1")
  })
  afterEach(async () => {
    for (const userId of users) {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" IN (SELECT "id" FROM "agent_sessions" WHERE "userId"=$1)`, [userId]).catch(() => undefined)
      await pool!.query(`DELETE FROM "User" WHERE "id"=$1`, [userId]).catch(() => undefined)
    }
    users.clear()
  })
  afterAll(async () => { await prisma?.$disconnect(); await pool?.end() })

  it("projects only a strictly owned same-session retry predecessor steer", async () => {
    const userId = await createUser(), sessionId = await createSession(userId)
    const predecessor = await createTurn(userId, sessionId, true)
    await acceptInput(predecessor, "steer", "steered", PRIOR_STEER)
    const current = await createTurn(userId, sessionId, false)
    const accepted = await acceptInput(current, "follow_up", "started", OBJECTIVE_TEXT)
    const receipt = { schemaVersion: "agent-harness.v2.retry-lineage.v1", predecessorTurnId: predecessor.turnId,
      acceptedInputId: accepted.inputId, acceptedSequence: accepted.sequence }
    await pool!.query(`UPDATE "agent_turns" SET "input"=$1::jsonb WHERE "id"=$2 AND "sessionId"=$3 AND "userId"=$4`,
      [JSON.stringify({ ...ORIGINAL_INPUT, retryLineage: receipt }), current.turnId, sessionId, userId])

    const context = await buildContext(current, accepted.inputId)
    const observation = context.blocks.find(block => block.id === "observation:retry-source-steering")
    expect(observation).toMatchObject({ id: "observation:retry-source-steering", layer: "tool_observation", role: "data",
      trust: "external_untrusted", source: "tool_or_subagent", content: {
        kind: "retry_source_steering", schemaVersion: "agent-harness.v2.retry-source-steering.v1",
        notice: "Earlier user steering from the immediately preceding attempt is context only. The current Turn input is authoritative.",
        informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true, messages: [PRIOR_STEER],
      } })
    expect(JSON.stringify(observation)).toContain(PRIOR_STEER)
    expect(JSON.stringify(observation)).not.toContain(OBJECTIVE_TEXT)
    for (const privateId of [userId, sessionId, predecessor.turnId, predecessor.rootTaskId, accepted.inputId, current.turnId, current.rootTaskId]) {
      expect(JSON.stringify(observation)).not.toContain(privateId)
    }

    const staleReceipt = { schemaVersion: "agent-harness.v2.retry-lineage.v1", predecessorTurnId: predecessor.turnId,
      acceptedInputId: accepted.inputId, acceptedSequence: (BigInt(accepted.sequence) + 1n).toString() }
    await pool!.query(`UPDATE "agent_turns" SET "input"=$1::jsonb WHERE "id"=$2 AND "sessionId"=$3 AND "userId"=$4`,
      [JSON.stringify({ ...ORIGINAL_INPUT, retryLineage: staleReceipt }), current.turnId, sessionId, userId])
    expect(await readObservation(current)).toBeUndefined()

    const otherSession = await createSession(userId)
    const foreignCurrent = await createTurn(userId, otherSession, false)
    const foreignAccepted = await acceptInput(foreignCurrent, "follow_up", "started", OBJECTIVE_TEXT)
    await pool!.query(`UPDATE "agent_turns" SET "input"=$1::jsonb WHERE "id"=$2 AND "sessionId"=$3 AND "userId"=$4`,
      [JSON.stringify({ ...ORIGINAL_INPUT, retryLineage: { ...receipt, acceptedInputId: foreignAccepted.inputId,
        acceptedSequence: foreignAccepted.sequence } }), foreignCurrent.turnId, otherSession, userId])
    expect(await readObservation(foreignCurrent)).toBeUndefined()
  })
})
