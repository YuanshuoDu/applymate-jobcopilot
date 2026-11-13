import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"
import { claimTurnLease } from "../turns/lease.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { AgentTreeManager } from "./manager.js"
import { createPgRootTaskStore } from "./root-task-store.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { recoverExpiredTaskGraphChildren } from "./pg-store-task-graph-deadline-recovery.js"
import { recoverExpiredNestedScoutChildren } from "./nested-scout-deadline-recovery.js"
import { defaultSubagentPolicy } from "./types.js"
import type { SubagentLease, SubagentTaskSpec } from "./types.js"

const DATABASE_NAME = "applymate_nested_delegation_ci"
function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Required disposable PostgreSQL URL is missing")
    return null
  }
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "nested_fixture"
    || url.password !== "nested_fixture_only" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Nested Scout deadline tests require the dedicated disposable CI PostgreSQL service")
  }
  return value
}

const url = disposableUrl()
const describePg = url ? describe : describe.skip
type Fixture = { userId: string; sessionId: string; turnId: string; rootTaskId: string; parentScoutId: string;
  siblingId: string; parentLease: SubagentLease; manager: AgentTreeManager; store: PgSubagentTaskStore; suffix: string }
const managers: AgentTreeManager[] = []
const cleanupScopes: Array<{ userId: string; sessionId: string }> = []
let pool: Pool

