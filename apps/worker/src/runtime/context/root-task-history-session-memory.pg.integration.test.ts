import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
// @ts-expect-error Worker Vitest supplies the Web alias for this cross-workspace race proof.
import { setAgentTaskHistoryMemoryConsent } from "@/lib/agent-task-history-memory-consent"
import { withRootTaskHistorySessionAuthorization, type AuthorizedRootTaskHistoryWork } from "./root-task-history-session-memory.js"
import { createPgInputClaimStore, createPgInputClaimTransaction } from "./input-claim-store.js"
import { StepContextBuilder } from "./step-context-builder.js"
import { readRootTaskHistorySteerEvidence } from "./root-task-history-steer-evidence.js"
import { executionOwnerFence, type TurnExecutionOwnerFence } from "../execution-owner.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { releaseTurnLease, type TurnLease } from "../turns/lease.js"
import { readRootTaskHistoryChronologyWitness } from "./root-task-history-chronology-witness.js"
import { updateRootObjectiveHistoryProjection } from "./objective-history-projection.js"
import { readRootTaskHistoryFence, type RootTaskHistoryFenceInput } from "./root-task-history-fence.js"
import { readRootTaskHistoryCandidates } from "./root-task-history-source-store.js"

type WebPrisma = {
  $connect(): Promise<void>; $disconnect(): Promise<void>
  user: { create(args: { data: { id: string; email: string } }): Promise<unknown> }
}
const webRequire = createRequire(new URL("../../../../web/package.json", import.meta.url))
const PrismaClient = (webRequire("@prisma/client") as {
  PrismaClient: new (options: { datasources: { db: { url: string } } }) => WebPrisma
}).PrismaClient
const DATABASE_NAME = "applymate_agent_brain_ci"
const WAIT_TIMEOUT_MS = 8_000
const ACCEPTANCE_APPLICATION = `history-consent-accept-${randomUUID()}`

function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("History consent tests require disposable PostgreSQL")
    return null
  }
  const url = new URL(value)
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) throw new Error("History consent tests require the dedicated loopback disposable URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), prismaApplication = `history-consent-web-${suffix}`, workerApplication = `history-consent-worker-${suffix}`
let prisma: WebPrisma | undefined, pool: Pool | undefined
const users = new Set<string>(), sessions = new Set<string>()
type Fixture = { userId: string; sessionId: string; turnId: string; rootTaskId: string; stepId: string; lease: TurnLease }

function workerInput(fixture: Fixture) {
  return { scope: { userId: fixture.userId }, lease: fixture.lease, rootTaskId: fixture.rootTaskId,
    rootAttemptCount: 1, stepId: fixture.stepId, environmentGateEnabled: true }
}

async function withContextTransaction<T>(fixture: Fixture, work: AuthorizedRootTaskHistoryWork<T>) {
  const client = await pool!.connect()
  let committed = false
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    const result = await withRootTaskHistorySessionAuthorization(client, workerInput(fixture), work)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function createUser(): Promise<string> {
  const id = `history-consent-user-${randomUUID()}`
  users.add(id)
  await prisma!.user.create({ data: { id, email: `${id}@example.invalid` } })
  return id
}

async function createSession(userId: string): Promise<string> {
  const id = `history-consent-session-${randomUUID()}`
  sessions.add(id)
  await pool!.query(`INSERT INTO "agent_sessions" ("id","userId","goal","status","source","eventSequence","updatedAt")
    VALUES ($1,$2,'History consent integration','running','test',0,CURRENT_TIMESTAMP)`, [id, userId])
  return id
}

async function createTurn(userId: string, sessionId: string): Promise<Fixture> {
  const now = new Date(), expires = new Date(now.getTime() + 300_000), turnId = `history-consent-turn-${randomUUID()}`
  const rootTaskId = `history-consent-root-${randomUUID()}`, stepId = `history-consent-step-${randomUUID()}`
  const ownerId = `history-consent-owner-${randomUUID()}`
  await pool!.query(`INSERT INTO "agent_turns" ("id","sessionId","userId","status","source","input","modelProfileSnapshot",
    "toolPolicySnapshot","budgetSnapshot","rootTaskId","leaseOwnerId","leaseExpiresAt","leaseStartedAt","leaseVersion","updatedAt")
    VALUES ($1,$2,$3,'in_progress','user',$4::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$6,$7,$8,1,$8)`,
  [turnId, sessionId, userId, JSON.stringify({ goal: "History consent integration" }), rootTaskId, ownerId, expires, now])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id","sessionId","turnId","rootTaskId","parentTaskId","path","depth","role","taskType","status","goal",
    "constraints","successCriteria","allowedActions","context","expectedOutputSchema","attemptCount","maxAttempts","leaseOwner","leaseExpiresAt","updatedAt")
    VALUES ($1,$2,$3,$1,NULL,$4,0,'orchestrator','root','running','History consent integration','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,1,2,$5,$6,$7)`,
  [rootTaskId, sessionId, turnId, `/${rootTaskId}`, ownerId, expires, now])
  await pool!.query(`INSERT INTO "agent_steps" ("id","sessionId","turnId","taskId","ordinal","attempt","status","inputThroughSequence","consumedInputIds","modelProfileSnapshot")
    VALUES ($1,$2,$3,$4,1,1,'streaming',0,'[]'::jsonb,'{}'::jsonb)`, [stepId, sessionId, turnId, rootTaskId])
  return { userId, sessionId, turnId, rootTaskId, stepId, lease: {
    userId, sessionId, turnId, ownerId, leaseVersion: 1, leaseStartedAt: now, leaseExpiresAt: expires,
  } }
}

async function setConsent(userId: string, enabled: boolean, expectedVersion: number) {
  const result = await setAgentTaskHistoryMemoryConsent(userId, { enabled, expectedVersion },
    prisma as unknown as Parameters<typeof setAgentTaskHistoryMemoryConsent>[2])
  if (result.kind !== "updated") throw new Error(`Consent mutation was ${result.kind}`)
  return result.consent
}

async function waitForAdvisoryWait(application: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await pool!.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pg_stat_activity
      WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory'
        AND query LIKE '%pg_advisory_xact_lock%'`, [application])
    if (Number(result.rows[0]?.count) > 0) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${application} on the history consent advisory lock`)
}

