import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"

import type { LeasePool, TurnJobPayload } from "./lease.js"
import { claimTurnLease } from "./lease.js"
import { persistTurnDispatch } from "./recovery-scanner-storage.js"

function disposableTestUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") {
      throw new Error("AGENT_RUNTIME_PG_TEST_REQUIRED=true needs AGENT_RUNTIME_PG_TEST_URL")
    }
    return null
  }
  const url = new URL(value)
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  const database = decodeURIComponent(url.pathname.slice(1))
  const dedicatedDatabase = process.env.CI === "true"
    ? database === "applymate_agent_brain_ci" && url.port === "5432"
    : database === "applymate_turn_lock_521"
  if (
    url.protocol !== "postgresql:"
    || !loopback
    || url.username !== "postgres"
    || url.search !== ""
    || url.hash !== ""
    || !dedicatedDatabase
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
  ) {
    throw new Error("Turn lock-order PostgreSQL integration requires an explicitly disposable loopback database")
  }
  return value
}

const databaseUrl = disposableTestUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const repeats = 12

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function withinFiveSeconds(promise: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5_000) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

describeWithPostgres("Turn dispatch and claim lock order on disposable PostgreSQL", () => {
  const schema = `turn_lock_${randomUUID().replaceAll("-", "")}`
  const pool = new PgPool({ connectionString: databaseUrl!, max: 8 })
  const appPrefix = `turn521_${process.pid}_${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      await client.query(`CREATE TABLE "agent_sessions" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "status" text NOT NULL
      )`)
      await client.query(`CREATE TABLE "agent_turns" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "userId" text NOT NULL,
        "status" text NOT NULL DEFAULT 'queued', "leaseOwnerId" text,
        "leaseStartedAt" timestamptz, "leaseExpiresAt" timestamptz,
        "leaseVersion" integer NOT NULL DEFAULT 0, "revision" integer NOT NULL DEFAULT 0,
        "startedAt" timestamptz, "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`)
      await client.query(`CREATE TABLE "agent_outbox" (
        "id" text PRIMARY KEY, "topic" text NOT NULL, "aggregateId" text NOT NULL,
        "idempotencyKey" text NOT NULL UNIQUE, "payload" jsonb NOT NULL,
        "publishedAt" timestamptz, "lastError" text, "attemptCount" integer NOT NULL DEFAULT 0
      )`)
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await pool.end()
    }
  })

  function scopedPool(applicationName: string, holdClaim?: { locked: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }): LeasePool {
    return {
      connect: async () => {
        const client = await pool.connect()
        await client.query(`SET search_path TO "${schema}"`)
        await client.query("SELECT set_config('application_name', $1, false)", [applicationName])
        if (!holdClaim) return client
        const originalQuery = client.query.bind(client) as (query: string, values?: unknown[]) => Promise<unknown>
        return {
          query: async (query: string, values?: unknown[]) => {
            const result = await originalQuery(query, values)
            if (query.includes('SELECT session."userId"') && query.includes("FOR UPDATE")) {
              holdClaim.locked.resolve()
              await holdClaim.release.promise
            }
            return result
          },
          release: () => client.release(),
        } as unknown as PoolClient
      },
    } as unknown as LeasePool
  }

  async function waitUntilDispatchIsLockBlocked(applicationName: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const result = await pool.query<{ wait_event_type: string | null; state: string }>(
        `SELECT wait_event_type, state FROM pg_stat_activity WHERE application_name = $1`,
        [applicationName],
      )
      if (result.rows[0]?.state === "active" && result.rows[0]?.wait_event_type === "Lock") return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error("Dispatch did not reach the claim-held session lock within five seconds")
  }

  it(`serializes ${repeats} forced dispatch/claim interleavings without deadlocks`, async () => {
    let deadlocks = 0
    const unexpectedFailures: string[] = []
    let turnLocksHeldByDispatch = 0

    for (let index = 0; index < repeats; index += 1) {
      const sessionId = `session-${index}-${randomUUID()}`
      const turnId = `turn-${index}-${randomUUID()}`
      const userId = `user-${index}`
      const payload: TurnJobPayload = { turnId, sessionId, ownerId: `owner-${index}` }
      const app = `${appPrefix}_${index}`
      await pool.query(`INSERT INTO "${schema}"."agent_sessions" ("id", "userId", "status") VALUES ($1, $2, 'running')`, [sessionId, userId])
      await pool.query(`INSERT INTO "${schema}"."agent_turns" ("id", "sessionId", "userId") VALUES ($1, $2, $3)`, [turnId, sessionId, userId])

      const locked = deferred()
      const release = deferred()
      const claimPromise = claimTurnLease(scopedPool(`${app}_claim`, { locked, release }), payload)
      let dispatchPromise: Promise<void> | undefined
      try {
        await withinFiveSeconds(locked.promise, "Lease claim did not acquire its session lock within five seconds")
        dispatchPromise = persistTurnDispatch(scopedPool(`${app}_dispatch`), payload)
        await waitUntilDispatchIsLockBlocked(`${app}_dispatch`)

        try {
          await pool.query(`SELECT "id" FROM "${schema}"."agent_turns" WHERE "id" = $1 FOR UPDATE NOWAIT`, [turnId])
        } catch (error) {
          if (codeOf(error) === "55P03") turnLocksHeldByDispatch += 1
          else unexpectedFailures.push(`${turnId}: turn-lock probe ${codeOf(error) ?? "unknown error"}`)
        }
      } catch (error) {
        unexpectedFailures.push(`${turnId}: interleaving setup ${codeOf(error) ?? "timeout"}`)
      } finally {
        release.resolve()
      }

      const outcomes = await Promise.allSettled([claimPromise, ...(dispatchPromise ? [dispatchPromise] : [])])
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          const code = codeOf(outcome.reason)
          if (code === "40P01") deadlocks += 1
          else unexpectedFailures.push(`${turnId}: transaction ${code ?? "unknown error"}`)
        }
      }
      if (outcomes.some(outcome => outcome.status !== "fulfilled")) unexpectedFailures.push(`${turnId}: expected both transactions to commit`)
    }

    expect({ turnLocksHeldByDispatch, deadlock40P01: deadlocks, unexpectedFailures },
      "dispatch and claim must serialize session-first with zero PostgreSQL deadlocks").toEqual({
      turnLocksHeldByDispatch: 0,
      deadlock40P01: 0,
      unexpectedFailures: [],
    })
  }, 60_000)
})
