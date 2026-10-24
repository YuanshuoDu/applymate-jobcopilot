import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"

// This Web alias is intentionally supplied by the Worker Vitest configuration for the cross-workspace PG proof.
// @ts-expect-error The Worker TypeScript project does not compile Web path aliases; Vitest resolves this test-only import.
import { confirmPersonaFacts, setDiscoveryPersonaFactConsent } from "@/lib/persona-facts"
import {
  DISCOVERY_PERSONA_OVERFLOW_EVENT, DISCOVERY_PERSONA_SNAPSHOT_EVENT, loadOrCreateDiscoveryPersonaSnapshot,
  type DiscoveryPersonaSnapshotResult,
} from "./discovery-persona-facts-pg.js"
import { projectDiscoveryPersonaFacts } from "./discovery-persona-facts.js"
import type { TurnLease } from "../turns/lease.js"

type PersonaField = { key: string; category: string; label: string; value: string; confidence: number; source: string; updatedAt: string }
type PersonaFactRow = {
  id: string; userId: string; key: string; category: string; value: string; normalizedValue: string; source: string
  evidence: unknown; status: string; allowedUses: string[]; consentAt: Date | null; updatedAt: Date; expiresAt: Date | null
}
type WebPrismaClient = {
  $connect(): Promise<void>; $disconnect(): Promise<void>
  user: { create(args: { data: { id: string; email: string } }): Promise<unknown> }
  personaFact: {
    create(args: { data: Omit<PersonaFactRow, "consentAt" | "expiresAt"> & { userId: string; consentAt: Date; expiresAt?: Date } }): Promise<PersonaFactRow>
    findUniqueOrThrow(args: { where: { id: string } }): Promise<PersonaFactRow>
  }
}
const webRequire = createRequire(new URL("../../../../web/package.json", import.meta.url))
const PrismaClient = (webRequire("@prisma/client") as {
  PrismaClient: new (options: { datasources: { db: { url: string } } }) => WebPrismaClient
}).PrismaClient

const DATABASE_NAME = "applymate_agent_brain_ci"
const WAIT_TIMEOUT_MS = 8_000

function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Discovery persona tests need the disposable PostgreSQL CI service")
    return null
  }
  const url = new URL(value)
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Discovery persona tests require the dedicated loopback disposable URL")
  }
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID()
const prismaApplication = `persona-web-${suffix}`
const workerApplication = `persona-worker-${suffix}`
let prisma: WebPrismaClient | undefined
let pool: Pool | undefined
const owners = new Set<string>()
const sessions = new Set<string>()

type Fixture = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; stepId: string
  lease: TurnLease; now: Date
}>

function workerInput(fixture: Fixture) {
  return { scope: { userId: fixture.userId }, lease: fixture.lease, rootTaskId: fixture.rootTaskId,
    rootAttemptCount: 1, stepId: fixture.stepId }
}

function field(key: string, value: string): PersonaField {
  return { key, category: "preferences", label: key, value, confidence: 1, source: "manual", updatedAt: new Date().toISOString() }
}

function consentInput(row: { id: string; key: string; value: string; normalizedValue: string; updatedAt: Date }, enabled: boolean) {
  return { factId: row.id, key: row.key, expectedValue: row.value, expectedNormalizedValue: row.normalizedValue,
    expectedUpdatedAt: row.updatedAt.toISOString(), enabled }
}

async function createOwner(): Promise<string> {
  const id = `discovery-persona-user-${randomUUID()}`
  owners.add(id)
  await prisma!.user.create({ data: { id, email: `${id}@example.invalid` } })
  return id
}