async function waitForBlockedBy(application: string, blockerPid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await pool!.query<{ blocked: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity AS waiter WHERE waiter.application_name=$1 AND waiter.wait_event_type='Lock'
        AND $2::int = ANY(pg_blocking_pids(waiter.pid))) AS blocked`, [application, blockerPid])
    if (result.rows[0]?.blocked) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${application} behind context transaction ${blockerPid}`)
}

async function acceptSteer(fixture: Fixture, id: string, text: string): Promise<bigint> {
  const client = await pool!.connect(), messageId = `${id}-message`
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1,$2,true)", ["application_name", ACCEPTANCE_APPLICATION])
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", fixture.userId])
    await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id"=$1 AND "userId"=$2
      AND "status" NOT IN ('aborted','archived') FOR UPDATE`, [fixture.sessionId, fixture.userId])
    const itemId = `${id}-item`, parts = [{ type: "text", text }]
    const itemContent = { clientMessageId: messageId, disposition: "steered", parts, source: "user" }
    await client.query(`INSERT INTO "agent_items" ("id","sessionId","turnId","type","status","phase","revision","content","startedAt","completedAt","updatedAt")
      VALUES ($1,$2,$3,'user_message','completed','commentary',0,$4::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [itemId, fixture.sessionId, fixture.turnId, JSON.stringify(itemContent)])
    const sequence = (await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence"="eventSequence"+1
      WHERE "id"=$1 AND "userId"=$2 RETURNING "eventSequence"`, [fixture.sessionId, fixture.userId])).rows[0]?.eventSequence
    if (sequence === undefined) throw new Error("Could not allocate accepted steer sequence")
    await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor","correlationId","causationId","idempotencyKey","payload")
      VALUES ($1,$2,$3,$4,NULL,$5,'input.accepted','user',$3,NULL,$6,$7::jsonb)`,
    [`${id}-accepted-event`, fixture.sessionId, fixture.turnId, itemId, sequence, `input.accepted:${messageId}`,
      JSON.stringify({ inputId: id, clientMessageId: messageId, delivery: "steer", disposition: "steered", source: "user" })])
    await client.query(`INSERT INTO "agent_inputs" ("id","sessionId","targetTurnId","userId","clientMessageId","delivery","status","content","acceptedSequence")
      VALUES ($1,$2,$3,$4,$5,'steer','accepted',$6::jsonb,$7)`,
    [id, fixture.sessionId, fixture.turnId, fixture.userId, messageId, JSON.stringify(parts), sequence])
    await client.query("COMMIT")
    return BigInt(sequence)
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function buildAndClassifyContext(client: PoolClient, fixture: Fixture, historyReadAllowed: boolean) {
  const scope = { userId: fixture.userId }, now = new Date()
  const builder = new StepContextBuilder(createPgInputClaimStore(pool!, scope))
  const context = await builder.buildInTransaction(createPgInputClaimTransaction(client, scope), {
    scope, sessionId: fixture.sessionId, turnId: fixture.turnId, stepId: fixture.stepId,
    snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    lease: { ownerId: fixture.lease.ownerId, leaseVersion: fixture.lease.leaseVersion, now }, now,
  })
  const steerEvidence = await readRootTaskHistorySteerEvidence(client, scope, {
    sessionId: fixture.sessionId, turnId: fixture.turnId, stepId: fixture.stepId,
    lease: { ownerId: fixture.lease.ownerId, leaseVersion: fixture.lease.leaseVersion, now },
  })
  return { context, steerEvidence, crossSessionReadAllowed: historyReadAllowed && steerEvidence.kind === "no_accepted_steer" }
}

