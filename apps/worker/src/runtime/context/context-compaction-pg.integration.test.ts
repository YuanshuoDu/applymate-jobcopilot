import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool as PgPool } from "pg"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"

import { loadCanonicalTurnState } from "../canonical-turn-state.js"
import { buildModelRequest } from "../turns/turn-engine-messages.js"
import { ContextCompactor } from "./context-compactor.js"
import { executionOwnerFence, type TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnLease } from "../turns/lease.js"
import { StepContextBuilder } from "./step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction } from "./input-claim-store.js"
import { completeCompactionItem, createCompactionStartedItem } from "./context-compaction-items.js"
import type { CompactionSource } from "./context-compaction-types.js"
import { snapshotCanonicalJson, snapshotChecksum } from "./context-snapshot-canonical.js"
import { CONTEXT_SNAPSHOT_SCHEMA_VERSION, type AgentContextSnapshot, type ContextSnapshotContent } from "./context-snapshot-types.js"
import { createPgContextSnapshotStore } from "./context-snapshot-store.js"
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
  readonly lease: TurnLease
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
      VALUES ($1, $2, $3, 'in_progress', 'user', '{"goal":"Find a role"}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, NULL, $5, $6, $7, 1, CURRENT_TIMESTAMP)`, [turnId, sessionId, userId, taskId, fence.ownerId, leaseExpiresAt, lease.leaseStartedAt])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Find a role', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 1, CURRENT_TIMESTAMP)`, [taskId, sessionId, turnId])
    await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [taskId])
  } catch (error: unknown) {
    await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [sessionId]).catch(() => undefined)
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [userId]).catch(() => undefined)
    throw error
  }
  return { userId, sessionId, turnId, taskId, lease, owner: fence, scope: { userId } }
}

function emptySource(fixture: OwnerFixture): CompactionSource {
  return { state: { ownerId: fixture.userId, sessionId: fixture.sessionId, throughSequence: 0n, goal: "Find a role", userConstraints: [], approvals: [], answers: [], artifacts: [], openTasks: [], doNotRepeat: [], facts: [] }, items: [] }
}

async function insertCompletedItem(pool: PgPool, fixture: OwnerFixture, label: string, text: string) {
  const allocated = await pool.query<{ eventSequence: string | number }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 RETURNING "eventSequence"`, [fixture.sessionId])
  const sequence = BigInt(allocated.rows[0]?.eventSequence ?? 0)
  if (sequence < 1n) throw new Error("Expected the database to allocate a positive event sequence")
  const id = `${fixture.sessionId}-tail-${randomUUID()}`
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "content", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, 'agent_message', 'completed', $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    id, fixture.sessionId, fixture.turnId, fixture.taskId, JSON.stringify({ text: `${label} ${text}` }),
  ])
  await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', 'orchestrator', $4, $7, '{"status":"completed"}'::jsonb)`, [
    `${id}-completed`, fixture.sessionId, fixture.turnId, id, fixture.taskId, sequence.toString(), `${id}:completed`,
  ])
  return { sequence, id }
}

function occurrenceCount(value: string, marker: string): number {
  return value.split(marker).length - 1
}

