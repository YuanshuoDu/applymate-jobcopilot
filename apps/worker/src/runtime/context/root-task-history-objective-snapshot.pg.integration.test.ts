import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool, type PoolClient } from "pg"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import { createCanonicalTurnContextBuilder } from "../canonical-turn-context-builder.js"
import type { DirectRootTaskHistoryReader } from "../canonical-turn-root-task-history.js"
import { TurnEngine } from "../turns/turn-engine.js"
import type { TurnEngineOptions, TurnEngineStore } from "../turns/turn-engine-types.js"
import type { TurnLease } from "../turns/lease.js"
import { acquireRootTaskHistoryChronologyLock, appendRootTaskHistoryChronologyWitness } from "./root-task-history-chronology-witness.js"
import { createPgDirectRootTaskHistoryStore, type DirectRootTaskHistoryLoadInput } from "./root-task-history-direct-store.js"
import { readRootTaskHistoryFence } from "./root-task-history-fence.js"
import { withRootTaskHistoryObjectiveSnapshot, ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE } from "./root-task-history-objective-snapshot.js"
import { readRootTaskHistorySteerEvidence } from "./root-task-history-steer-evidence.js"
import { withRootTaskHistorySessionAuthorization } from "./root-task-history-session-memory.js"
import { createPgInputClaimStore } from "./input-claim-store.js"
import { updateRootObjectiveHistoryProjection } from "./objective-history-projection.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "../subagents/task-graph-snapshot.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const OBJECTIVE = "Plan an engineering search"
const CRITERIA = ["Keep the search within the saved locations"]
const EMPTY_SNAPSHOT = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } as const
const UNAVAILABLE_BUDGET = {
  kind: "turn_budget_current", status: "unavailable", advisoryOnly: true, pointInTime: true,
  notPermission: true, notReservation: true, notCompletionEvidence: true,
} as const

function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Objective snapshot tests require disposable PostgreSQL")
    return null
  }
  const url = new URL(value)
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Objective snapshot tests require the dedicated loopback disposable URL")
  }
  return value
}

type Scenario = Readonly<{
  userId: string
  sessionId: string
  foreignSessionId: string
  sourceSessionId: string
  turnId: string
  rootTaskId: string
  stepId: string
  sourceTurnId: string
  sourceRootTaskId: string
  lease: TurnLease
  scope: TenantScope
  turnInput: { goal: string; successCriteria: readonly string[] }
}>

type PersistedEvent = Readonly<{
  id: string
  sessionId: string
  turnId: string
  taskId: string
  sequence: number
  type: string
  correlationId: string
  idempotencyKey: string
  payload: unknown
}>