async function createTurn(userId: string, sessionId: string, now = new Date()): Promise<Fixture> {
  const turnId = `discovery-persona-turn-${randomUUID()}`
  const rootTaskId = `discovery-persona-root-${randomUUID()}`
  const stepId = `discovery-persona-step-${randomUUID()}`
  const ownerId = `discovery-persona-owner-${randomUUID()}`
  const expiresAt = new Date(now.getTime() + 5 * 60_000)
  await pool!.query(`INSERT INTO "agent_turns" ("id","sessionId","userId","status","source","input","modelProfileSnapshot",
    "toolPolicySnapshot","budgetSnapshot","rootTaskId","leaseOwnerId","leaseExpiresAt","leaseStartedAt","leaseVersion","updatedAt")
    VALUES ($1,$2,$3,'in_progress','user',$4::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$6,$7,$8,1,$8)`,
  [turnId, sessionId, userId, JSON.stringify({ goal: "Discovery memory test" }), rootTaskId, ownerId, expiresAt, now])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id","sessionId","turnId","rootTaskId","parentTaskId","path","depth","role","taskType","status","goal",
    "constraints","successCriteria","allowedActions","context","expectedOutputSchema","attemptCount","maxAttempts","leaseOwner","leaseExpiresAt","updatedAt")
    VALUES ($1,$2,$3,$1,NULL,$4,0,'orchestrator','root','running','Discovery memory test','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,1,2,$5,$6,$7)`,
  [rootTaskId, sessionId, turnId, `/${rootTaskId}`, ownerId, expiresAt, now])
  await pool!.query(`INSERT INTO "agent_steps" ("id","sessionId","turnId","taskId","ordinal","attempt","status","inputThroughSequence","consumedInputIds","modelProfileSnapshot")
    VALUES ($1,$2,$3,$4,1,1,'streaming',0,'[]'::jsonb,'{}'::jsonb)`, [stepId, sessionId, turnId, rootTaskId])
  return { userId, sessionId, turnId, rootTaskId, stepId,
    lease: { turnId, sessionId, userId, ownerId, leaseVersion: 1, leaseStartedAt: now, leaseExpiresAt: expiresAt }, now }
}

async function createSession(userId: string): Promise<string> {
  const sessionId = `discovery-persona-session-${randomUUID()}`
  sessions.add(sessionId)
  await pool!.query(`INSERT INTO "agent_sessions" ("id","userId","goal","status","source","eventSequence","updatedAt")
    VALUES ($1,$2,'Discovery memory test','running','test',0,CURRENT_TIMESTAMP)`, [sessionId, userId])
  return sessionId
}

