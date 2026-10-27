import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"

type ControlIdentity = { userId: string; sessionId: string; turnId: string; recoveryClaimToken: string }

const coordinators = vi.hoisted(() => {
  const calls: Array<{ sessionId: string; claimToken: string; pool: unknown }> = []
  return {
    calls,
    pause: vi.fn(async (pool: unknown, identity: ControlIdentity) => {
      calls.push({ sessionId: identity.sessionId, claimToken: identity.recoveryClaimToken, pool })
      return { state: "paused" as const }
    }),
    resume: vi.fn(async (pool: unknown, identity: ControlIdentity) => {
      calls.push({ sessionId: identity.sessionId, claimToken: identity.recoveryClaimToken, pool })
      return { status: "queued" as const }
    }),
  }
})

vi.mock("./pause-coordinator.js", () => ({
  reconcileSessionPause: coordinators.pause,
  resumeSession: coordinators.resume,
}))

import type { LeasePool } from "../turns/lease.js"
import { reconcilePendingSessionControls, SESSION_CONTROL_RECOVERY_MAX_BATCH } from "./pause-recovery.js"

const CI_DATABASE = "applymate_agent_brain_ci"
const LOCAL_DATABASE = "applymate_session_control_recovery_1001_test"
const FIXED_CREATED_AT = new Date("2001-01-01T00:00:00.000Z")
const FIXED_UPDATED_AT = new Date("2020-06-01T12:30:00.000Z")

function disposableDatabaseUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Required session-control PostgreSQL integration needs its explicitly disposable service URL")
    return null
  }

  const url = new URL(value)
  const database = decodeURIComponent(url.pathname.slice(1))
  const expectedDatabase = process.env.CI === "true" ? CI_DATABASE : LOCAL_DATABASE
  if (
    url.protocol !== "postgresql:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || database !== expectedDatabase
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("Session-control PostgreSQL integration accepts only its named loopback disposable database")
  }
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const schema = `session_control_recovery_1001_${randomUUID().replaceAll("-", "")}`
const pool = databaseUrl ? new PgPool({ connectionString: databaseUrl, max: 2 }) : null

type Candidate = {
  sessionId: string
  userId: string
  turnId: string
  eventId: string
}

type SessionSnapshot = {
  id: string
  status: string
  createdAt: Date
  updatedAt: Date
  marker: Date | null
  claimToken: string | null
  claimExpiresAt: Date | null
}

type EventSnapshot = {
  id: string
  sessionId: string
  turnId: string
  sequence: string
  actor: string
  taskId: string | null
  itemId: string | null
  correlationId: string
  causationId: string | null
  idempotencyKey: string
  type: string
  payload: { turnId: string }
}

type TurnSnapshot = { id: string; sessionId: string; status: string; revision: number }

type Deferred = { promise: Promise<void>; resolve: () => void }
type Outcome<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function withinFiveSeconds<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5_000) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    value => ({ status: "fulfilled", value }),
    reason => ({ status: "rejected", reason }),
  )
}

function requiredPool(): PgPool {
  if (!pool) throw new Error("Disposable PostgreSQL pool is unavailable")
  return pool
}

async function withSchemaClient<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await requiredPool().connect()
  try {
    await client.query(`SET search_path TO "${schema}"`)
    return await action(client)
  } finally {
    client.release()
  }
}

function makeCandidates(prefix: string, count: number): Candidate[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(3, "0")
    return {
      sessionId: `${prefix}-session-${suffix}`,
      userId: `${prefix}-user-${suffix}`,
      turnId: `${prefix}-turn-${suffix}`,
      eventId: `${prefix}-event-${suffix}`,
    }
  })
}