async function insertEventAndOutbox(client: PoolClient, event: PersistedEvent): Promise<void> {
  await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor",
    "correlationId","causationId","idempotencyKey","payload")
    VALUES ($1,$2,$3,NULL,$4,$5,$6,'orchestrator',$7,NULL,$8,$9::jsonb)`,
  [event.id, event.sessionId, event.turnId, event.taskId, event.sequence, event.type, event.correlationId,
    event.idempotencyKey, JSON.stringify(event.payload)])
  const payload = { eventId: event.id, sessionId: event.sessionId, turnId: event.turnId, taskId: event.taskId,
    itemId: null, sequence: String(event.sequence), type: event.type, actor: "orchestrator",
    correlationId: event.correlationId, causationId: null, idempotencyKey: event.idempotencyKey, payload: event.payload }
  await client.query(`INSERT INTO "agent_outbox" ("id","topic","aggregateId","idempotencyKey","payload")
    VALUES ($1,'agent.events',$2,$3,$4::jsonb)`,
  [`agent-outbox-${event.id}`, event.sessionId, `agent-event:${event.id}`, JSON.stringify(payload)])
}

async function insertSourceHistory(pool: Pool, scenario: Scenario): Promise<void> {
  const sourceGraph = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
    key: "analyst", templateId: "analyst", goal: "PRIVATE_SOURCE_NODE_GOAL", successCriteria: ["PRIVATE_SOURCE_CRITERION"],
    dependsOn: [], depth: 1, taskId: `${scenario.sourceRootTaskId}-analyst`,
  }] })
  const sourceChildId = `${scenario.sourceRootTaskId}-analyst`
  await pool.query(`INSERT INTO "agent_turns" ("id","sessionId","userId","status","source","input","modelProfileSnapshot",
    "toolPolicySnapshot","budgetSnapshot","rootTaskId","leaseVersion","updatedAt")
    VALUES ($1,$2,$3,'failed','user',$4::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,1,CURRENT_TIMESTAMP)`,
  [scenario.sourceTurnId, scenario.sourceSessionId, scenario.userId, JSON.stringify(scenario.turnInput), scenario.sourceRootTaskId])
  await pool.query(`INSERT INTO "sub_agent_tasks" ("id","sessionId","turnId","rootTaskId","parentTaskId","path","depth","role","taskType",
    "status","goal","constraints","successCriteria","allowedActions","context","expectedOutputSchema","modelProfileSnapshot",
    "toolPolicySnapshot","budgetSnapshot","attemptCount","maxAttempts","completedAt","updatedAt")
    VALUES ($1,$2,$3,$1,NULL,'/source',0,'orchestrator','root','failed',$4,'[]'::jsonb,$5::jsonb,'[]'::jsonb,
      '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  [scenario.sourceRootTaskId, scenario.sourceSessionId, scenario.sourceTurnId, OBJECTIVE, JSON.stringify(CRITERIA)])
  await pool.query(`INSERT INTO "sub_agent_tasks" ("id","sessionId","turnId","rootTaskId","parentTaskId","path","depth","role","taskType",
    "status","goal","constraints","successCriteria","allowedActions","context","expectedOutputSchema","result","modelProfileSnapshot",
    "toolPolicySnapshot","budgetSnapshot","attemptCount","maxAttempts","completedAt","updatedAt")
    VALUES ($1,$2,$3,$4,$4,'/source/analyst',1,'analyst','job_analysis','completed','PRIVATE_SOURCE_NODE_GOAL','[]'::jsonb,
      '["PRIVATE_SOURCE_CRITERION"]'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{"private":"PRIVATE_SOURCE_RESULT"}'::jsonb,
      '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  [sourceChildId, scenario.sourceSessionId, scenario.sourceTurnId, scenario.sourceRootTaskId])
  await pool.query(`INSERT INTO "agent_items" ("id","sessionId","turnId","taskId","type","status","revision","content","completedAt","updatedAt")
    VALUES ($1,$2,$3,$4,'task_graph','completed',1,$5::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  [taskGraphItemId(scenario.sourceRootTaskId), scenario.sourceSessionId, scenario.sourceTurnId, scenario.sourceRootTaskId, JSON.stringify(sourceGraph)])

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", scenario.userId])
    const chronologyLock = await acquireRootTaskHistoryChronologyLock(client, scenario.userId)
    const start: PersistedEvent = { id: `objective-snapshot-source-start-${scenario.sourceTurnId}`, sessionId: scenario.sourceSessionId,
      turnId: scenario.sourceTurnId, taskId: scenario.sourceRootTaskId, sequence: 1, type: "turn.started",
      correlationId: scenario.sourceTurnId, idempotencyKey: `turn:${scenario.sourceTurnId}:event:turn-started`,
      payload: { goal: OBJECTIVE, taskId: scenario.sourceRootTaskId, rootTaskId: scenario.sourceRootTaskId } }
    const terminal: PersistedEvent = { id: `objective-snapshot-source-failed-${scenario.sourceTurnId}`, sessionId: scenario.sourceSessionId,
      turnId: scenario.sourceTurnId, taskId: scenario.sourceRootTaskId, sequence: 2, type: "turn.failed",
      correlationId: scenario.sourceTurnId, idempotencyKey: `turn:${scenario.sourceTurnId}:event:turn-failed:task_failed`,
      payload: { turnId: scenario.sourceTurnId, taskId: scenario.sourceRootTaskId, errorCode: "task_failed", finalItemId: null } }
    await insertEventAndOutbox(client, start)
    await insertEventAndOutbox(client, terminal)
    await client.query(`UPDATE "agent_sessions" SET "eventSequence"=2 WHERE "id"=$1 AND "userId"=$2`,
      [scenario.sourceSessionId, scenario.userId])
    await appendRootTaskHistoryChronologyWitness(client, { userId: scenario.userId, sessionId: scenario.sourceSessionId,
      turnId: scenario.sourceTurnId, rootTaskId: scenario.sourceRootTaskId, boundary: "turn_start", boundaryEventId: start.id }, chronologyLock)
    await appendRootTaskHistoryChronologyWitness(client, { userId: scenario.userId, sessionId: scenario.sourceSessionId,
      turnId: scenario.sourceTurnId, rootTaskId: scenario.sourceRootTaskId, boundary: "root_terminal", boundaryEventId: terminal.id }, chronologyLock)
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }

  const projected = await pool.connect()
  try {
    await projected.query("BEGIN")
    const identity = { userId: scenario.userId, sessionId: scenario.sourceSessionId,
      turnId: scenario.sourceTurnId, rootTaskId: scenario.sourceRootTaskId }
    if (!await updateRootObjectiveHistoryProjection(projected, identity)
      || !await updateRootObjectiveHistoryProjection(projected, identity, { terminalEventId: `objective-snapshot-source-failed-${scenario.sourceTurnId}` })) {
      throw new Error("Source Root objective history projection did not validate")
    }
    await projected.query("COMMIT")
  } catch (error: unknown) {
    await projected.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { projected.release() }
}

async function createScenario(pool: Pool, includePriorHistory = true): Promise<Scenario> {
  const suffix = randomUUID(), userId = `objective-snapshot-user-${suffix}`
  const sessionId = `objective-snapshot-session-${suffix}`, foreignSessionId = `objective-snapshot-foreign-session-${suffix}`
  const sourceSessionId = `objective-snapshot-source-session-${suffix}`, turnId = `objective-snapshot-turn-${suffix}`
  const rootTaskId = `objective-snapshot-root-${suffix}`, stepId = `objective-snapshot-step-${suffix}`
  const sourceTurnId = `objective-snapshot-source-turn-${suffix}`, sourceRootTaskId = `objective-snapshot-source-root-${suffix}`
  const now = new Date(), expires = new Date(now.getTime() + 300_000)
  const turnInput = { goal: OBJECTIVE, successCriteria: CRITERIA }
  const scenario: Scenario = { userId, sessionId, foreignSessionId, sourceSessionId, turnId, rootTaskId, stepId, sourceTurnId,
    sourceRootTaskId, scope: { userId }, turnInput,
    lease: { userId, sessionId, turnId, ownerId: `objective-snapshot-owner-${suffix}`, leaseVersion: 1,
      leaseStartedAt: now, leaseExpiresAt: expires } }
  await pool.query(`INSERT INTO "User" ("id","email","updatedAt") VALUES ($1,$2,CURRENT_TIMESTAMP)`, [userId, `${userId}@example.invalid`])
  await pool.query(`UPDATE "User" SET "agentTaskHistoryMemoryEnabled"=TRUE,"agentTaskHistoryMemoryConsentVersion"=1,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, [userId])
  for (const id of [sessionId, foreignSessionId, ...(includePriorHistory ? [sourceSessionId] : [])]) {
    await pool.query(`INSERT INTO "agent_sessions" ("id","userId","goal","status","source","eventSequence","updatedAt")
      VALUES ($1,$2,$3,'running','user',0,CURRENT_TIMESTAMP)`, [id, userId, OBJECTIVE])
  }
  await pool.query(`INSERT INTO "agent_turns" ("id","sessionId","userId","status","source","input","modelProfileSnapshot",
    "toolPolicySnapshot","budgetSnapshot","rootTaskId","leaseOwnerId","leaseExpiresAt","leaseStartedAt","leaseVersion","updatedAt")
    VALUES ($1,$2,$3,'in_progress','user',$4::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$6,$7,$8,1,$8)`,
  [turnId, sessionId, userId, JSON.stringify(turnInput), rootTaskId, scenario.lease.ownerId, expires, now])
  await pool.query(`INSERT INTO "sub_agent_tasks" ("id","sessionId","turnId","rootTaskId","parentTaskId","path","depth","role","taskType",
    "status","goal","constraints","successCriteria","allowedActions","context","expectedOutputSchema","attemptCount","maxAttempts",
    "leaseOwner","leaseExpiresAt","updatedAt")
    VALUES ($1,$2,$3,$1,NULL,'/current',0,'orchestrator','root','running',$4,'[]'::jsonb,$5::jsonb,'[]'::jsonb,
      '{}'::jsonb,'{}'::jsonb,1,2,$6,$7,$8)`,
  [rootTaskId, sessionId, turnId, OBJECTIVE, JSON.stringify(CRITERIA), scenario.lease.ownerId, expires, now])
  await pool.query(`INSERT INTO "agent_steps" ("id","sessionId","turnId","taskId","ordinal","attempt","status","inputThroughSequence","consumedInputIds","modelProfileSnapshot")
    VALUES ($1,$2,$3,$4,1,1,'streaming',0,'[]'::jsonb,'{}'::jsonb)`, [stepId, sessionId, turnId, rootTaskId])

  if (includePriorHistory) await insertSourceHistory(pool, scenario)
  await insertCurrentStart(pool, scenario)
  return scenario
}

async function insertCurrentStart(pool: Pool, scenario: Scenario): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", scenario.userId])
    const chronologyLock = await acquireRootTaskHistoryChronologyLock(client, scenario.userId)
    const event: PersistedEvent = { id: `objective-snapshot-current-start-${scenario.turnId}`, sessionId: scenario.sessionId,
      turnId: scenario.turnId, taskId: scenario.rootTaskId, sequence: 1, type: "turn.started", correlationId: scenario.turnId,
      idempotencyKey: `turn:${scenario.turnId}:event:turn-started`,
      payload: { goal: OBJECTIVE, taskId: scenario.rootTaskId, rootTaskId: scenario.rootTaskId } }
    await insertEventAndOutbox(client, event)
    await client.query(`UPDATE "agent_sessions" SET "eventSequence"=1 WHERE "id"=$1 AND "userId"=$2`, [scenario.sessionId, scenario.userId])
    await appendRootTaskHistoryChronologyWitness(client, { userId: scenario.userId, sessionId: scenario.sessionId,
      turnId: scenario.turnId, rootTaskId: scenario.rootTaskId, boundary: "turn_start", boundaryEventId: event.id }, chronologyLock)
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

type ReaderCounts = { sameSession: number; crossSession: number }
function directReader(pool: Pool, counts: ReaderCounts): DirectRootTaskHistoryReader {
  const reader = createPgDirectRootTaskHistoryStore(pool)
  return {
    load: input => reader.load(input),
    loadWithClient: async (client, input) => {
      if (input.crossSessionRootTaskHistoryEnabled === true) counts.crossSession += 1
      else counts.sameSession += 1
      return reader.loadWithClient(client, input)
    },
  }
}

function contextBuilder(pool: Pool, scenario: Scenario, counts: ReaderCounts) {
  return createCanonicalTurnContextBuilder({ pool, store: createPgInputClaimStore(pool, scenario.scope), scope: scenario.scope,
    lease: scenario.lease, rootTaskId: scenario.rootTaskId, rootAttemptCount: 1, turnInput: scenario.turnInput,
    rootTaskObjective: { goal: OBJECTIVE, successCriteria: CRITERIA }, planningEnabled: true, selectedJobMode: false,
    crossSessionRootTaskHistoryEnabled: true, rootTaskHistoryDirectReader: directReader(pool, counts),
    currentRootBudgetReader: async () => UNAVAILABLE_BUDGET })
}

async function buildContext(pool: Pool, scenario: Scenario, counts: ReaderCounts) {
  const builder = contextBuilder(pool, scenario, counts), now = new Date()
  return builder.build({ scope: scenario.scope, sessionId: scenario.sessionId, turnId: scenario.turnId, stepId: scenario.stepId,
    snapshot: EMPTY_SNAPSHOT, now, lease: { ownerId: scenario.lease.ownerId, leaseVersion: scenario.lease.leaseVersion, now } })
}

function engineStore(): TurnEngineStore {
  return {
    startStep: async input => ({ id: input.stepId, ordinal: input.ordinal }),
    updateStep: async () => undefined,
    createItem: async input => ({ id: input.itemId, revision: 0 }),
    updateItem: async input => ({ id: input.itemId, revision: input.expectedRevision + 1 }),
    appendEvent: async input => ({ id: input.id }),
    recordFinalResponse: async () => undefined,
  }
}

function failingClosedEngine(pool: Pool, scenario: Scenario) {
  const counts: ReaderCounts = { sameSession: 0, crossSession: 0 }
  const builder = contextBuilder(pool, scenario, counts)
  const stream = vi.fn<ModelAdapter["stream"]>(() => { throw new Error("provider stream must not run before history verification") })
  const model: ModelAdapter = { id: "objective-snapshot-test", profile: {
    provider: "fixture", model: "fixture", nativeTools: false, structuredOutput: false, streaming: true, continuationCursor: false,
    supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
    supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
    maxContextTokens: null, maxOutputTokens: null, costClass: "low",
  }, stream }
  const contextBuilderForEngine: TurnEngineOptions["contextBuilder"] = { build: request => {
    const now = request.now ?? new Date()
    return builder.build({ scope: request.scope, sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId,
      snapshot: request.snapshot, now,
      lease: { ownerId: scenario.lease.ownerId, leaseVersion: scenario.lease.leaseVersion, now }, taskId: request.taskId })
  } }
  const engine = new TurnEngine({ lease: scenario.lease, scope: scenario.scope, goal: OBJECTIVE, snapshot: EMPTY_SNAPSHOT,
    contextBuilder: contextBuilderForEngine, store: engineStore(), model, tools: [], rootTaskId: scenario.rootTaskId,
    executeTool: async () => { throw new Error("unexpected tool call") }, maxSteps: 1,
    idFactory: scoped => scoped.endsWith(":step:0") ? scenario.stepId : `${scoped}:${randomUUID()}` })
  return { run: () => engine.run(), stream, counts }
}

async function snapshotEvent(pool: Pool, sessionId: string) {
  const rows = await pool.query<Record<string, unknown>>(`SELECT "id","sequence","idempotencyKey","payload" FROM "agent_events"
    WHERE "sessionId"=$1 AND "type"=$2`, [sessionId, ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE])
  return rows.rows
}

async function cleanup(pool: Pool, scenario: Scenario): Promise<void> {
  const sessionIds = [scenario.sessionId, scenario.foreignSessionId, scenario.sourceSessionId]
  await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId"=ANY($1::text[])`, [sessionIds]).catch(() => undefined)
  await pool.query(`DELETE FROM "User" WHERE "id"=$1`, [scenario.userId]).catch(() => undefined)
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
let pool: Pool | undefined
const scenarios: Scenario[] = []

describePg("root task history objective snapshot PostgreSQL durability", () => {
  beforeAll(async () => { pool = new Pool({ connectionString: databaseUrl!, max: 6 }) })
  afterEach(async () => { while (scenarios.length) await cleanup(pool!, scenarios.pop()!) })
  afterAll(async () => { await pool?.end() })

  it("commits a non-empty snapshot and replays it from a new connection without reloading prior outcomes", async () => {
    const fixture = await createScenario(pool!, true); scenarios.push(fixture)
    const reads: ReaderCounts = { sameSession: 0, crossSession: 0 }
    const firstContext = await buildContext(pool!, fixture, reads)
    const firstEvents = await snapshotEvent(pool!, fixture.sessionId)
    expect(firstEvents).toHaveLength(1)
    expect(firstContext.blocks.find(block => block.id === "observation:root-task-history")?.content).toMatchObject({
      historical: true, turns: [{ nodes: [{ templateId: "analyst", status: "completed" }] }],
    })
    const storedPayload = firstEvents[0]?.payload as Record<string, unknown>
    expect(storedPayload.outcomes).toMatchObject([{ sourceTurnId: fixture.sourceTurnId, sourceRootTaskId: fixture.sourceRootTaskId,
      sourceSessionDiffers: true, taskGraph: { nodes: [{ templateId: "analyst", status: "completed" }] } }])
    const serialized = JSON.stringify(storedPayload)
    expect(serialized).not.toMatch(/PRIVATE_SOURCE_(NODE_GOAL|CRITERION|RESULT)/)
    const outbox = await pool!.query<Record<string, unknown>>(`SELECT "id","topic","aggregateId","idempotencyKey","payload"
      FROM "agent_outbox" WHERE "id"=$1`, [`agent-outbox-${String(firstEvents[0]?.id)}`])
    expect(outbox.rows).toHaveLength(1)
    expect(outbox.rows[0]).toMatchObject({ topic: "agent.events", aggregateId: fixture.sessionId,
      idempotencyKey: `agent-event:${String(firstEvents[0]?.id)}` })
    expect((outbox.rows[0]?.payload as Record<string, unknown>).payload).toEqual(storedPayload)
    expect(reads.crossSession).toBe(1)

    const firstPid = Number((await pool!.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]?.pid)
    const replayPool = new Pool({ connectionString: databaseUrl!, max: 2 })
    try {
      const replayPid = Number((await replayPool.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]?.pid)
      expect(replayPid).not.toBe(firstPid)
      const replayContext = await buildContext(replayPool, fixture, reads)
      expect(replayContext.blocks.find(block => block.id === "observation:root-task-history")?.content)
        .toEqual(firstContext.blocks.find(block => block.id === "observation:root-task-history")?.content)
      expect(reads.crossSession).toBe(1)
      expect(await snapshotEvent(replayPool, fixture.sessionId)).toHaveLength(1)
    } finally { await replayPool.end() }
  })

  it("commits and replays an immutable empty snapshot when no prior Root is eligible", async () => {
    const fixture = await createScenario(pool!, false); scenarios.push(fixture)
    const reads: ReaderCounts = { sameSession: 0, crossSession: 0 }
    await buildContext(pool!, fixture, reads)
    const first = await snapshotEvent(pool!, fixture.sessionId)
    expect(first).toHaveLength(1)
    expect((first[0]?.payload as Record<string, unknown>).outcomes).toEqual([])
    const sequenceBeforeReplay = (await pool!.query<{ eventSequence: string }>(`SELECT "eventSequence"::text AS "eventSequence" FROM "agent_sessions" WHERE "id"=$1`, [fixture.sessionId])).rows[0]?.eventSequence
    const replayPool = new Pool({ connectionString: databaseUrl!, max: 1 })
    try {
      const before = reads.crossSession
      await buildContext(replayPool, fixture, reads)
      expect(reads.crossSession).toBe(before)
      expect(await snapshotEvent(replayPool, fixture.sessionId)).toHaveLength(1)
      expect((await replayPool.query<{ eventSequence: string }>(`SELECT "eventSequence"::text AS "eventSequence" FROM "agent_sessions" WHERE "id"=$1`, [fixture.sessionId])).rows[0]?.eventSequence)
        .toBe(sequenceBeforeReplay)
    } finally { await replayPool.end() }
  })

  it("rolls back authorization, snapshot event, outbox, and sequence together", async () => {
    const fixture = await createScenario(pool!, true); scenarios.push(fixture)
    const before = (await pool!.query<{ eventSequence: string }>(`SELECT "eventSequence"::text AS "eventSequence" FROM "agent_sessions" WHERE "id"=$1`, [fixture.sessionId])).rows[0]?.eventSequence
    const reader = createPgDirectRootTaskHistoryStore(pool!)
    const client = await pool!.connect()
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
      const request: DirectRootTaskHistoryLoadInput = { lease: fixture.lease, rootTaskId: fixture.rootTaskId,
        rootAttemptCount: 1, stepId: fixture.stepId, now: new Date(), crossSessionRootTaskHistoryEnabled: true }
      const result = await withRootTaskHistorySessionAuthorization(client, { scope: fixture.scope, lease: fixture.lease,
        rootTaskId: fixture.rootTaskId, rootAttemptCount: 1, stepId: fixture.stepId, environmentGateEnabled: true },
      async (transactionClient, authorization, historyReadAllowed) => {
        expect(historyReadAllowed).toBe(true)
        const steerEvidence = await readRootTaskHistorySteerEvidence(transactionClient, fixture.scope, {
          sessionId: fixture.sessionId, turnId: fixture.turnId, stepId: fixture.stepId,
          lease: { ownerId: fixture.lease.ownerId, leaseVersion: fixture.lease.leaseVersion, now: request.now },
        })
        const fence = await readRootTaskHistoryFence(transactionClient, request)
        if (!fence) throw new Error("Current objective fence was unavailable")
        return withRootTaskHistoryObjectiveSnapshot({ client: transactionClient, lease: fixture.lease,
          rootTaskId: fixture.rootTaskId, authorization, fence, acceptedInputRevision: 0n, steerEvidence,
          loadOutcomes: async historyClient => (await reader.loadWithClient!(historyClient as PoolClient, request))
            .filter(outcome => outcome.sourceSessionDiffers === true) })
      })
      expect(result.workResult?.reused).toBe(false)
      expect(result.workResult?.outcomes).toHaveLength(1)
      await client.query("ROLLBACK")
      expect(await snapshotEvent(pool!, fixture.sessionId)).toHaveLength(0)
      expect((await pool!.query(`SELECT 1 FROM "agent_events" WHERE "sessionId"=$1 AND "type"='agent.plan.root_task_history_session_authorization'`, [fixture.sessionId])).rows)
        .toHaveLength(0)
      expect((await pool!.query(`SELECT 1 FROM "agent_outbox" WHERE "aggregateId"=$1
        AND "payload"->>'type' IN ('agent.plan.root_task_history_session_authorization','agent.plan.root_task_history_memory_snapshot')`,
      [fixture.sessionId])).rows).toHaveLength(0)
      expect((await pool!.query<{ eventSequence: string }>(`SELECT "eventSequence"::text AS "eventSequence" FROM "agent_sessions" WHERE "id"=$1`, [fixture.sessionId])).rows[0]?.eventSequence)
        .toBe(before)
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally { client.release() }
  })

  it("rejects a malformed committed payload before the Turn reaches the provider", async () => {
    const fixture = await createScenario(pool!, true); scenarios.push(fixture)
    await buildContext(pool!, fixture, { sameSession: 0, crossSession: 0 })
    const event = (await snapshotEvent(pool!, fixture.sessionId))[0]!
    await pool!.query(`UPDATE "agent_events" SET "payload"=jsonb_set("payload",'{objectiveDigest}','"tampered"'::jsonb)
      WHERE "id"=$1 AND "sessionId"=$2`, [event.id, fixture.sessionId])
    const runtime = failingClosedEngine(pool!, fixture), result = await runtime.run()
    expect(result).toMatchObject({ status: "failed", errorCode: "persistence_conflict" })
    expect(runtime.stream).not.toHaveBeenCalled()
    expect(runtime.counts.crossSession).toBe(0)
  })

  it("rejects a retained snapshot bound to a foreign session, foreign owner, or root before provider invocation", async () => {
    for (const mutation of ["session", "root"] as const) {
      const fixture = await createScenario(pool!, true); scenarios.push(fixture)
      await buildContext(pool!, fixture, { sameSession: 0, crossSession: 0 })
      const event = (await snapshotEvent(pool!, fixture.sessionId))[0]!
      if (mutation === "session") {
        await pool!.query(`UPDATE "agent_events" SET "sessionId"=$1 WHERE "id"=$2`, [fixture.foreignSessionId, event.id])
      } else {
        await pool!.query(`UPDATE "agent_events" SET "taskId"=$1 WHERE "id"=$2`, [fixture.sourceRootTaskId, event.id])
      }
      const runtime = failingClosedEngine(pool!, fixture), result = await runtime.run()
      expect(result).toMatchObject({ status: "failed", errorCode: "persistence_conflict" })
      expect(runtime.stream).not.toHaveBeenCalled()
    }

    const fixture = await createScenario(pool!, true); scenarios.push(fixture)
    const foreignOwner = await createScenario(pool!, false); scenarios.push(foreignOwner)
    await buildContext(pool!, fixture, { sameSession: 0, crossSession: 0 })
    const event = (await snapshotEvent(pool!, fixture.sessionId))[0]!
    await pool!.query(`UPDATE "agent_events" SET "sessionId"=$1 WHERE "id"=$2`, [foreignOwner.sessionId, event.id])
    const runtime = failingClosedEngine(pool!, fixture), result = await runtime.run()
    expect(result).toMatchObject({ status: "failed", errorCode: "persistence_conflict" })
    expect(runtime.stream).not.toHaveBeenCalled()
  })

  it("rejects a mismatched outbox and a missing outbox on replay", async () => {
    const fixture = await createScenario(pool!, true); scenarios.push(fixture)
    await buildContext(pool!, fixture, { sameSession: 0, crossSession: 0 })
    const event = (await snapshotEvent(pool!, fixture.sessionId))[0]!
    const outboxId = `agent-outbox-${String(event.id)}`
    await pool!.query(`UPDATE "agent_outbox" SET "topic"='agent.invalid' WHERE "id"=$1`, [outboxId])
    const mismatched = failingClosedEngine(pool!, fixture), mismatchResult = await mismatched.run()
    expect(mismatchResult).toMatchObject({ status: "failed", errorCode: "persistence_conflict" })
    expect(mismatched.stream).not.toHaveBeenCalled()

    await pool!.query(`UPDATE "agent_outbox" SET "topic"='agent.events' WHERE "id"=$1`, [outboxId])
    await pool!.query(`DELETE FROM "agent_outbox" WHERE "id"=$1`, [outboxId])
    const missing = failingClosedEngine(pool!, fixture), missingResult = await missing.run()
    expect(missingResult).toMatchObject({ status: "failed", errorCode: "persistence_conflict" })
    expect(missing.stream).not.toHaveBeenCalled()
  })

  it("rejects an orphan dispatch before first write and relies on PostgreSQL uniqueness for duplicate idempotency keys", async () => {
    const fixture = await createScenario(pool!, true); scenarios.push(fixture)
    await buildContext(pool!, fixture, { sameSession: 0, crossSession: 0 })
    const event = (await snapshotEvent(pool!, fixture.sessionId))[0]!
    const eventId = String(event.id)
    await expect(pool!.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor",
      "correlationId","causationId","idempotencyKey","payload")
      VALUES ($1,$2,$3,NULL,$4,$5,'agent.plan.root_task_history_memory_snapshot','orchestrator',$4,NULL,$6,$7::jsonb)`,
    [`${eventId}-duplicate`, fixture.sessionId, fixture.turnId, fixture.rootTaskId, Number(event.sequence) + 1,
      event.idempotencyKey, JSON.stringify(event.payload)])).rejects.toMatchObject({ code: "23505" })

    await pool!.query(`DELETE FROM "agent_events" WHERE "id"=$1 AND "sessionId"=$2`, [eventId, fixture.sessionId])
    const orphan = failingClosedEngine(pool!, fixture), orphanResult = await orphan.run()
    expect(orphanResult).toMatchObject({ status: "failed", errorCode: "persistence_conflict" })
    expect(orphan.stream).not.toHaveBeenCalled()
    expect(await snapshotEvent(pool!, fixture.sessionId)).toHaveLength(0)
    expect((await pool!.query(`SELECT 1 FROM "agent_outbox" WHERE "id"=$1`, [`agent-outbox-${eventId}`])).rows).toHaveLength(1)
  })

  it("denies stale Turn leases and stale Root ownership/status before provider invocation", async () => {
    const fixture = await createScenario(pool!, true); scenarios.push(fixture)
    await pool!.query(`UPDATE "agent_turns" SET "leaseVersion"=2 WHERE "id"=$1 AND "sessionId"=$2`, [fixture.turnId, fixture.sessionId])
    const staleLease = failingClosedEngine(pool!, fixture)
    await expect(staleLease.run()).rejects.toMatchObject({ code: "lease_lost" })
    expect(staleLease.stream).not.toHaveBeenCalled()

    await pool!.query(`UPDATE "agent_turns" SET "leaseVersion"=1 WHERE "id"=$1 AND "sessionId"=$2`, [fixture.turnId, fixture.sessionId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner"=$1 WHERE "id"=$2 AND "sessionId"=$3`,
      [`stale-${fixture.lease.ownerId}`, fixture.rootTaskId, fixture.sessionId])
    const staleRootOwner = failingClosedEngine(pool!, fixture)
    await expect(staleRootOwner.run()).rejects.toMatchObject({ code: "lease_lost" })
    expect(staleRootOwner.stream).not.toHaveBeenCalled()

    await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner"=$1,"status"='failed' WHERE "id"=$2 AND "sessionId"=$3`,
      [fixture.lease.ownerId, fixture.rootTaskId, fixture.sessionId])
    const staleRoot = failingClosedEngine(pool!, fixture)
    await expect(staleRoot.run()).rejects.toMatchObject({ code: "lease_lost" })
    expect(staleRoot.stream).not.toHaveBeenCalled()
  })
})