async function advanceTurn(current: Fixture): Promise<Fixture> {
  await pool!.query(`UPDATE "agent_steps" SET "status"='completed' WHERE "id"=$1`, [current.stepId])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "status"='completed',"completedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, [current.rootTaskId])
  await pool!.query(`UPDATE "agent_turns" SET "status"='completed',"completedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, [current.turnId])
  return createTurn(current.userId, current.sessionId)
}

async function seedDiscoveryFact(userId: string, key: string, value: string, expiresAt?: Date) {
  return prisma!.personaFact.create({ data: {
    id: `discovery-persona-fact-${randomUUID()}`, userId, key, category: "preferences", value,
    normalizedValue: value.trim().toLowerCase(), source: "manual", evidence: { label: key }, status: "confirmed",
    allowedUses: ["form_fill", "discovery"], consentAt: new Date(), updatedAt: new Date(), ...(expiresAt ? { expiresAt } : {}),
  } })
}

async function beginLockBlocker(userId: string): Promise<PoolClient> {
  const client = await pool!.connect()
  await client.query("BEGIN")
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('applymate:persona-facts:' || $1::text, 0))", [userId])
  return client
}

async function waitForAdvisoryWait(applicationName: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const waiting = await pool!.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pg_stat_activity
      WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory'
        AND query LIKE '%pg_advisory_xact_lock%'`, [applicationName])
    if (Number(waiting.rows[0]?.count) > 0) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${applicationName} to queue on the persona-facts advisory lock`)
}

async function eventRows(sessionId: string) {
  return (await pool!.query<{ type: string; payload: Record<string, unknown>; idempotencyKey: string; turnId: string }>(
    `SELECT "type","payload","idempotencyKey","turnId" FROM "agent_events" WHERE "sessionId"=$1 AND "type"=ANY($2::text[]) ORDER BY "sequence"`,
    [sessionId, [DISCOVERY_PERSONA_SNAPSHOT_EVENT, DISCOVERY_PERSONA_OVERFLOW_EVENT]],
  )).rows
}

async function outboxRows(sessionId: string) {
  return (await pool!.query<{ idempotencyKey: string; payload: Record<string, unknown> }>(
    `SELECT "idempotencyKey","payload" FROM "agent_outbox" WHERE "aggregateId"=$1 AND "topic"='agent.events' ORDER BY "idempotencyKey"`, [sessionId],
  )).rows
}

describePg("discovery persona Worker/Web PostgreSQL serialization", () => {
  beforeAll(async () => {
    const webUrl = new URL(databaseUrl!)
    webUrl.searchParams.set("application_name", prismaApplication)
    prisma = new PrismaClient({ datasources: { db: { url: webUrl.toString() } } })
    pool = new Pool({ connectionString: databaseUrl!, application_name: workerApplication, max: 8 })
    await prisma.$connect()
    await pool.query("SELECT 1")
  })

  afterEach(async () => {
    for (const sessionId of sessions) await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId"=$1`, [sessionId]).catch(() => undefined)
    for (const userId of owners) await pool!.query(`DELETE FROM "User" WHERE "id"=$1`, [userId]).catch(() => undefined)
    owners.clear()
    sessions.clear()
  })

  afterAll(async () => { await prisma?.$disconnect(); await pool?.end() })

  it("snapshots an entire Prisma batch after the writer wins the shared advisory queue", async () => {
    const userId = await createOwner(), sessionId = await createSession(userId), fixture = await createTurn(userId, sessionId)
    const blocker = await beginLockBlocker(userId)
    let write: Promise<unknown> | undefined, read: Promise<DiscoveryPersonaSnapshotResult> | undefined
    try {
      write = confirmPersonaFacts(userId, [field("target_location", "Dublin"), field("salary_expectation", "75000 EUR")], prisma!)
      await waitForAdvisoryWait(prismaApplication)
      read = loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))
      await waitForAdvisoryWait(workerApplication)
      await blocker.query("COMMIT")
      const [, snapshot] = await Promise.all([write, read]) as [unknown, DiscoveryPersonaSnapshotResult]
      expect(snapshot).toMatchObject({ kind: "accepted" })
      if (snapshot.kind !== "accepted") throw new Error("Expected accepted discovery snapshot")
      expect(snapshot.projection.facts.map(fact => fact.key)).toEqual(["salary_expectation", "target_location"])
      expect((await eventRows(sessionId)).map(row => row.type)).toEqual([DISCOVERY_PERSONA_SNAPSHOT_EVENT])
      expect(await outboxRows(sessionId)).toHaveLength(1)
      const later = await advanceTurn(fixture)
      const replay = await loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(later))
      expect(replay).toEqual(snapshot)
      expect((await eventRows(sessionId)).map(row => row.turnId)).toEqual([fixture.turnId])
      expect(await outboxRows(sessionId)).toHaveLength(1)
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined)
      await Promise.all([write, read].filter((value): value is Promise<unknown> => !!value).map(value => value.catch(() => undefined)))
      blocker.release()
    }
  })

  it("keeps a Worker snapshot immutable when purpose-only consent revocation queues behind it", async () => {
    const userId = await createOwner(), sessionId = await createSession(userId), fixture = await createTurn(userId, sessionId)
    const fact = await seedDiscoveryFact(userId, "target_location", "Dublin")
    const blocker = await beginLockBlocker(userId)
    let read: Promise<DiscoveryPersonaSnapshotResult> | undefined, revoke: Promise<unknown> | undefined
    try {
      read = loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))
      await waitForAdvisoryWait(workerApplication)
      revoke = setDiscoveryPersonaFactConsent(userId, consentInput(fact, false), prisma!)
      await waitForAdvisoryWait(prismaApplication)
      await blocker.query("COMMIT")
      const [snapshot, consent] = await Promise.all([read, revoke]) as [DiscoveryPersonaSnapshotResult, unknown]
      expect(snapshot.kind).toBe("accepted")
      if (snapshot.kind !== "accepted") throw new Error("Expected accepted snapshot")
      expect(snapshot.projection.facts.map(entry => entry.factId)).toEqual([fact.id])
      expect(consent).toMatchObject({ kind: "updated", fact: { allowedUses: expect.not.arrayContaining(["discovery"]) } })
      const later = await advanceTurn(fixture)
      expect(await loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(later))).toEqual(snapshot)
      expect((await eventRows(sessionId)).map(row => row.type)).toEqual([DISCOVERY_PERSONA_SNAPSHOT_EVENT])
      expect(await outboxRows(sessionId)).toHaveLength(1)
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined)
      await Promise.all([read, revoke].filter((value): value is Promise<unknown> => !!value).map(value => value.catch(() => undefined)))
      blocker.release()
    }
  })

  it("snapshots no facts when consent revocation reaches the shared lock first", async () => {
    const userId = await createOwner(), sessionId = await createSession(userId), fixture = await createTurn(userId, sessionId)
    const fact = await seedDiscoveryFact(userId, "target_location", "Cork")
    const blocker = await beginLockBlocker(userId)
    let revoke: Promise<unknown> | undefined, read: Promise<unknown> | undefined
    try {
      revoke = setDiscoveryPersonaFactConsent(userId, consentInput(fact, false), prisma!)
      await waitForAdvisoryWait(prismaApplication)
      read = loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))
      await waitForAdvisoryWait(workerApplication)
      await blocker.query("COMMIT")
      const [consent, snapshot] = await Promise.all([revoke, read]) as [Awaited<typeof revoke>, Awaited<typeof read>]
      expect(consent).toMatchObject({ kind: "updated" })
      expect(snapshot).toMatchObject({ kind: "accepted", projection: { facts: [] } })
      const current = await prisma!.personaFact.findUniqueOrThrow({ where: { id: fact.id } })
      expect(await setDiscoveryPersonaFactConsent(userId, consentInput(current, true), prisma!)).toMatchObject({ kind: "updated" })
      const later = await advanceTurn(fixture)
      expect(await loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(later))).toEqual(snapshot)
      expect((await eventRows(sessionId)).map(row => row.type)).toEqual([DISCOVERY_PERSONA_SNAPSHOT_EVENT])
      expect(await outboxRows(sessionId)).toHaveLength(1)
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined)
      await Promise.all([revoke, read].filter((value): value is Promise<unknown> => !!value).map(value => value.catch(() => undefined)))
      blocker.release()
    }
  })

  it("keeps same-Turn overflow stable, then accepts a later bounded set without exposing values", async () => {
    const userId = await createOwner(), sessionId = await createSession(userId), fixture = await createTurn(userId, sessionId)
    const facts = await Promise.all(Array.from({ length: 33 }, (_, index) => seedDiscoveryFact(userId, `skill_${String(index).padStart(2, "0")}`, `PRIVATE_FACT_${index}`)))
    const overflow = await loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))
    expect(overflow).toMatchObject({ kind: "overflow", reason: "fact_limit", observedFactCount: 33, canonicalUtf8Bytes: null })
    const firstEvent = (await eventRows(sessionId))[0]!
    expect(firstEvent.type).toBe(DISCOVERY_PERSONA_OVERFLOW_EVENT)
    expect(JSON.stringify(firstEvent.payload)).not.toContain("PRIVATE_FACT_")
    expect(await outboxRows(sessionId)).toHaveLength(1)
    expect(await setDiscoveryPersonaFactConsent(userId, consentInput(facts[0]!, false), prisma!)).toMatchObject({ kind: "updated" })
    expect(await loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))).toEqual(overflow)
    const later = await advanceTurn(fixture)
    const accepted = await loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(later))
    expect(accepted).toMatchObject({ kind: "accepted" })
    if (accepted.kind !== "accepted") throw new Error("Expected bounded snapshot")
    expect(accepted.projection.facts).toHaveLength(32)
    expect(accepted.projection.facts.some(entry => entry.factId === facts[0]!.id)).toBe(false)
    expect((await eventRows(sessionId)).map(row => row.type)).toEqual([DISCOVERY_PERSONA_OVERFLOW_EVENT, DISCOVERY_PERSONA_SNAPSHOT_EVENT])
    expect(await outboxRows(sessionId)).toHaveLength(2)
    const current = await prisma!.personaFact.findUniqueOrThrow({ where: { id: facts[1]!.id } })
    await setDiscoveryPersonaFactConsent(userId, consentInput(current, false), prisma!)
    const laterAgain = await advanceTurn(later)
    expect(await loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(laterAgain))).toEqual(accepted)
    expect((await eventRows(sessionId)).filter(row => row.type === DISCOVERY_PERSONA_SNAPSHOT_EVENT)).toHaveLength(1)
    expect(await outboxRows(sessionId)).toHaveLength(2)
  })

  it("uses post-lock database time when an eligible fact expires while the Worker waits", async () => {
    const userId = await createOwner(), sessionId = await createSession(userId), fixture = await createTurn(userId, sessionId)
    const expiresAt = new Date(Date.now() + 1_500)
    const fact = await seedDiscoveryFact(userId, "temporary_location", "Private temporary location", expiresAt)
    const blocker = await beginLockBlocker(userId)
    let read: Promise<unknown> | undefined
    try {
      read = loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))
      await waitForAdvisoryWait(workerApplication)
      const stillActive = await pool!.query<{ active: boolean }>(`SELECT "expires_at" > clock_timestamp() AS active FROM "persona_facts" WHERE "id"=$1`, [fact.id])
      expect(stillActive.rows[0]?.active).toBe(true)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 200)))
      await blocker.query("COMMIT")
      expect(await read).toMatchObject({ kind: "accepted", projection: { facts: [] } })
      expect((await eventRows(sessionId)).map(row => row.type)).toEqual([DISCOVERY_PERSONA_SNAPSHOT_EVENT])
      expect(JSON.stringify((await eventRows(sessionId))[0]?.payload)).not.toContain("Private temporary location")
      expect(await outboxRows(sessionId)).toHaveLength(1)
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined)
      await read?.catch(() => undefined)
      blocker.release()
    }
  })

  it("fails closed for foreign ownership and a retained snapshot with a bad digest", async () => {
    const userId = await createOwner(), otherUserId = await createOwner(), sessionId = await createSession(userId)
    const fixture = await createTurn(userId, sessionId)
    await seedDiscoveryFact(userId, "target_location", "Galway")
    await expect(loadOrCreateDiscoveryPersonaSnapshot(pool!, {
      ...workerInput(fixture), scope: { userId: otherUserId }, lease: { ...fixture.lease, userId: otherUserId },
    })).rejects.toMatchObject({ code: "lease_lost" })
    const accepted = await loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))
    expect(accepted.kind).toBe("accepted")
    await pool!.query(`UPDATE "agent_events" SET "payload"=jsonb_set("payload",'{digest}',to_jsonb(repeat('0',64)))
      WHERE "sessionId"=$1 AND "idempotencyKey"=$2`, [sessionId, `discovery-persona-snapshot:${sessionId}:v1`])
    await expect(loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))).rejects.toThrow("Discovery memory could not be verified")
  })

  it("rejects a present valid-looking snapshot key attributed to another owner Turn and Root", async () => {
    const userId = await createOwner(), foreignUserId = await createOwner()
    const sessionId = await createSession(userId), foreignSessionId = await createSession(foreignUserId)
    const fixture = await createTurn(userId, sessionId)
    const foreign = await createTurn(foreignUserId, foreignSessionId)
    const projected = projectDiscoveryPersonaFacts([])
    if (projected.kind !== "accepted") throw new Error("Expected valid empty snapshot fixture")
    const key = `discovery-persona-snapshot:${sessionId}:v1`
    const eventId = `agent-discovery-persona-${createHash("sha256").update(key).digest("hex")}`
    await pool!.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor","correlationId","causationId","idempotencyKey","payload")
      VALUES ($1,$2,$3,NULL,$4,1,$5,'orchestrator',$4,NULL,$6,$7::jsonb)`,
    [eventId, sessionId, foreign.turnId, foreign.rootTaskId, DISCOVERY_PERSONA_SNAPSHOT_EVENT, key, JSON.stringify(projected.payload)])
    await expect(loadOrCreateDiscoveryPersonaSnapshot(pool!, workerInput(fixture))).rejects.toThrow("Discovery memory could not be verified")
    expect((await eventRows(sessionId)).map(row => row.idempotencyKey)).toEqual([key])
    expect((await pool!.query<{ eventSequence: string }>(`SELECT "eventSequence"::text AS "eventSequence" FROM "agent_sessions" WHERE "id"=$1`, [sessionId])).rows[0]?.eventSequence).toBe("0")
    expect(await outboxRows(sessionId)).toHaveLength(0)
  })
})
