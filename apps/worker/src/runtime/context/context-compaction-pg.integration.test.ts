import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"

import { ContextCompactor } from "./context-compactor.js"
import { executionOwnerFence, type TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnLease } from "../turns/lease.js"
import { completeCompactionItem, createCompactionStartedItem } from "./context-compaction-items.js"
import type { CompactionSource } from "./context-compaction-types.js"
import { createPgCompactionSource } from "./context-compaction-pg-source.js"
import { createPgContextSnapshotCompactionPort } from "./context-snapshot-compaction-pg.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}` || url.search !== "" || url.hash !== "") {
    throw new Error("Context compaction PostgreSQL integration requires the dedicated disposable CI service URL")
  }
  return value
}
const databaseUrl = disposableUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip

type OwnerFixture = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly owner: TurnExecutionOwnerFence
  readonly scope: { readonly userId: string }
}

async function seedOwnerFixture(pool: PgPool): Promise<OwnerFixture> {
  const suffix = randomUUID()
  const userId = `compact-fixture-${suffix}`
  const sessionId = `compact-session-${suffix}`
  const turnId = `compact-turn-${suffix}`
  const taskId = `compact-root-${suffix}`
  const leaseExpiresAt = new Date(Date.now() + 5 * 60_000)
  const lease: TurnLease = { turnId, sessionId, userId, ownerId: `worker-${suffix}`, leaseVersion: 1, leaseStartedAt: new Date(), leaseExpiresAt }
  const fence = executionOwnerFence({ kind: "turn", taskId, lease })
  if (fence.kind !== "turn") throw new Error("Expected a turn execution owner fence")
  try {
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [userId, `${userId}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt") VALUES ($1, $2, 'Find a role', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, userId])
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "contextSnapshotId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, NULL, $5, $6, $7, 1, CURRENT_TIMESTAMP)`, [turnId, sessionId, userId, taskId, fence.ownerId, leaseExpiresAt, lease.leaseStartedAt])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Find a role', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 1, CURRENT_TIMESTAMP)`, [taskId, sessionId, turnId])
    await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [taskId])
  } catch (error: unknown) {
    await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [sessionId]).catch(() => undefined)
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [userId]).catch(() => undefined)
    throw error
  }
  return { userId, sessionId, turnId, taskId, owner: fence, scope: { userId } }
}

function emptySource(fixture: OwnerFixture): CompactionSource {
  return { state: { ownerId: fixture.userId, sessionId: fixture.sessionId, throughSequence: 0n, goal: "Find a role", userConstraints: [], approvals: [], answers: [], artifacts: [], openTasks: [], doNotRepeat: [], facts: [] }, items: [] }
}