async function insertCandidates(candidates: Candidate[]): Promise<void> {
  await withSchemaClient(async client => {
    const sessionIds = candidates.map(candidate => candidate.sessionId)
    const userIds = candidates.map(candidate => candidate.userId)
    await client.query(
      `INSERT INTO "agent_sessions" ("id", "userId", "status", "createdAt", "updatedAt")
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::timestamp[], $5::timestamp[])`,
      [sessionIds, userIds, candidates.map(() => "pausing"), candidates.map(() => FIXED_CREATED_AT), candidates.map(() => FIXED_UPDATED_AT)],
    )
    await client.query(
      `INSERT INTO "agent_turns" ("id", "sessionId", "userId")
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])`,
      [candidates.map(candidate => candidate.turnId), sessionIds, userIds],
    )
    await client.query(
      `INSERT INTO "agent_events" (
         "id", "sessionId", "turnId", "sequence", "actor", "taskId", "itemId",
         "correlationId", "causationId", "idempotencyKey", "type", "payload"
       )
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[],
         $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::jsonb[]
       )`,
      [
        candidates.map(candidate => candidate.eventId),
        sessionIds,
        candidates.map(candidate => candidate.turnId),
        candidates.map(() => "1"),
        candidates.map(() => "user"),
        candidates.map(() => null),
        candidates.map(() => null),
        candidates.map(candidate => candidate.turnId),
        candidates.map(() => null),
        candidates.map(candidate => `agent-session-control:${candidate.sessionId}`),
        candidates.map(() => "session.pause_requested"),
        candidates.map(candidate => JSON.stringify({ turnId: candidate.turnId })),
      ],
    )
  })
}