async function createNextStep(fixture: Fixture): Promise<Fixture> {
  const stepId = `history-consent-step-${randomUUID()}`
  await pool!.query(`INSERT INTO "agent_steps" ("id","sessionId","turnId","taskId","ordinal","attempt","status","inputThroughSequence","consumedInputIds","modelProfileSnapshot")
    VALUES ($1,$2,$3,$4,2,1,'streaming',0,'[]'::jsonb,'{}'::jsonb)`, [stepId, fixture.sessionId, fixture.turnId, fixture.rootTaskId])
  return { ...fixture, stepId }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type PgGate = {
  sessionId: string
  point: "after_begin" | "before_commit"
  reached: ReturnType<typeof deferred<void>>
  resume: ReturnType<typeof deferred<void>>
  backendIdentity?: ReturnType<typeof deferred<{ pid: number; applicationName: string }>>
  rollbackOnCommit?: boolean
  inspection?: ReturnType<typeof deferred<{ events: string; outboxes: string; eventSequence: string } | undefined>>
}

function testPool(applicationName: string, gate?: PgGate): Pick<Pool, "connect"> {
  return {
    async connect() {
      const client = await pool!.connect()
      await client.query("SELECT set_config('application_name',$1,false)", [applicationName])
      let gated = false
      const query = (...args: Parameters<PoolClient["query"]>) => {
        const sql = typeof args[0] === "string" ? args[0] : ""
        if (!gate || gated || !(gate.point === "after_begin" ? sql.startsWith("BEGIN") : sql === "COMMIT")) {
          return client.query(...args)
        }
        gated = true
        if (gate.point === "after_begin") return (async () => {
          const result = await client.query(...args)
          gate.reached.resolve()
          await gate.resume.promise
          return result
        })()
        return (async () => {
          if (gate.rollbackOnCommit) {
            const state = await client.query<{ events: string; outboxes: string; eventSequence: string }>(`SELECT
              (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId"=$1 AND "type"='agent.plan.root_task_history_chronology_witness'
                AND "payload"->>'boundary'='root_terminal') AS events,
              (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "aggregateId"=$1 AND "topic"='agent.events'
                AND "payload"->'payload'->>'boundary'='root_terminal') AS outboxes,
              (SELECT "eventSequence"::text FROM "agent_sessions" WHERE "id"=$1) AS "eventSequence"`, [gate.sessionId])
            gate.inspection?.resolve(state.rows[0])
            await client.query("ROLLBACK")
            gate.reached.resolve()
            throw new Error("intentional chronology transaction rollback")
          }
          const backendResult = await client.query<{ pid: number; applicationName: string }>(`SELECT pg_backend_pid()::int AS pid,
            current_setting('application_name') AS "applicationName"`)
          const backend = backendResult.rows[0]
          gate.backendIdentity?.resolve({ pid: Number(backend?.pid), applicationName: String(backend?.applicationName ?? "") })
          gate.reached.resolve()
          await gate.resume.promise
          return client.query(...args)
        })()
      }
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") return query
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
}

function turnOwner(fixture: Fixture): TurnExecutionOwnerFence {
  const owner = executionOwnerFence({ kind: "turn", taskId: fixture.rootTaskId, lease: fixture.lease })
  if (owner.kind !== "turn") throw new Error("Expected a Turn execution owner")
  return owner
}

async function appendRootTurnStarted(fixture: Fixture, writerPool = testPool(workerApplication)) {
  const key = `turn:${fixture.turnId}:event:turn-started`
  return createPgTurnEngineStore(writerPool as never).appendEvent({
    owner: turnOwner(fixture), id: key, itemId: null, type: "turn.started", correlationId: fixture.turnId,
    causationId: null, idempotencyKey: key,
    payload: { goal: "History consent integration", taskId: fixture.rootTaskId, rootTaskId: fixture.rootTaskId },
  })
}

async function prepareCompletedStep(fixture: Fixture, writerPool = testPool(workerApplication)) {
  const store = createPgTurnEngineStore(writerPool as never), owner = turnOwner(fixture)
  const started = await appendRootTurnStarted(fixture, writerPool)
  const stepStartedKey = `turn:${fixture.turnId}:event:step-started:${fixture.stepId}`
  const stepStarted = await store.appendEvent({
    owner, id: stepStartedKey, itemId: null, type: "step.started", correlationId: fixture.stepId,
    causationId: started.id, idempotencyKey: stepStartedKey,
    payload: { stepId: fixture.stepId, ordinal: 1, taskId: fixture.rootTaskId },
  })
  const now = new Date()
  await store.updateStep({ owner, stepId: fixture.stepId, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now })
  const stepCompletedKey = `turn:${fixture.turnId}:event:step-completed:${fixture.stepId}`
  await store.appendEvent({
    owner, id: stepCompletedKey, itemId: null, type: "step.completed", correlationId: fixture.stepId,
    causationId: stepStarted.id, idempotencyKey: stepCompletedKey,
    payload: { stepId: fixture.stepId, status: "completed", taskId: fixture.rootTaskId },
  })
  return { store, owner, now }
}

async function recordSuccessfulTerminal(fixture: Fixture, store: ReturnType<typeof createPgTurnEngineStore>, owner: ReturnType<typeof turnOwner>, now: Date) {
  const result = await store.recordFinalResponse({
    owner, response: JSON.stringify({ response: "Terminal history fixture" }), now,
    terminal: { stepId: fixture.stepId, finalItemId: `history-final-${fixture.turnId}`,
      finalContent: { text: "Terminal history fixture" }, stepCount: 1, toolCallCount: 0,
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } },
  })
  if (!result || result.status !== "completed") throw new Error("Root TaskGraph terminal writer did not complete")
  const terminal = result.events.find(event => event.type === "turn.completed")
  if (!terminal) throw new Error("Root TaskGraph terminal event is missing")
  return terminal.id
}

async function completeRootTurn(fixture: Fixture, writerPool = testPool(workerApplication)) {
  const { store, owner, now } = await prepareCompletedStep(fixture, writerPool)
  return { eventId: await recordSuccessfulTerminal(fixture, store, owner, now), store, owner, now }
}

async function readCrossSessionCandidates(fixture: Fixture) {
  const input: RootTaskHistoryFenceInput = {
    lease: fixture.lease, rootTaskId: fixture.rootTaskId, rootAttemptCount: 1, stepId: fixture.stepId,
    now: new Date(), crossSessionRootTaskHistoryEnabled: true,
  }
  const result = await withContextTransaction(fixture, async (client, _authorization, allowed) => {
    if (!allowed) throw new Error("Chronology fixture lacks history consent")
    const fence = await readRootTaskHistoryFence(client, input)
    if (!fence) throw new Error("Current Root TaskGraph history fence is missing")
    return { fence, candidates: await readRootTaskHistoryCandidates(client, input, fence) }
  })
  return result.workResult
}

async function readChronologyWitness(input: {
  userId: string; sessionId: string; turnId: string; rootTaskId: string
  boundary: "turn_start" | "root_terminal"; boundaryEventId: string
}) {
  const client = await pool!.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    await client.query("SELECT set_config('app.user_id',$1,true)", [input.userId])
    const result = await readRootTaskHistoryChronologyWitness(client, input)
    await client.query("COMMIT")
    return result
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function setMatchingHistoryObjective(fixture: Fixture): Promise<void> {
  const client = await pool!.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id',$1,true)", [fixture.userId])
    const updated = await client.query(`UPDATE "sub_agent_tasks" SET "successCriteria"=$2::jsonb
      WHERE "id"=$1 AND "sessionId"=$3 AND "turnId"=$4`,
    [fixture.rootTaskId, JSON.stringify(["Find roles matching the candidate's engineering experience"]), fixture.sessionId, fixture.turnId])
    if (updated.rowCount !== 1 || !await updateRootObjectiveHistoryProjection(client, {
      userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId, rootTaskId: fixture.rootTaskId,
    })) throw new Error("History fixture objective projection did not persist")
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function chronologyState(sessionId: string) {
  const result = await pool!.query<{ events: string; outboxes: string; eventSequence: string }>(`SELECT
    (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId"=$1 AND "type"='agent.plan.root_task_history_chronology_witness'
      AND "payload"->>'boundary'='root_terminal') AS events,
    (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "aggregateId"=$1 AND "topic"='agent.events'
      AND "payload"->'payload'->>'boundary'='root_terminal') AS outboxes,
    (SELECT "eventSequence"::text FROM "agent_sessions" WHERE "id"=$1) AS "eventSequence"`, [sessionId])
  return result.rows[0]
}

async function countMarkers(sessionId: string) {
  const rows = await pool!.query<{ events: string; outboxes: string; eventSequence: string }>(`SELECT
    (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId"=$1 AND "type"='agent.plan.root_task_history_session_authorization') AS events,
    (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "aggregateId"=$1 AND "topic"='agent.events') AS outboxes,
    (SELECT "eventSequence"::text FROM "agent_sessions" WHERE "id"=$1) AS "eventSequence"`, [sessionId])
  return rows.rows[0]
}

describePg("root task history Session authorization PostgreSQL serialization", () => {
  beforeAll(async () => {
    const webUrl = new URL(databaseUrl!)
    webUrl.searchParams.set("application_name", prismaApplication)
    prisma = new PrismaClient({ datasources: { db: { url: webUrl.toString() } } })
    pool = new Pool({ connectionString: databaseUrl!, application_name: workerApplication, max: 8 })
    await prisma.$connect(); await pool.query("SELECT 1")
  })
  afterEach(async () => {
    for (const sessionId of sessions) await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId"=$1`, [sessionId]).catch(() => undefined)
    for (const userId of users) await pool!.query(`DELETE FROM "User" WHERE "id"=$1`, [userId]).catch(() => undefined)
    users.clear(); sessions.clear()
  })
  afterAll(async () => { await prisma?.$disconnect(); await pool?.end() })

  it("serializes revocation-first authorization and keeps failed marker writes atomic", async () => {
    const userId = await createUser(), sessionId = await createSession(userId), fixture = await createTurn(userId, sessionId)
    await setConsent(userId, true, 0)
    const blocker: PoolClient = await pool!.connect()
    await blocker.query("BEGIN")
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('applymate:agent-task-history-memory:' || $1::text, 0))", [userId])
    let revoke: Promise<unknown> | undefined, authorize: Promise<unknown> | undefined
    try {
      revoke = setConsent(userId, false, 1)
      await waitForAdvisoryWait(prismaApplication)
      const callback: AuthorizedRootTaskHistoryWork<string> = async (_client, _authorization, allowed) => {
        expect(allowed).toBe(false)
        return "ordinary context still built"
      }
      authorize = withContextTransaction(fixture, callback)
      await waitForAdvisoryWait(workerApplication)
      await blocker.query("COMMIT")
      const [revoked, result] = await Promise.all([revoke, authorize]) as [unknown, Awaited<typeof authorize>]
      expect(revoked).toEqual({ enabled: false, version: 2 })
      expect(result).toMatchObject({ historyReadAllowed: false, workResult: "ordinary context still built",
        authorization: { consentEnabled: false, consentVersion: 2 } })
      expect(await countMarkers(sessionId)).toMatchObject({ events: "1", outboxes: "1", eventSequence: "1" })
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined)
      blocker.release()
      await Promise.allSettled([...(revoke ? [revoke] : []), ...(authorize ? [authorize] : [])])
    }

    const failedUser = await createUser(), failedSession = await createSession(failedUser), failedFixture = await createTurn(failedUser, failedSession)
    await setConsent(failedUser, true, 0)
    await expect(withContextTransaction(failedFixture, async () => {
      throw new Error("simulate context snapshot failure")
    })).rejects.toThrow("simulate context snapshot failure")
    expect(await countMarkers(failedSession)).toMatchObject({ events: "0", outboxes: "0", eventSequence: "0" })
  })

  it("pins before revoke when Worker owns the lock, and disables a later Session", async () => {
    const userId = await createUser(), sessionId = await createSession(userId), first = await createTurn(userId, sessionId)
    await setConsent(userId, true, 0)
    const entered = deferred<void>(), release = deferred<void>()
    const authorization = withContextTransaction(first, async (_client, _authorization, allowed) => {
      expect(allowed).toBe(true)
      entered.resolve(); await release.promise; return "authorized while lock held"
    })
    await entered.promise
    const revocation = setConsent(userId, false, 1)
    await waitForAdvisoryWait(prismaApplication)
    release.resolve()
    const [result, revoked] = await Promise.all([authorization, revocation])
    expect(result).toMatchObject({ historyReadAllowed: true, workResult: "authorized while lock held",
      authorization: { consentEnabled: true, consentVersion: 1 } })
    expect(revoked).toEqual({ enabled: false, version: 2 })

    const laterSession = await createSession(userId), later = await createTurn(userId, laterSession)
    const laterResult = await withContextTransaction(later, async (_client, _authorization, allowed) => {
      expect(allowed).toBe(false)
      return "ordinary context"
    })
    expect(laterResult).toMatchObject({ historyReadAllowed: false, workResult: "ordinary context",
      authorization: { consentEnabled: false, consentVersion: 2 } })
    expect(await countMarkers(laterSession)).toMatchObject({ events: "1", outboxes: "1", eventSequence: "1" })
  })

  it("treats a steer accepted before context claim as a cross-session history barrier", async () => {
    const userId = await createUser(), sessionId = await createSession(userId), fixture = await createTurn(userId, sessionId)
    await setConsent(userId, true, 0)
    const acceptedSequence = await acceptSteer(fixture, `history-consent-before-${randomUUID()}`, "Prefer platform engineering roles.")
    const result = await withContextTransaction(fixture, async (client, _authorization, allowed) => {
      expect(allowed).toBe(true)
      return buildAndClassifyContext(client, fixture, allowed)
    })
    expect(result.historyReadAllowed).toBe(true)
    expect(result.workResult.context.inputThroughSequence).toBe(acceptedSequence)
    expect(result.workResult.context.consumedInputIds).toHaveLength(1)
    expect(result.workResult.steerEvidence).toEqual({ kind: "accepted_steer" })
    expect(result.workResult.crossSessionReadAllowed).toBe(false)
  })

  it("keeps a steer blocked behind context invisible to this Step and visible to the next", async () => {
    const userId = await createUser(), sessionId = await createSession(userId), first = await createTurn(userId, sessionId)
    await setConsent(userId, true, 0)
    const entered = deferred<{ pid: number; result: Awaited<ReturnType<typeof buildAndClassifyContext>> }>()
    const release = deferred<void>()
    let acceptance: Promise<bigint> | undefined
    const current = withContextTransaction(first, async (client, _authorization, allowed) => {
      const pid = Number((await client.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")).rows[0]?.pid)
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Could not read context backend id")
      const result = await buildAndClassifyContext(client, first, allowed)
      entered.resolve({ pid, result })
      await release.promise
      return result
    })
    try {
      const held = await entered.promise
      expect(held.result).toMatchObject({ crossSessionReadAllowed: true, steerEvidence: { kind: "no_accepted_steer" },
        context: { inputThroughSequence: 0n, consumedInputIds: [] } })
      const steerId = `history-consent-blocked-${randomUUID()}`
      acceptance = acceptSteer(first, steerId, "Prioritise jobs with platform ownership.")
      await waitForBlockedBy(ACCEPTANCE_APPLICATION, held.pid)
      release.resolve()
      const [currentResult, acceptedSequence] = await Promise.all([current, acceptance])
      expect(currentResult).toMatchObject({ historyReadAllowed: true,
        workResult: { crossSessionReadAllowed: true, steerEvidence: { kind: "no_accepted_steer" } } })

      const next = await createNextStep(first)
      const later = await withContextTransaction(next, async (client, _authorization, allowed) => {
        expect(allowed).toBe(true)
        return buildAndClassifyContext(client, next, allowed)
      })
      expect(later.historyReadAllowed).toBe(true)
      expect(later.workResult.context.inputThroughSequence).toBe(acceptedSequence)
      expect(later.workResult.context.consumedInputIds).toContain(steerId)
      expect(later.workResult.steerEvidence).toEqual({ kind: "accepted_steer" })
      expect(later.workResult.crossSessionReadAllowed).toBe(false)
    } finally {
      release.resolve()
      await Promise.allSettled([current, ...(acceptance ? [acceptance] : [])])
    }
  })

  it("orders a committed source terminal before a waiting current start and includes the outcome", async () => {
    const userId = await createUser()
    const sourceSession = await createSession(userId), currentSession = await createSession(userId)
    const source = await createTurn(userId, sourceSession), current = await createTurn(userId, currentSession)
    await Promise.all([setMatchingHistoryObjective(source), setMatchingHistoryObjective(current)])
    await setConsent(userId, true, 0)
    const prepared = await prepareCompletedStep(source)
    const sourceApp = `history-chrono-terminal-${suffix}`, currentApp = `history-chrono-start-${suffix}`
    const gate: PgGate = { sessionId: source.sessionId, point: "before_commit", reached: deferred<void>(), resume: deferred<void>() }
    const terminalStore = createPgTurnEngineStore(testPool(sourceApp, gate) as never)
    const terminal = recordSuccessfulTerminal(source, terminalStore, prepared.owner, new Date())
    try {
      await gate.reached.promise
      const currentStart = appendRootTurnStarted(current, testPool(currentApp))
      await waitForAdvisoryWait(currentApp)
      gate.resume.resolve()
      const [terminalEventId, startEvent] = await Promise.all([terminal, currentStart])
      const history = await readCrossSessionCandidates(current)
      expect(history.fence.currentStartWitness).toBeDefined()
      expect(history.candidates.map(candidate => candidate.turnId)).toContain(source.turnId)
      const candidate = history.candidates.find(value => value.turnId === source.turnId)
      expect(BigInt(candidate?.terminalXid8 ?? "0")).toBeLessThan(BigInt(history.fence.currentStartWitness!.xid8))
      expect(await readChronologyWitness({ userId, sessionId: source.sessionId, turnId: source.turnId,
        rootTaskId: source.rootTaskId, boundary: "root_terminal", boundaryEventId: terminalEventId })).toMatchObject({ eventId: expect.any(String) })
      expect(startEvent.id).toBeTruthy()
    } finally {
      gate.resume.resolve()
      await Promise.allSettled([terminal])
    }
  })

  it("excludes a late source terminal whose stale transaction timestamp is earlier", async () => {
    const userId = await createUser()
    const sourceSession = await createSession(userId), currentSession = await createSession(userId)
    const source = await createTurn(userId, sourceSession), current = await createTurn(userId, currentSession)
    await Promise.all([setMatchingHistoryObjective(source), setMatchingHistoryObjective(current)])
    await setConsent(userId, true, 0)
    const prepared = await prepareCompletedStep(source)
    const sourceApp = `history-chrono-late-terminal-${suffix}`, currentApp = `history-chrono-winning-start-${suffix}`
    const gate: PgGate = { sessionId: source.sessionId, point: "after_begin", reached: deferred<void>(), resume: deferred<void>() }
    const terminalStore = createPgTurnEngineStore(testPool(sourceApp, gate) as never)
    const terminal = recordSuccessfulTerminal(source, terminalStore, prepared.owner, new Date())
    try {
      await gate.reached.promise
      await new Promise(resolve => setTimeout(resolve, 25))
      const currentStart = await appendRootTurnStarted(current, testPool(currentApp))
      gate.resume.resolve()
      const terminalEventId = await terminal
      const history = await readCrossSessionCandidates(current)
      expect(history.fence.currentStartWitness).toBeDefined()
      expect(history.candidates.map(candidate => candidate.turnId)).not.toContain(source.turnId)
      const terminalWitness = await readChronologyWitness({ userId, sessionId: source.sessionId, turnId: source.turnId,
        rootTaskId: source.rootTaskId, boundary: "root_terminal", boundaryEventId: terminalEventId })
      expect(terminalWitness).toBeDefined()
      expect(BigInt(terminalWitness!.xid8)).toBeGreaterThan(BigInt(history.fence.currentStartWitness!.xid8))
      const times = await pool!.query<{ terminalAt: Date; currentStartAt: Date }>(`SELECT terminal."createdAt" AS "terminalAt",
        started."createdAt" AS "currentStartAt" FROM "agent_events" AS terminal, "agent_events" AS started
        WHERE terminal."id"=$1 AND started."id"=$2`, [terminalEventId, currentStart.id])
      expect(times.rows[0]?.terminalAt.getTime()).toBeLessThan(times.rows[0]?.currentStartAt.getTime() ?? 0)
    } finally {
      gate.resume.resolve()
      await Promise.allSettled([terminal])
    }
  })

  it("keeps generic failure history ineligible until release writes its terminal witness", async () => {
    const userId = await createUser()
    const sourceSession = await createSession(userId), currentSession = await createSession(userId)
    const source = await createTurn(userId, sourceSession), current = await createTurn(userId, currentSession)
    await Promise.all([setMatchingHistoryObjective(source), setMatchingHistoryObjective(current)])
    await setConsent(userId, true, 0)
    await appendRootTurnStarted(source)
    const failureKey = `turn:${source.turnId}:event:turn-failed:provider_error`
    await createPgTurnEngineStore(testPool(workerApplication) as never).appendEvent({
      owner: turnOwner(source), id: failureKey, itemId: null, type: "turn.failed", correlationId: source.turnId,
      causationId: null, idempotencyKey: failureKey,
      payload: { turnId: source.turnId, taskId: source.rootTaskId, errorCode: "provider_error", finalItemId: null },
    })
    const failedAt = new Date()
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status"='failed',"failureReason"='provider_error',"result"=$1::jsonb,
      "leaseOwner"=NULL,"leaseExpiresAt"=NULL,"completedAt"=$2,"updatedAt"=$2
      WHERE "id"=$3 AND "sessionId"=$4 AND "turnId"=$5 AND "rootTaskId"=$3 AND "status"='running'`,
    [JSON.stringify({ status: "failed", stepCount: 1, toolCallCount: 0, finalItemId: null, waitId: null }), failedAt,
      source.rootTaskId, source.sessionId, source.turnId])
    const pending = await pool!.query<{ turnStatus: string; rootStatus: string; failureEvents: string }>(`SELECT turn."status" AS "turnStatus",
      root."status" AS "rootStatus", (SELECT COUNT(*)::text FROM "agent_events" AS event WHERE event."sessionId"=turn."sessionId"
        AND event."turnId"=turn."id" AND event."taskId"=root."id" AND event."type"='turn.failed') AS "failureEvents"
      FROM "agent_turns" AS turn JOIN "sub_agent_tasks" AS root ON root."id"=turn."rootTaskId"
      WHERE turn."id"=$1 AND turn."sessionId"=$2`, [source.turnId, source.sessionId])
    expect(pending.rows[0]).toMatchObject({ turnStatus: "in_progress", rootStatus: "failed", failureEvents: "1" })
    expect(await readChronologyWitness({ userId, sessionId: source.sessionId, turnId: source.turnId,
      rootTaskId: source.rootTaskId, boundary: "root_terminal", boundaryEventId: failureKey })).toBeUndefined()

    await appendRootTurnStarted(current, testPool(`history-chrono-failure-start-${suffix}`))
    const beforeRelease = await readCrossSessionCandidates(current)
    expect(beforeRelease.candidates.map(candidate => candidate.turnId)).not.toContain(source.turnId)
    expect(await releaseTurnLease(testPool(`history-chrono-failure-release-${suffix}`) as never, source.lease, "failed", new Date())).toBe(true)
    const releasedWitness = await readChronologyWitness({ userId, sessionId: source.sessionId, turnId: source.turnId,
      rootTaskId: source.rootTaskId, boundary: "root_terminal", boundaryEventId: failureKey })
    expect(releasedWitness).toBeDefined()
    expect(BigInt(releasedWitness!.xid8)).toBeGreaterThan(BigInt(beforeRelease.fence.currentStartWitness!.xid8))
    const afterRelease = await readCrossSessionCandidates(current)
    expect(afterRelease.candidates.map(candidate => candidate.turnId)).not.toContain(source.turnId)
  })

  it("makes a same-session failed outcome visible only after its release commits before the next Turn", async () => {
    const userId = await createUser(), sessionId = await createSession(userId)
    const source = await createTurn(userId, sessionId)
    await setMatchingHistoryObjective(source)
    await setConsent(userId, true, 0)
    await appendRootTurnStarted(source)
    const failureKey = `turn:${source.turnId}:event:turn-failed:provider_error`
    const failure = await createPgTurnEngineStore(testPool(workerApplication) as never).appendEvent({
      owner: turnOwner(source), id: failureKey, itemId: null, type: "turn.failed", correlationId: source.turnId,
      causationId: null, idempotencyKey: failureKey,
      payload: { turnId: source.turnId, taskId: source.rootTaskId, errorCode: "provider_error", finalItemId: null },
    })
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status"='failed',"failureReason"='provider_error',"result"=$1::jsonb,
      "leaseOwner"=NULL,"leaseExpiresAt"=NULL,"completedAt"=$2,"updatedAt"=$2
      WHERE "id"=$3 AND "sessionId"=$4 AND "turnId"=$5 AND "rootTaskId"=$3 AND "status"='running'`,
    [JSON.stringify({ status: "failed", stepCount: 1, toolCallCount: 0, finalItemId: null, waitId: null }), new Date(),
      source.rootTaskId, source.sessionId, source.turnId])

    const releaseApp = `history-release-${suffix}`
    const backendIdentity = deferred<{ pid: number; applicationName: string }>()
    const gate: PgGate = { sessionId, point: "before_commit", reached: deferred<void>(), resume: deferred<void>(), backendIdentity }
    const release = releaseTurnLease(testPool(releaseApp, gate) as never, source.lease, "failed", new Date())
    let current: Fixture | undefined
    let currentCreation: Promise<Fixture> | undefined
    try {
      await gate.reached.promise
      const releaseBackend = await backendIdentity.promise
      const releasePid = releaseBackend.pid
      if (!Number.isSafeInteger(releasePid) || releasePid < 1) throw new Error("Could not identify gated release transaction connection")
      expect(releaseBackend.applicationName).toBe(releaseApp)
      currentCreation = createTurn(userId, sessionId)
      await waitForBlockedBy(workerApplication, releasePid)
      gate.resume.resolve()
      const [released, created] = await Promise.all([release, currentCreation])
      expect(released).toBe(true)
      current = created
    } finally {
      gate.resume.resolve()
      await Promise.allSettled([release, ...(currentCreation ? [currentCreation] : [])])
    }
    if (!current) throw new Error("Same-session next Turn was not created after release")
    await setMatchingHistoryObjective(current)
    const currentStart = await appendRootTurnStarted(current)

    const currentHistory = await readCrossSessionCandidates(current)
    const terminalWitness = await readChronologyWitness({ userId, sessionId, turnId: source.turnId,
      rootTaskId: source.rootTaskId, boundary: "root_terminal", boundaryEventId: failure.id })
    expect(terminalWitness).toBeDefined()
    expect(currentHistory.candidates.map(candidate => candidate.turnId)).toContain(source.turnId)
    expect(BigInt(terminalWitness!.xid8)).toBeLessThan(BigInt(currentHistory.fence.currentStartWitness!.xid8))
    const sequences = await pool!.query<{ terminal: string; started: string }>(`SELECT
      (SELECT "sequence"::text FROM "agent_events" WHERE "id"=$1) AS "terminal",
      (SELECT "sequence"::text FROM "agent_events" WHERE "id"=$2) AS "started"`, [failure.id, currentStart.id])
    expect(BigInt(sequences.rows[0]?.terminal ?? "0")).toBeLessThan(BigInt(sequences.rows[0]?.started ?? "0"))
  })

  it("rolls back terminal state, witness, outbox, and sequence together", async () => {
    const userId = await createUser(), sessionId = await createSession(userId), fixture = await createTurn(userId, sessionId)
    const prepared = await prepareCompletedStep(fixture)
    const before = await chronologyState(sessionId)
    const gate: PgGate = { sessionId, point: "before_commit", reached: deferred<void>(), resume: deferred<void>(),
      rollbackOnCommit: true, inspection: deferred<{ events: string; outboxes: string; eventSequence: string } | undefined>() }
    const store = createPgTurnEngineStore(testPool(`history-chrono-rollback-${suffix}`, gate) as never)
    const terminal = recordSuccessfulTerminal(fixture, store, prepared.owner, new Date())
    await gate.reached.promise
    await expect(terminal).rejects.toThrow("intentional chronology transaction rollback")
    expect(await gate.inspection?.promise).toMatchObject({ events: "1", outboxes: "1" })
    expect(await chronologyState(sessionId)).toMatchObject({ events: "0", outboxes: "0", eventSequence: before?.eventSequence })
    const statuses = await pool!.query<{ turnStatus: string; rootStatus: string; terminalEvents: string }>(`SELECT turn."status" AS "turnStatus",
      root."status" AS "rootStatus", (SELECT COUNT(*)::text FROM "agent_events" AS event WHERE event."sessionId"=turn."sessionId"
        AND event."turnId"=turn."id" AND event."type"='turn.completed') AS "terminalEvents"
      FROM "agent_turns" AS turn JOIN "sub_agent_tasks" AS root ON root."id"=turn."rootTaskId" WHERE turn."id"=$1`, [fixture.turnId])
    expect(statuses.rows[0]).toMatchObject({ turnStatus: "in_progress", rootStatus: "running", terminalEvents: "0" })
  })

  it("does not backfill a missing legacy terminal witness during history replay", async () => {
    const userId = await createUser()
    const sourceSession = await createSession(userId), currentSession = await createSession(userId)
    const source = await createTurn(userId, sourceSession), current = await createTurn(userId, currentSession)
    await Promise.all([setMatchingHistoryObjective(source), setMatchingHistoryObjective(current)])
    await setConsent(userId, true, 0)
    const terminalEventId = (await completeRootTurn(source)).eventId
    await appendRootTurnStarted(current)
    const witnessKey = `root-task-history-chronology-witness:root_terminal:${terminalEventId}:v1`
    await pool!.query(`DELETE FROM "agent_outbox" WHERE "idempotencyKey"=(
      SELECT 'agent-event:'||"id" FROM "agent_events" WHERE "sessionId"=$1 AND "idempotencyKey"=$2)` , [source.sessionId, witnessKey])
    await pool!.query(`DELETE FROM "agent_events" WHERE "sessionId"=$1 AND "idempotencyKey"=$2`, [source.sessionId, witnessKey])
    expect(await readChronologyWitness({ userId, sessionId: source.sessionId, turnId: source.turnId,
      rootTaskId: source.rootTaskId, boundary: "root_terminal", boundaryEventId: terminalEventId })).toBeUndefined()
    const history = await readCrossSessionCandidates(current)
    expect(history.candidates.map(candidate => candidate.turnId)).not.toContain(source.turnId)
    expect(await chronologyState(source.sessionId)).toMatchObject({ events: "0", outboxes: "0" })
  })
})