function testSnapshot(fixture: OwnerFixture, id: string, throughSequence: bigint, observation: string, version = 1): AgentContextSnapshot {
  const content: ContextSnapshotContent = {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    ownerId: fixture.userId,
    sessionId: fixture.sessionId,
    throughSequence: throughSequence.toString(),
    goal: "Find a role",
    userConstraints: [],
    confirmedDecisions: [],
    completedWork: [],
    openWork: [],
    pendingApprovals: [],
    artifacts: [],
    facts: [],
    failedAttempts: [],
    references: [],
    consumedInputIds: [],
    context: { system: [], profile: [], steerHistory: [], toolObservations: [{ id: "persisted-summary", content: observation }] },
    tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
  }
  const base = { sessionId: fixture.sessionId, throughSequence, version, content }
  return {
    id,
    ...base,
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    summary: observation,
    memorySummary: observation,
    checksum: snapshotChecksum(base),
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    tokenAccounting: content.tokenAccounting,
    canonicalJson: snapshotCanonicalJson(base),
    createdAt: new Date("2026-10-27T00:00:00.000Z"),
  }
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

  it("restores pinned v1 context into a captured model request and rejects a corrupt latest row before invocation", async () => {
    const fixtures: OwnerFixture[] = []
    const requests: HarnessModelRequest[] = []
    const invokeModel = vi.fn((request: HarnessModelRequest) => { requests.push(request) })
    const captureTurnRequest = async (fixture: OwnerFixture) => {
      const state = await loadCanonicalTurnState(pool!, fixture.lease)
      const claimStore: InputClaimStore = {
        scope: fixture.scope,
        async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
          return work({
            getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
            claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
            persistCheckpoint: async () => undefined,
          })
        },
      }
      const stepId = `snapshot-recovery-step-${fixture.turnId}`
      const context = await new StepContextBuilder(claimStore).build({
        scope: fixture.scope,
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        stepId,
        snapshot: state.snapshot,
      })
      const model = { profile: { provider: "test", model: "snapshot-recovery", nativeTools: false, structuredOutput: false, streaming: false, continuationCursor: false } } as unknown as ModelAdapter
      const request = buildModelRequest({
        context, model, tools: [], sessionId: fixture.sessionId, turnId: fixture.turnId, stepId,
        userId: fixture.userId, taskId: fixture.taskId, rootTaskId: fixture.taskId, signal: new AbortController().signal,
      })
      invokeModel(request)
      return request
    }

    try {
      const pinnedFixture = await seedOwnerFixture(pool!)
      fixtures.push(pinnedFixture)
      const valid = testSnapshot(pinnedFixture, `snapshot-valid-${randomUUID()}`, 0n, "POSTGRES_VALID_V1_SUMMARY")
      await createPgContextSnapshotStore(pool!).save(valid, pinnedFixture.scope)
      await pool!.query(`UPDATE "agent_turns" SET "contextSnapshotId" = $1 WHERE "id" = $2`, [valid.id, pinnedFixture.turnId])

      const validRequest = await captureTurnRequest(pinnedFixture)
      const validPrompt = JSON.stringify(validRequest.messages)
      expect(validPrompt).toContain("POSTGRES_VALID_V1_SUMMARY")
      expect(valid.content.compaction).toBeUndefined()
      expect(invokeModel).toHaveBeenCalledTimes(1)

      const latestFixture = await seedOwnerFixture(pool!)
      fixtures.push(latestFixture)
      const fallback = testSnapshot(latestFixture, `snapshot-fallback-${randomUUID()}`, 0n, "POSTGRES_FALLBACK_SUMMARY")
      await createPgContextSnapshotStore(pool!).save(fallback, latestFixture.scope)
      const corruptOriginal = testSnapshot(latestFixture, `snapshot-corrupt-${randomUUID()}`, 1n, "ORIGINAL_SUMMARY", 2)
      const corruptContent: ContextSnapshotContent = {
        ...corruptOriginal.content,
        context: { ...corruptOriginal.content.context, toolObservations: [{ id: "persisted-summary", content: "CORRUPTED_SUMMARY" }] },
      }
      await pool!.query(`INSERT INTO "agent_context_snapshots" ("id", "sessionId", "throughSequence", "version", "schemaVersion", "content", "summary", "checksum", "inputTokens", "outputTokens", "estimatedCostUsd", "tokenAccounting", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, CURRENT_TIMESTAMP)`, [
        corruptOriginal.id, latestFixture.sessionId, corruptOriginal.throughSequence.toString(), corruptOriginal.version,
        corruptOriginal.schemaVersion, JSON.stringify(corruptContent), corruptOriginal.summary, corruptOriginal.checksum,
        corruptOriginal.inputTokens, corruptOriginal.outputTokens, corruptOriginal.estimatedCostUsd.toFixed(8), JSON.stringify(corruptOriginal.tokenAccounting),
      ])
      await pool!.query(`UPDATE "agent_sessions" SET "eventSequence" = 1 WHERE "id" = $1`, [latestFixture.sessionId])

      let caught: unknown
      try {
        await captureTurnRequest(latestFixture)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toMatchObject({ code: "checksum_mismatch" })
      const message = caught instanceof Error ? caught.message : ""
      expect(message).not.toContain("CORRUPTED_SUMMARY")
      expect(message).not.toContain(corruptOriginal.checksum)
      expect(invokeModel).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(requests)).toContain("POSTGRES_VALID_V1_SUMMARY")
      expect(JSON.stringify(requests)).not.toContain("CORRUPTED_SUMMARY")
      expect(JSON.stringify(requests)).not.toContain("POSTGRES_FALLBACK_SUMMARY")
    } finally {
      for (const fixture of fixtures) {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [fixture.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [fixture.userId])
      }
    }
  })

  it("loads the task-scoped tail and carries the previous summary through two atomic compactions", async () => {
    const sourceAdapter = createPgCompactionSource(pool!)
    const source = await sourceAdapter.load({ scope, owner })
    if (!source) throw new Error("Expected an unpinned turn source")
    expect(source.state.throughSequence).toBe(1n)
    expect(source.items).toHaveLength(1)
    expect(source.items[0]).toMatchObject({ id: `tail-${suffix}`, type: "agent_message" })
    expect((source.items[0]?.content as { text?: string } | undefined)?.text).toContain("Useful tail")
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
    expect(rows.rows[0]).toMatchObject({ version: 1, throughSequence: "1", itemStatus: "completed", contextSnapshotId: null, eventCount: "2", outboxCount: "2" })

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

  it("keeps the snapshot cursor aligned to complete narrative groups across capped compactions and reloads", async () => {
    const fixture = await seedOwnerFixture(pool!)
    const reloadPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const verificationPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    try {
      const firstMarker = "first-marker"
      const omittedMarker = "omitted-tail-one"
      const tailMarker = "omitted-tail-marker"
      const firstGroup = await insertCompletedItem(pool!, fixture, firstMarker, "A".repeat(650))
      const omittedGroup = await insertCompletedItem(pool!, fixture, omittedMarker, "B".repeat(200))
      const tailGroup = await insertCompletedItem(pool!, fixture, tailMarker, "D".repeat(200))
      const initial = await createPgCompactionSource(pool!).load({ scope: fixture.scope, owner: fixture.owner })
      if (!initial) throw new Error("Expected a source before the capped compaction")
      expect(initial.state.throughSequence).toBe(tailGroup.sequence)
      expect(initial.items.map(({ sequence }) => sequence)).toEqual([
        firstGroup.sequence, omittedGroup.sequence, tailGroup.sequence,
      ])

      const narrativeInputs: string[] = []
      const summaries = [
        `Summary preserves ${firstMarker}`,
        `Summary preserves ${firstMarker}, ${omittedMarker}, and ${tailMarker}`,
      ]
      const summarize = ({ narrativeText }: { readonly narrativeText: string }) => {
        narrativeInputs.push(narrativeText)
        return summaries[narrativeInputs.length - 1] ?? "Summary preserves newer-marker"
      }
      let compactionIndex = 0
      const compactorFor = (targetPool: PgPool) => new ContextCompactor(
        createPgContextSnapshotCompactionPort(targetPool, fixture.owner), summarize, () => `coverage-${fixture.sessionId}-${++compactionIndex}`,
      )
      const request = (source: CompactionSource) => ({
        scope: fixture.scope, turnId: fixture.turnId, source,
        policy: { inputTokenThreshold: 1, itemCountThreshold: 1, compactAtTurnBoundary: true },
        atTurnBoundary: false, requested: true,
        bounds: { maxNarrativeInputCharacters: 900 },
      })

      const first = await compactorFor(pool!).compact(request(initial))
      if (first.status !== "compacted" || !first.snapshot) throw new Error("Expected the first capped compaction to publish")
      expect(first.snapshot.throughSequence).toBe(firstGroup.sequence)
      expect(narrativeInputs[0]).toContain(firstMarker)
      expect(narrativeInputs[0]).toContain("A".repeat(650))
      expect(narrativeInputs[0]).not.toContain(omittedMarker)
      expect(narrativeInputs[0]).not.toContain(tailMarker)
      const firstSaved = await pool!.query<{ throughSequence: string; stateCursor: string; sourceItemIds: string[] }>(`SELECT "throughSequence",
        "content" #>> '{compaction,state,throughSequence}' AS "stateCursor",
        "content"->'compaction'->'sourceItemIds' AS "sourceItemIds"
        FROM "agent_context_snapshots" WHERE "id" = $1`, [first.snapshot.id])
      expect(firstSaved.rows[0]).toEqual({
        throughSequence: firstGroup.sequence.toString(), stateCursor: firstGroup.sequence.toString(), sourceItemIds: [firstGroup.id],
      })

      const afterFirst = await createPgCompactionSource(reloadPool).load({ scope: fixture.scope, owner: fixture.owner })
      if (!afterFirst) throw new Error("Expected the omitted suffix after a fresh source reload")
      expect(afterFirst.items.map(({ id, type, sequence }) => ({ id, type, sequence }))).toEqual([
        { id: `context-compaction-summary:${first.snapshot.id}`, type: "compaction_summary", sequence: firstGroup.sequence },
        { id: omittedGroup.id, type: "agent_message", sequence: omittedGroup.sequence },
        { id: tailGroup.id, type: "agent_message", sequence: tailGroup.sequence },
      ].sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : left.id.localeCompare(right.id)))
      expect(afterFirst.items[0]?.content).toBe(summaries[0])
      expect(afterFirst.state.throughSequence).toBe(tailGroup.sequence)
      const reloadedTailText = afterFirst.items.map(item => JSON.stringify(item.content)).join("\n")
      for (const marker of [firstMarker, omittedMarker, tailMarker]) expect(occurrenceCount(reloadedTailText, marker)).toBe(1)
      expect(afterFirst.items.filter(item => item.type !== "compaction_summary")).toHaveLength(2)

      const second = await compactorFor(reloadPool).compact(request(afterFirst))
      if (second.status !== "compacted" || !second.snapshot) throw new Error("Expected the second compaction to incorporate the omitted suffix")
      expect(second.snapshot.throughSequence).toBe(tailGroup.sequence)
      for (const marker of [firstMarker, omittedMarker, tailMarker]) expect(occurrenceCount(narrativeInputs[1] ?? "", marker)).toBe(1)
      expect(narrativeInputs[1]).toContain(summaries[0])
      const secondSaved = await reloadPool.query<{ throughSequence: string; stateCursor: string; sourceItemIds: string[] }>(`SELECT "throughSequence",
        "content" #>> '{compaction,state,throughSequence}' AS "stateCursor",
        "content"->'compaction'->'sourceItemIds' AS "sourceItemIds"
        FROM "agent_context_snapshots" WHERE "id" = $1`, [second.snapshot.id])
      expect(secondSaved.rows[0]?.throughSequence).toBe(tailGroup.sequence.toString())
      expect(secondSaved.rows[0]?.stateCursor).toBe(tailGroup.sequence.toString())
      expect(secondSaved.rows[0]?.sourceItemIds?.slice().sort()).toEqual(afterFirst.items.map(({ id }) => id).sort())

      const newerMarker = "newer-marker"
      const newerGroup = await insertCompletedItem(reloadPool, fixture, newerMarker, "E".repeat(100))
      const afterSecond = await createPgCompactionSource(verificationPool).load({ scope: fixture.scope, owner: fixture.owner })
      if (!afterSecond) throw new Error("Expected a source after the second fresh reload")
      expect(afterSecond.state.throughSequence).toBe(newerGroup.sequence)
      expect(afterSecond.items.map(({ id, type }) => ({ id, type }))).toEqual([
        { id: `context-compaction-summary:${second.snapshot.id}`, type: "compaction_summary" },
        { id: newerGroup.id, type: "agent_message" },
      ])
      expect(afterSecond.items[0]?.content).toBe(summaries[1])
      const finalText = afterSecond.items.map(item => JSON.stringify(item.content)).join("\n")
      for (const marker of [firstMarker, omittedMarker, tailMarker, newerMarker]) expect(occurrenceCount(finalText, marker)).toBe(1)
    } finally {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [fixture.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [fixture.userId])
      await reloadPool.end()
      await verificationPool.end()
    }
  })

  it("fails closed without summarizing or publishing an oversized first sequence group", async () => {
    const fixture = await seedOwnerFixture(pool!)
    try {
      await insertCompletedItem(pool!, fixture, "oversized-first-group", "X".repeat(2_000))
      const source = await createPgCompactionSource(pool!).load({ scope: fixture.scope, owner: fixture.owner })
      if (!source) throw new Error("Expected a source with an oversized first group")
      const port = createPgContextSnapshotCompactionPort(pool!, fixture.owner)
      const publish = vi.spyOn(port, "publishAtomically")
      const summarize = vi.fn(() => "must not be called")
      const compactor = new ContextCompactor(port, summarize, () => `oversized-${fixture.sessionId}`)
      const result = await compactor.compact({
        scope: fixture.scope, turnId: fixture.turnId, source,
        policy: { inputTokenThreshold: 1, itemCountThreshold: 1, compactAtTurnBoundary: true },
        atTurnBoundary: false, requested: true,
        bounds: { maxNarrativeInputCharacters: 100 },
      })
      expect(result.status).toBe("failed")
      expect(summarize).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      const snapshots = await pool!.query(`SELECT "id" FROM "agent_context_snapshots" WHERE "sessionId" = $1`, [fixture.sessionId])
      expect(snapshots.rows).toEqual([])
    } finally {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [fixture.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [fixture.userId])
    }
  })

  it("rolls back snapshot and completed lifecycle writes when a conflicting outbox identity exists", async () => {
    const fixture = await seedOwnerFixture(pool!)
    try {
      const source = emptySource(fixture)
      const started = createCompactionStartedItem({ sessionId: fixture.sessionId, turnId: fixture.turnId, throughSequence: 0n, source, reason: "manual", id: `rollback-compaction-${randomUUID()}` })
      const measurement = { beforeInputTokens: 100, afterInputTokens: 20, reductionTokens: 80, reductionRatio: 0.8 }
      const report = { preserved: true, preservedFields: ["goal", "approvals", "answers", "artifact_hashes", "open_tasks", "do_not_repeat", "selected_job_memories"] as const, missingFields: [], changedFields: [], beforeDigest: "before", afterDigest: "after" }
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
