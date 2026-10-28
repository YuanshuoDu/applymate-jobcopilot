import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
// @ts-expect-error Worker Vitest supplies the Web alias for this cross-workspace race proof.
import { setAgentTaskHistoryMemoryConsent } from "@/lib/agent-task-history-memory-consent"
import { withRootTaskHistorySessionAuthorization } from "./root-task-history-session-memory.js"
import type { TurnLease } from "../turns/lease.js"

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
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
      const callback = async () => "should remain unused"
      authorize = withRootTaskHistorySessionAuthorization(pool!, workerInput(fixture), callback)
      await waitForAdvisoryWait(workerApplication)
      await blocker.query("COMMIT")
      const [revoked, result] = await Promise.all([revoke, authorize]) as [unknown, Awaited<typeof authorize>]
      expect(revoked).toMatchObject({ kind: "updated", consent: { enabled: false, version: 2 } })
      expect(result).toMatchObject({ historyReadAllowed: false, authorization: { consentEnabled: false, consentVersion: 2 } })
      expect(await countMarkers(sessionId)).toMatchObject({ events: "1", outboxes: "1", eventSequence: "1" })
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined)
      blocker.release()
      await Promise.allSettled([...(revoke ? [revoke] : []), ...(authorize ? [authorize] : [])])
    }

    const failedUser = await createUser(), failedSession = await createSession(failedUser), failedFixture = await createTurn(failedUser, failedSession)
    await setConsent(failedUser, true, 0)
    await expect(withRootTaskHistorySessionAuthorization(pool!, workerInput(failedFixture), async () => {
      throw new Error("simulate context snapshot failure")
    })).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(await countMarkers(failedSession)).toMatchObject({ events: "0", outboxes: "0", eventSequence: "0" })
  })

  it("pins before revoke when Worker owns the lock, and disables a later Session", async () => {
    const userId = await createUser(), sessionId = await createSession(userId), first = await createTurn(userId, sessionId)
    await setConsent(userId, true, 0)
    const entered = deferred<void>(), release = deferred<void>()
    const authorization = withRootTaskHistorySessionAuthorization(pool!, workerInput(first), async () => {
      entered.resolve(); await release.promise; return "authorized while lock held"
    })
    await entered.promise
    const revocation = setConsent(userId, false, 1)
    await waitForAdvisoryWait(prismaApplication)
    release.resolve()
    const [result, revoked] = await Promise.all([authorization, revocation])
    expect(result).toMatchObject({ historyReadAllowed: true, historyResult: "authorized while lock held",
      authorization: { consentEnabled: true, consentVersion: 1 } })
    expect(revoked).toMatchObject({ kind: "updated", consent: { enabled: false, version: 2 } })

    const laterSession = await createSession(userId), later = await createTurn(userId, laterSession)
    const laterResult = await withRootTaskHistorySessionAuthorization(pool!, workerInput(later), async () => "must not read")
    expect(laterResult).toMatchObject({ historyReadAllowed: false, authorization: { consentEnabled: false, consentVersion: 2 } })
    expect(await countMarkers(laterSession)).toMatchObject({ events: "1", outboxes: "1", eventSequence: "1" })
  })
})