async function readSnapshots(sessionIds: string[]): Promise<{ sessions: SessionSnapshot[]; turns: TurnSnapshot[]; events: EventSnapshot[] }> {
  return withSchemaClient(async client => {
    const sessions = await client.query<SessionSnapshot>(
      `SELECT "id", "status", "createdAt", "updatedAt", "sessionControlRecoveryAttemptedAt" AS "marker",
              "sessionControlRecoveryClaimToken" AS "claimToken", "sessionControlRecoveryClaimExpiresAt" AS "claimExpiresAt"
       FROM "agent_sessions" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [sessionIds],
    )
    const turns = await client.query<TurnSnapshot>(
      `SELECT "id", "sessionId", "status", "revision" FROM "agent_turns"
       WHERE "sessionId" = ANY($1::text[]) ORDER BY "id"`,
      [sessionIds],
    )
    const events = await client.query<EventSnapshot>(
      `SELECT "id", "sessionId", "turnId", "sequence"::text AS "sequence", "actor", "taskId", "itemId",
              "correlationId", "causationId", "idempotencyKey", "type", "payload"
       FROM "agent_events" WHERE "sessionId" = ANY($1::text[]) ORDER BY "sessionId", "sequence", "id"`,
      [sessionIds],
    )
    return { sessions: sessions.rows, turns: turns.rows, events: events.rows }
  })
}

function sessionActivity(snapshot: SessionSnapshot[]): Array<{ id: string; status: string; createdAt: string; updatedAt: string }> {
  return snapshot.map(row => ({
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }))
}

function markedIds(snapshot: SessionSnapshot[]): string[] {
  return snapshot.filter(row => row.marker !== null).map(row => row.id)
}

function scannerPool(
  afterClaimSelect?: () => Promise<void>,
  backendPids?: number[],
  onClaimRelease?: (committed: boolean) => void,
): LeasePool {
  return {
    async connect() {
      const client = await requiredPool().connect()
      try {
        await client.query(`SET search_path TO "${schema}"`)
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        if (backendPids) backendPids.push(pid.rows[0]!.pid)
      } catch (error: unknown) {
        client.release()
        throw error
      }

      const originalQuery = client.query.bind(client) as unknown as (sql: string, values?: unknown[]) => Promise<unknown>
      let claimScan = false, committed = false
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await originalQuery(sql, values)
          if (sql === "COMMIT") committed = true
          if (
            sql.includes('SELECT session."userId", session."id" AS "sessionId", control."turnId", session."status"')
            && sql.includes("FOR UPDATE OF session SKIP LOCKED")
          ) {
            claimScan = true
            await afterClaimSelect?.()
          }
          return result
        },
        release() { client.release(); if (claimScan) onClaimRelease?.(committed) },
      } as unknown as PoolClient
    },
  } as unknown as LeasePool
}

describeWithPostgres("session-control recovery on disposable PostgreSQL", () => {
  beforeAll(async () => {
    await requiredPool().query(`CREATE SCHEMA "${schema}"`)
    await withSchemaClient(async client => {
      await client.query(`CREATE TABLE "agent_sessions" (
        "id" text PRIMARY KEY,
        "userId" text NOT NULL,
        "status" text NOT NULL,
        "createdAt" timestamp(3) NOT NULL,
        "updatedAt" timestamp(3) NOT NULL,
        "sessionControlRecoveryAttemptedAt" timestamp(3) NULL,
        "sessionControlRecoveryClaimToken" text NULL,
        "sessionControlRecoveryClaimExpiresAt" timestamp(3) NULL
      )`)
      await client.query(`CREATE TABLE "agent_turns" (
        "id" text PRIMARY KEY,
        "sessionId" text NOT NULL,
        "userId" text NOT NULL,
        "status" text NOT NULL DEFAULT 'queued',
        "revision" integer NOT NULL DEFAULT 0
      )`)
      await client.query(`CREATE TABLE "agent_events" (
        "id" text PRIMARY KEY,
        "sessionId" text NOT NULL,
        "turnId" text NOT NULL,
        "sequence" bigint NOT NULL,
        "actor" text NOT NULL,
        "taskId" text NULL,
        "itemId" text NULL,
        "correlationId" text NOT NULL,
        "causationId" text NULL,
        "idempotencyKey" text NOT NULL,
        "type" text NOT NULL,
        "payload" jsonb NOT NULL
      )`)
    })
  })

  afterAll(async () => {
    if (!pool) return
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await pool.end()
    }
  })

  beforeEach(async () => {
    coordinators.calls.length = 0
    coordinators.pause.mockImplementation(async (scanner, identity) => {
      coordinators.calls.push({ sessionId: identity.sessionId, claimToken: identity.recoveryClaimToken, pool: scanner })
      return { state: "paused" }
    })
    coordinators.resume.mockImplementation(async (scanner, identity) => {
      coordinators.calls.push({ sessionId: identity.sessionId, claimToken: identity.recoveryClaimToken, pool: scanner })
      return { status: "queued" }
    })
    await withSchemaClient(client => client.query('TRUNCATE "agent_events", "agent_turns", "agent_sessions"'))
  })

  it("moves failed batches behind unattempted rows without changing user-visible or event state", async () => {
    const candidates = makeCandidates("rotation", 75)
    const ids = candidates.map(candidate => candidate.sessionId)
    await insertCandidates(candidates)
    const before = await readSnapshots(ids)
    const failure = new Error("coordinator unavailable")
    coordinators.pause.mockImplementation(async (scanner, identity) => {
      coordinators.calls.push({ sessionId: identity.sessionId, claimToken: identity.recoveryClaimToken, pool: scanner })
      throw failure
    })
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)

    try {
      const firstReport = await reconcilePendingSessionControls(scannerPool())
      expect(firstReport).toEqual({ scanned: SESSION_CONTROL_RECOVERY_MAX_BATCH, reconciled: 0, failed: 50 })
      const firstClaimIds = coordinators.calls.map(call => call.sessionId)
      expect(firstClaimIds).toEqual(ids.slice(0, SESSION_CONTROL_RECOVERY_MAX_BATCH))

      const afterFirst = await readSnapshots(ids)
      expect(markedIds(afterFirst.sessions)).toEqual(firstClaimIds)
      expect(afterFirst.sessions.every(row => row.claimToken === null && row.claimExpiresAt === null)).toBe(true)
      expect(sessionActivity(afterFirst.sessions)).toEqual(sessionActivity(before.sessions))
      expect(afterFirst.turns).toEqual(before.turns)
      expect(afterFirst.events).toEqual(before.events)

      const firstMarkers = new Map(afterFirst.sessions.map(row => [row.id, row.marker?.toISOString() ?? null]))
      const secondReport = await reconcilePendingSessionControls(scannerPool())
      expect(secondReport).toEqual({ scanned: 50, reconciled: 0, failed: 50 })
      const secondClaimIds = coordinators.calls.slice(firstClaimIds.length).map(call => call.sessionId)
      expect(secondClaimIds).toEqual([...ids.slice(50), ...ids.slice(0, 25)])
      const allClaimIds = coordinators.calls.map(call => call.sessionId)
      expect(allClaimIds).toEqual([...ids.slice(0, 50), ...ids.slice(50), ...ids.slice(0, 25)])

      const afterSecond = await readSnapshots(ids)
      expect(markedIds(afterSecond.sessions)).toEqual(ids)
      expect(afterSecond.sessions.every(row => row.claimToken === null && row.claimExpiresAt === null)).toBe(true)
      expect(sessionActivity(afterSecond.sessions)).toEqual(sessionActivity(before.sessions))
      expect(afterSecond.turns).toEqual(before.turns)
      expect(afterSecond.events).toEqual(before.events)
      const retriedIds = new Set(ids.slice(0, 25))
      for (const row of afterSecond.sessions) {
        const firstMarker = firstMarkers.get(row.id) ?? null
        if (firstMarker !== null && !retriedIds.has(row.id)) {
          expect(row.marker?.toISOString()).toBe(firstMarkers.get(row.id))
        } else {
          expect(row.marker).toBeInstanceOf(Date)
        }
      }
    } finally {
      log.mockRestore()
    }
  })

  it("keeps a committed claim exclusive while its coordinator runs, then permits expired-token takeover", async () => {
    const [candidate] = makeCandidates("claim-lease", 1)
    if (!candidate) throw new Error("Single session-control recovery candidate is missing")
    await insertCandidates([candidate])
    const before = await readSnapshots([candidate.sessionId])
    const firstEntered = deferred(), releaseFirst = deferred(), takeoverEntered = deferred(), releaseTakeover = deferred()
    let firstScanReleasedAfterCommit = false, holdTakeover = false, firstToken = "", takeoverToken = ""
    let firstPool!: LeasePool, takeoverPool!: LeasePool
    firstPool = scannerPool(undefined, undefined, committed => { firstScanReleasedAfterCommit = committed })
    takeoverPool = scannerPool()
    coordinators.pause.mockImplementation(async (scanner, identity) => {
      coordinators.calls.push({ sessionId: identity.sessionId, claimToken: identity.recoveryClaimToken, pool: scanner })
      if (scanner === firstPool) {
        expect(firstScanReleasedAfterCommit).toBe(true)
        firstToken = identity.recoveryClaimToken
        firstEntered.resolve()
        await releaseFirst.promise
      } else if (scanner === takeoverPool && holdTakeover) {
        takeoverToken = identity.recoveryClaimToken
        takeoverEntered.resolve()
        await releaseTakeover.promise
      }
      return { state: "paused" }
    })

    const firstPromise = settle(reconcilePendingSessionControls(firstPool))
    let takeoverPromise: Promise<Outcome<Awaited<ReturnType<typeof reconcilePendingSessionControls>>>> | undefined
    try {
      await withinFiveSeconds(firstEntered.promise, "First scanner did not reach its coordinator after commit and release")
      expect(firstScanReleasedAfterCommit).toBe(true)
      const claimedByFirst = await readSnapshots([candidate.sessionId])
      expect(claimedByFirst.sessions[0]?.claimToken).toBe(firstToken)
      expect(firstToken).toMatch(/^[0-9a-f-]{36}$/i)

      const whileFirstRuns = await withinFiveSeconds(reconcilePendingSessionControls(takeoverPool), "Second scanner could not finish while the first coordinator was held")
      expect(whileFirstRuns).toEqual({ scanned: 0, reconciled: 0, failed: 0 })
      expect(coordinators.calls.filter(call => call.pool === takeoverPool)).toHaveLength(0)
      const stillOwned = await readSnapshots([candidate.sessionId])
      expect(stillOwned.sessions[0]?.claimToken).toBe(firstToken)

      await withSchemaClient(client => client.query(
        `UPDATE "agent_sessions" SET "sessionControlRecoveryClaimExpiresAt" = NOW() - INTERVAL '1 millisecond' WHERE "id" = $1`,
        [candidate.sessionId],
      ))
      holdTakeover = true
      takeoverPromise = settle(reconcilePendingSessionControls(takeoverPool))
      await withinFiveSeconds(takeoverEntered.promise, "Expired claim was not taken over by the second scanner")
      expect(takeoverToken).not.toBe(firstToken)
      const claimedByTakeover = await readSnapshots([candidate.sessionId])
      expect(claimedByTakeover.sessions[0]?.claimToken).toBe(takeoverToken)

      releaseFirst.resolve()
      const firstResult = await withinFiveSeconds(firstPromise, "First scanner did not finish after becoming stale")
      expect(firstResult).toEqual({ status: "fulfilled", value: { scanned: 1, reconciled: 1, failed: 0 } })
      const afterStaleCleanup = await readSnapshots([candidate.sessionId])
      expect(afterStaleCleanup.sessions[0]?.claimToken).toBe(takeoverToken)
      expect(sessionActivity(afterStaleCleanup.sessions)).toEqual(sessionActivity(before.sessions))
      expect(afterStaleCleanup.turns).toEqual(before.turns)
      expect(afterStaleCleanup.events).toEqual(before.events)

      releaseTakeover.resolve()
      const takeoverResult = await withinFiveSeconds(takeoverPromise, "Takeover scanner did not finish after its coordinator was released")
      expect(takeoverResult).toEqual({ status: "fulfilled", value: { scanned: 1, reconciled: 1, failed: 0 } })
      const afterTakeover = await readSnapshots([candidate.sessionId])
      expect(afterTakeover.sessions[0]?.claimToken).toBeNull()
      expect(afterTakeover.sessions[0]?.claimExpiresAt).toBeNull()
      expect(sessionActivity(afterTakeover.sessions)).toEqual(sessionActivity(before.sessions))
      expect(afterTakeover.turns).toEqual(before.turns)
      expect(afterTakeover.events).toEqual(before.events)
    } finally {
      releaseFirst.resolve()
      releaseTakeover.resolve()
      await firstPromise
      if (takeoverPromise) await takeoverPromise
    }
  }, 15_000)

  it("lets concurrent scanners claim two disjoint 50-row batches through separate locked connections", async () => {
    const candidates = makeCandidates("concurrent", 100)
    const ids = candidates.map(candidate => candidate.sessionId)
    await insertCandidates(candidates)
    const before = await readSnapshots(ids)
    const firstClaimLocked = deferred()
    const releaseFirstClaim = deferred()
    const secondClaimFinished = deferred()
    const backendPids: number[] = []
    const firstPool = scannerPool(async () => {
      firstClaimLocked.resolve()
      await releaseFirstClaim.promise
    }, backendPids)
    const secondPool = scannerPool(() => {
      secondClaimFinished.resolve()
      return Promise.resolve()
    }, backendPids)
    const firstPromise = settle(reconcilePendingSessionControls(firstPool))
    let secondPromise: Promise<Outcome<Awaited<ReturnType<typeof reconcilePendingSessionControls>>>> | undefined
    let waitError: unknown

    try {
      await withinFiveSeconds(firstClaimLocked.promise, "First scanner did not finish its locking SELECT")
      secondPromise = settle(reconcilePendingSessionControls(secondPool))
      await withinFiveSeconds(secondClaimFinished.promise, "Second scanner did not finish its SKIP LOCKED SELECT")
      await withinFiveSeconds(secondPromise, "Second scanner did not commit its recovery claim")
    } catch (error: unknown) {
      waitError = error
    } finally {
      releaseFirstClaim.resolve()
    }

    const firstResult = await withinFiveSeconds(firstPromise, "First scanner did not finish after its claim was released")
    const secondResult = secondPromise ? await withinFiveSeconds(secondPromise, "Second scanner did not finish") : undefined
    if (waitError) throw waitError
    if (firstResult.status !== "fulfilled") throw firstResult.reason
    if (!secondResult) throw new Error("Second scanner result is missing")
    if (secondResult.status !== "fulfilled") throw secondResult.reason

    expect(new Set(backendPids).size).toBe(2)
    expect(firstResult.value).toEqual({ scanned: 50, reconciled: 50, failed: 0 })
    expect(secondResult.value).toEqual({ scanned: 50, reconciled: 50, failed: 0 })

    const firstClaims = coordinators.calls.filter(call => call.pool === firstPool).map(call => call.sessionId)
    const secondClaims = coordinators.calls.filter(call => call.pool === secondPool).map(call => call.sessionId)
    expect(firstClaims).toHaveLength(SESSION_CONTROL_RECOVERY_MAX_BATCH)
    expect(secondClaims).toHaveLength(SESSION_CONTROL_RECOVERY_MAX_BATCH)
    expect(firstClaims.filter(id => secondClaims.includes(id))).toEqual([])

    const after = await readSnapshots(ids)
    expect(markedIds(after.sessions).sort()).toEqual([...firstClaims, ...secondClaims].sort())
    expect(sessionActivity(after.sessions)).toEqual(sessionActivity(before.sessions))
    expect(after.events).toEqual(before.events)
  }, 15_000)
})