describeWithPostgres("PostgreSQL context compaction atomic publisher", () => {
  const suffix = randomUUID()
  const ownerIds = { userId: `compact-${suffix}`, sessionId: `compact-session-${suffix}`, turnId: `compact-turn-${suffix}`, taskId: `compact-root-${suffix}` }
  const expiresAt = new Date(Date.now() + 5 * 60_000)
  const lease: TurnLease = { turnId: ownerIds.turnId, sessionId: ownerIds.sessionId, userId: ownerIds.userId, ownerId: `worker-${suffix}`, leaseVersion: 1, leaseStartedAt: new Date(), leaseExpiresAt: expiresAt }
  const ownerFence = executionOwnerFence({ kind: "turn", taskId: ownerIds.taskId, lease })
  if (ownerFence.kind !== "turn") throw new Error("Expected a turn execution owner fence")
  const owner: TurnExecutionOwnerFence = ownerFence
  const scope = { userId: ownerIds.userId }
  let pool: PgPool | undefined

  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ownerIds.userId, `${ownerIds.userId}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt") VALUES ($1, $2, 'Find a role', 'running', 'test', CURRENT_TIMESTAMP)`, [ownerIds.sessionId, ownerIds.userId])
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "contextSnapshotId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, NULL, $5, $6, $7, 1, CURRENT_TIMESTAMP)`, [ownerIds.turnId, ownerIds.sessionId, ownerIds.userId, ownerIds.taskId, owner.ownerId, expiresAt, lease.leaseStartedAt])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Find a role', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 1, CURRENT_TIMESTAMP)`, [ownerIds.taskId, ownerIds.sessionId, ownerIds.turnId])
    await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ownerIds.taskId])
    await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "content", "completedAt", "updatedAt") VALUES ($1, $2, $3, $4, 'agent_message', 'completed', $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [`tail-${suffix}`, ownerIds.sessionId, ownerIds.turnId, ownerIds.taskId, JSON.stringify({ text: "Useful tail ".repeat(500) })])
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, 1, 'item.completed', 'orchestrator', $4, $6, '{"status":"completed"}'::jsonb)`, [`tail-event-${suffix}`, ownerIds.sessionId, ownerIds.turnId, `tail-${suffix}`, ownerIds.taskId, `tail-event:${suffix}`])
    await pool.query(`UPDATE "agent_sessions" SET "eventSequence" = 1 WHERE "id" = $1`, [ownerIds.sessionId])
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ownerIds.sessionId])
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ownerIds.userId])
      await pool.end()
    }
  })

  it("loads the task-scoped tail and carries the previous summary through two atomic compactions", async () => {
    const sourceAdapter = createPgCompactionSource(pool!)
    const source = await sourceAdapter.load({ scope, owner })
    if (!source) throw new Error("Expected an unpinned turn source")
    expect(source.state.throughSequence).toBe(1n)
    expect(source.items).toMatchObject([{ id: `tail-${suffix}`, type: "agent_message", content: { text: "Useful tail" } }])
    const port = createPgContextSnapshotCompactionPort(pool!, owner)
    const summarizerInputs: string[] = []
    let compactionIndex = 0
    const compactor = new ContextCompactor(port, ({ narrativeText }) => {
      summarizerInputs.push(narrativeText)
      return summarizerInputs.length === 1 ? "Prior narrative summary" : "Cumulative summary includes prior summary and fresh tail"
    }, () => `compaction-${suffix}-${++compactionIndex}`)
    const request = (value: typeof source) => ({
      scope, turnId: owner.turnId, source: value,
      policy: { inputTokenThreshold: 1, itemCountThreshold: 1, compactAtTurnBoundary: true },
      atTurnBoundary: true, requested: true,
    })
    const firstResult = await compactor.compact(request(source))
    if (firstResult.status !== "compacted" || !firstResult.item || !firstResult.snapshot) throw new Error("Expected first compaction to publish")
    const rows = await pool!.query(`SELECT snapshot."version", snapshot."throughSequence", item."status" AS "itemStatus", turn."contextSnapshotId",
        COUNT(DISTINCT event."id") AS "eventCount", COUNT(DISTINCT outbox."id") AS "outboxCount"
      FROM "agent_context_snapshots" AS snapshot
      JOIN "agent_items" AS item ON item."id" = $2
      JOIN "agent_turns" AS turn ON turn."id" = $3
      LEFT JOIN "agent_events" AS event ON event."itemId" = item."id" AND event."type" IN ('item.started', 'item.completed')
      LEFT JOIN "agent_outbox" AS outbox ON outbox."topic" = 'agent.events' AND outbox."idempotencyKey" IN ($4, $5)
      WHERE snapshot."id" = $1 GROUP BY snapshot."version", snapshot."throughSequence", item."status", turn."contextSnapshotId"`, [
      firstResult.snapshot.id, firstResult.item.id, owner.turnId, `agent-event:${firstResult.item.id}:started`, `agent-event:${firstResult.item.id}:completed`,
    ])
    expect(rows.rows[0]).toMatchObject({ version: 1, throughSequence: "1", itemStatus: "completed", contextSnapshotId: null, eventCount: 2, outboxCount: 2 })

    await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "content", "completedAt", "updatedAt") VALUES ($1, $2, $3, $4, 'agent_message', 'completed', $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
      `fresh-tail-${suffix}`, ownerIds.sessionId, ownerIds.turnId, ownerIds.taskId, JSON.stringify({ text: "Fresh tail ".repeat(500) }),
    ])
    const nextSequence = await pool!.query<{ eventSequence: string | number }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`, [ownerIds.sessionId])
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', 'orchestrator', $4, $7, '{"status":"completed"}'::jsonb)`, [
      `fresh-tail-event-${suffix}`, ownerIds.sessionId, ownerIds.turnId, `fresh-tail-${suffix}`, ownerIds.taskId, String(nextSequence.rows[0].eventSequence), `fresh-tail-event:${suffix}`,
    ])
    const secondSource = await sourceAdapter.load({ scope, owner })
    if (!secondSource) throw new Error("Expected the second unpinned turn source")
    expect(secondSource.items.map(({ id, type, sequence }) => ({ id, type, sequence }))).toEqual([
      { id: `context-compaction-summary:${firstResult.snapshot.id}`, type: "compaction_summary", sequence: 1n },
      { id: `fresh-tail-${suffix}`, type: "agent_message", sequence: 4n },
    ])
    expect(secondSource.items[0]?.content).toBe("Prior narrative summary")
    expect((secondSource.items[1]?.content as { text?: string } | undefined)?.text).toContain("Fresh tail")
    const secondResult = await compactor.compact(request(secondSource))
    if (secondResult.status !== "compacted" || !secondResult.snapshot) throw new Error("Expected second compaction to publish")
    expect(summarizerInputs[1]).toContain("Prior narrative summary")
    expect(summarizerInputs[1]).toContain("Fresh tail")
    expect(secondResult.snapshot.version).toBe(2)
    const saved = await pool!.query<{ content: { compaction?: { narrativeSummary?: string } } }>(`SELECT "content" FROM "agent_context_snapshots" WHERE "id" = $1`, [secondResult.snapshot.id])
    expect(saved.rows[0]?.content.compaction?.narrativeSummary).toBe("Cumulative summary includes prior summary and fresh tail")

    await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "content", "completedAt", "updatedAt") VALUES ($1, $2, $3, $4, 'agent_message', 'completed', $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
      `restart-tail-${suffix}`, ownerIds.sessionId, ownerIds.turnId, ownerIds.taskId, JSON.stringify({ text: "Post-compaction tail" }),
    ])
    const restartSequence = await pool!.query<{ eventSequence: string | number }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`, [ownerIds.sessionId])
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', 'orchestrator', $4, $7, '{"status":"completed"}'::jsonb)`, [
      `restart-tail-event-${suffix}`, ownerIds.sessionId, ownerIds.turnId, `restart-tail-${suffix}`, ownerIds.taskId, String(restartSequence.rows[0].eventSequence), `restart-tail-event:${suffix}`,
    ])
    const restartedPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    try {
      const restored = await createPgCompactionSource(restartedPool).load({ scope, owner })
      if (!restored) throw new Error("Expected a source after adapter restart")
      expect(restored.state.throughSequence).toBe(BigInt(restartSequence.rows[0].eventSequence))
      expect(restored.items.map(({ id, type }) => ({ id, type }))).toEqual([
        { id: `context-compaction-summary:${secondResult.snapshot.id}`, type: "compaction_summary" },
        { id: `restart-tail-${suffix}`, type: "agent_message" },
      ])
      expect(restored.items[0]?.content).toBe("Cumulative summary includes prior summary and fresh tail")
      expect((restored.items[1]?.content as { text?: string } | undefined)?.text).toBe("Post-compaction tail")
    } finally {
      await restartedPool.end()
    }
  })

  it("rolls back snapshot and completed lifecycle writes when a conflicting outbox identity exists", async () => {
    const fixture = await seedOwnerFixture(pool!)
    try {
      const source = emptySource(fixture)
      const started = createCompactionStartedItem({ sessionId: fixture.sessionId, turnId: fixture.turnId, throughSequence: 0n, source, reason: "manual", id: `rollback-compaction-${randomUUID()}` })
      const measurement = { beforeInputTokens: 100, afterInputTokens: 20, reductionTokens: 80, reductionRatio: 0.8 }
      const report = { preserved: true, preservedFields: ["goal", "approvals", "answers", "artifact_hashes", "open_tasks", "do_not_repeat"] as const, missingFields: [], changedFields: [], beforeDigest: "before", afterDigest: "after" }
      const completed = completeCompactionItem(started, { summary: "Rollback summary", measurement, report })
      const port = createPgContextSnapshotCompactionPort(pool!, fixture.owner)
      await port.recordStarted(started, fixture.scope)
      const previousSnapshot = await port.loadLatest({ scope: fixture.scope, sessionId: fixture.sessionId })
      const completedKey = `agent-event:${started.id}:completed`
      const conflictingOutboxId = `conflicting-outbox-${randomUUID()}`
      await pool!.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.events', $2, $3, '{"intruder":true}'::jsonb)`, [conflictingOutboxId, fixture.sessionId, completedKey])
      await expect(port.publishAtomically({
        scope: fixture.scope, previousSnapshot,
        draft: { scope: fixture.scope, turnId: fixture.turnId, state: source.state, narrativeSummary: "Rollback summary", tokenMeasurement: measurement, sourceItemIds: [], reason: "manual" },
        startedItem: started, completedItem: completed,
      })).rejects.toThrow("event outbox")

      const snapshots = await pool!.query(`SELECT "id" FROM "agent_context_snapshots" WHERE "sessionId" = $1`, [fixture.sessionId])
      const item = await pool!.query(`SELECT "status", "revision" FROM "agent_items" WHERE "id" = $1`, [started.id])
      const events = await pool!.query(`SELECT "type" FROM "agent_events" WHERE "itemId" = $1 ORDER BY "type"`, [started.id])
      const outbox = await pool!.query(`SELECT "id", "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [completedKey])
      expect(snapshots.rows).toEqual([])
      expect(item.rows[0]).toMatchObject({ status: "started", revision: 0 })
      expect(events.rows).toEqual([{ type: "item.started" }])
      expect(outbox.rows).toEqual([{ id: conflictingOutboxId, payload: { intruder: true } }])
    } finally {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [fixture.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [fixture.userId])
    }
  })

  it("rejects foreign-tenant and stale turn leases in PostgreSQL", async () => {
    const fixture = await seedOwnerFixture(pool!)
    let otherTenant: OwnerFixture | undefined
    try {
      otherTenant = await seedOwnerFixture(pool!)
      const forgedTenantOwner: TurnExecutionOwnerFence = {
        ...otherTenant.owner, sessionId: fixture.sessionId, turnId: fixture.turnId, taskId: fixture.taskId,
        rootTaskId: fixture.taskId, ownerId: fixture.owner.ownerId, leaseVersion: fixture.owner.leaseVersion,
      }
      await expect(createPgCompactionSource(pool!).load({ scope: otherTenant.scope, owner: forgedTenantOwner })).rejects.toThrow("open session")

      const source = emptySource(fixture)
      const started = createCompactionStartedItem({ sessionId: fixture.sessionId, turnId: fixture.turnId, throughSequence: 0n, source, reason: "manual", id: `stale-compaction-${randomUUID()}` })
      const staleVersionPort = createPgContextSnapshotCompactionPort(pool!, { ...fixture.owner, leaseVersion: fixture.owner.leaseVersion + 1 })
      await expect(staleVersionPort.recordStarted(started, fixture.scope)).rejects.toThrow("owned turn")
      await pool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`, [fixture.turnId])
      const expiredPort = createPgContextSnapshotCompactionPort(pool!, fixture.owner)
      await expect(expiredPort.recordStarted(started, fixture.scope)).rejects.toThrow("owned turn")
      const writes = await pool!.query(`SELECT "id" FROM "agent_items" WHERE "id" = $1`, [started.id])
      expect(writes.rows).toEqual([])
    } finally {
      if (otherTenant) {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" IN ($1, $2)`, [fixture.sessionId, otherTenant.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" IN ($1, $2)`, [fixture.userId, otherTenant.userId])
      } else {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [fixture.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [fixture.userId])
      }
    }
  })
})