async function seedGraph(pool: Pool): Promise<Fixture> {
  const suffix = randomUUID()
  const userId = `nested-deadline-user-${suffix}`, sessionId = `nested-deadline-session-${suffix}`
  const turnId = `nested-deadline-turn-${suffix}`
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [userId, `${userId}@example.invalid`])
  cleanupScopes.push({ userId, sessionId })
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Nested Scout deadline', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
      "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "inputTokens", "outputTokens", "estimatedCostUsd", "updatedAt")
    VALUES ($1, $2, $3, 'queued', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 0, CURRENT_TIMESTAMP)`,
  [turnId, sessionId, userId])
  const turnLease = await claimTurnLease(pool, { turnId, sessionId, ownerId: `turn-owner-${suffix}` })
  const policy = { maxConcurrency: 4, maxDepth: 2, maxFanOut: 2, maxAttempts: 2 }
  const root = await createPgRootTaskStore(pool).ensure({ lease: turnLease, goal: "Nested Scout deadline",
    allowedActions: [], budgetSnapshot: { subagentPolicy: policy } })
  const stepId = `nested-root-step-${suffix}`
  await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
      "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [stepId, sessionId, turnId, root.id])
  const graph = await createPgTaskGraphCommandPort(pool).appendAndSchedule({
    scope: { userId, sessionId, turnId, rootTaskId: root.id, parentTaskId: root.id, stepId,
      turnLeaseOwner: turnLease.ownerId, turnLeaseVersion: turnLease.leaseVersion,
      parentLeaseOwner: root.leaseOwner!, parentAttemptCount: root.attemptCount },
    proposal: { expectedRevision: 0, nodes: [
      { key: "scout", templateId: "scout", goal: "Find relevant jobs", successCriteria: ["Return candidates"], dependsOn: [],
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
          criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] } },
      { key: "sibling", templateId: "analyst", goal: "Independent sibling", successCriteria: ["Inspect evidence"], dependsOn: [],
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
          criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] } },
    ] },
    templates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      analyst: { role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.search"] } },
  })
  const parentScoutId = graph.nodes.find(node => node.key === "scout")?.taskId
  const siblingId = graph.nodes.find(node => node.key === "sibling")?.taskId
  if (!parentScoutId || !siblingId) throw new Error("Nested deadline fixture graph did not create its expected nodes")
  const store = new PgSubagentTaskStore(pool)
  const manager = new AgentTreeManager(store, { heartbeatMs: 300_000 })
  managers.push(manager)
  const parentLease = await manager.claim({ taskId: parentScoutId, sessionId, rootTaskId: root.id, ownerId: `scout-owner-${suffix}` })
  if (!parentLease) throw new Error("Nested deadline Scout could not be claimed")
  const fixture = { userId, sessionId, turnId, rootTaskId: root.id, parentScoutId, siblingId, parentLease, manager, store, suffix }
  return fixture
}

async function spawnChild(f: Fixture, key: string) {
  const stepId = `nested-scout-step-${key}-${f.suffix}`, toolCallId = `nested-scout-call-${key}-${f.suffix}`
  await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
      "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, $5, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
  [stepId, f.sessionId, f.turnId, f.parentScoutId, f.parentLease.attemptCount])
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', 'commentary', 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [`nested-scout-call-item-${key}-${f.suffix}`, f.sessionId, f.turnId, stepId, f.parentScoutId,
    JSON.stringify({ toolCallId, toolName: "scout.delegate", toolVersion: "1", status: "started", input: { idempotencyKey: key } })])
  const spec: SubagentTaskSpec = { userId: f.userId, sessionId: f.sessionId, turnId: f.turnId,
    parentTaskId: f.parentScoutId, role: "scout", taskType: "job_discovery", goal: "Read-only nested discovery",
    allowedActions: ["jobs.search"], policy: defaultSubagentPolicy() }
  const result = await f.manager.spawnFromLease(spec, key, f.parentLease, { stepId, toolCallId })
  if (!result.task) throw new Error("Nested Scout spawn did not return the created child")
  return result.task
}

describePg("nested Scout absolute deadline recovery: disposable PostgreSQL", () => {
  beforeAll(() => { pool = new Pool({ connectionString: url!, max: 8 }) })
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown()
    for (const fixture of cleanupScopes.splice(0)) {
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [fixture.sessionId])
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [fixture.userId])
    }
  })
  afterAll(async () => { await pool.end() })

  it.each(["queued", "waiting", "running"])("terminalizes a depth-two %s child by absolute deadline regardless of lease state", async initialStatus => {
    const f = await seedGraph(pool), child = await spawnChild(f, `single-${initialStatus}`)
    expect(child.depth).toBe(2)
    const deadlines = await pool.query<{ parentDeadline: Date; childDeadline: Date; dbNow: Date }>(`SELECT parent."absoluteDeadlineAt" AS "parentDeadline",
        child."absoluteDeadlineAt" AS "childDeadline", clock_timestamp() AS "dbNow"
      FROM "sub_agent_tasks" parent JOIN "sub_agent_tasks" child ON child."parentTaskId" = parent."id"
      WHERE parent."id" = $1 AND child."id" = $2`, [f.parentScoutId, child.id])
    expect(deadlines.rows[0]?.childDeadline).toBeInstanceOf(Date)
    expect(deadlines.rows[0]!.childDeadline.getTime()).toBeLessThanOrEqual(deadlines.rows[0]!.parentDeadline.getTime())
    expect(deadlines.rows[0]!.childDeadline.getTime()).toBeLessThanOrEqual(deadlines.rows[0]!.dbNow.getTime() + 60 * 60_000)
    let childLease: Awaited<ReturnType<PgSubagentTaskStore["claim"]>> = null
    if (initialStatus !== "queued") {
      childLease = await f.store.claim({ taskId: child.id, sessionId: f.sessionId, ownerId: `child-owner-${f.suffix}`,
        policy: defaultSubagentPolicy(), now: new Date() })
      if (!childLease) throw new Error("Nested deadline child could not be claimed")
      if (initialStatus === "waiting") {
        const ownerId = childLease.leaseOwner
        if (!ownerId) throw new Error("Nested deadline waiting child lost its lease owner")
        await expect(f.store.finish({ taskId: child.id, sessionId: f.sessionId, ownerId,
          attemptCount: childLease.attemptCount, status: "waiting", result: { status: "waiting" }, now: new Date() })).resolves.toBe("waiting")
        childLease = null
      } else {
        const live = await pool.query<{ leaseExpiresAt: Date }>(`SELECT "leaseExpiresAt" FROM "sub_agent_tasks" WHERE "id" = $1`, [child.id])
        expect(live.rows[0]!.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now())
      }
    }
    await pool.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = $1`, [child.id])
    const recovered = await recoverExpiredNestedScoutChildren(pool, 1)
    expect(recovered.map(task => task.id)).toContain(child.id)
    expect(recovered.find(task => task.id === child.id)).toMatchObject({ status: "failed", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null })
    if (childLease) {
      const ownerId = childLease.leaseOwner
      if (!ownerId) throw new Error("Expired running child lost its original owner fixture")
      await expect(f.store.heartbeat({ taskId: child.id, sessionId: f.sessionId, ownerId,
        attemptCount: childLease.attemptCount, now: new Date() })).resolves.toBe("lost")
      await expect(f.store.finish({ taskId: child.id, sessionId: f.sessionId, ownerId,
        attemptCount: childLease.attemptCount, status: "completed", result: {}, now: new Date() })).resolves.toBeNull()
    }
    const parent = await f.store.get(f.parentScoutId, f.sessionId)
    expect(parent?.status).toBe("running")
  })

  it("cascades a failed TaskGraph Scout deadline only through its own children", async () => {
    const owner = await seedGraph(pool), foreign = await seedGraph(pool)
    const nested = await spawnChild(owner, `cascade-${owner.suffix}`), foreignChild = await spawnChild(foreign, `foreign-${foreign.suffix}`)
    await pool.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = clock_timestamp() - INTERVAL '2 seconds' WHERE "id" = $1`, [owner.parentScoutId])
    await pool.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = clock_timestamp() - INTERVAL '3 seconds' WHERE "id" = $1`, [nested.id])
    const recovered = await recoverExpiredTaskGraphChildren(pool, 10)
    expect(recovered.map(task => task.id)).toContain(owner.parentScoutId)
    const [ownerParent, ownerChild, ownerSibling, ownerRoot, foreignParent, foreignNested] = await Promise.all([
      owner.store.get(owner.parentScoutId, owner.sessionId), owner.store.get(nested.id, owner.sessionId),
      owner.store.get(owner.siblingId, owner.sessionId), owner.store.get(owner.rootTaskId, owner.sessionId),
      foreign.store.get(foreign.parentScoutId, foreign.sessionId), foreign.store.get(foreignChild.id, foreign.sessionId),
    ])
    expect(ownerParent?.status).toBe("failed")
    expect(ownerParent?.failureReason).toBe("task_graph_child_deadline_exceeded")
    expect(ownerChild).toMatchObject({ status: "failed", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null })
    expect(ownerSibling?.status).toBe("queued")
    expect(ownerRoot?.status).toBe("running")
    expect(foreignParent?.status).toBe("running")
    expect(foreignNested?.status).toBe("queued")
  })

  it("rolls back the parent failure when an active child violates inherited deadline", async () => {
    const f = await seedGraph(pool), child = await spawnChild(f, `bad-inheritance-${f.suffix}`)
    await pool.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = clock_timestamp() - INTERVAL '2 seconds' WHERE "id" = $1`, [f.parentScoutId])
    await pool.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = clock_timestamp() + INTERVAL '1 minute' WHERE "id" = $1`, [child.id])
    await expect(recoverExpiredTaskGraphChildren(pool, 10)).rejects.toThrow("nested_scout_deadline_inheritance_invalid")
    const [parent, nested] = await Promise.all([f.store.get(f.parentScoutId, f.sessionId), f.store.get(child.id, f.sessionId)])
    expect(parent?.status).toBe("running")
    expect(nested?.status).toBe("queued")
  })
})
