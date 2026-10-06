import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"

import { SessionPauseRequestedError } from "../session-gate.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import type { TaskGraphNativeCommandInput } from "./task-graph-native-command.js"
import type { PgSubagentPool } from "./types.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Native TaskGraph PostgreSQL tests need AGENT_RUNTIME_PG_TEST_URL and AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Native TaskGraph PostgreSQL tests require the dedicated disposable CI URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), ids = {
  user: `native-command-user-${suffix}`, session: `native-command-session-${suffix}`,
  turn: `native-command-turn-${suffix}`, root: `native-command-root-${suffix}`,
  foreignTurn: `native-command-foreign-turn-${suffix}`, foreignRoot: `native-command-foreign-root-${suffix}`,
  step: `native-command-step-${suffix}`, turnOwner: `native-turn-owner-${suffix}`,
  taskOwner: `native-task-owner-${suffix}`,
}
const scope: TaskGraphNativeCommandInput["scope"] = {
  userId: ids.user, sessionId: ids.session, turnId: ids.turn, rootTaskId: ids.root, parentTaskId: ids.root,
  stepId: ids.step, turnLeaseOwner: ids.turnOwner, turnLeaseVersion: 1,
  parentLeaseOwner: ids.taskOwner, parentAttemptCount: 1,
}
let pool: PgPool | undefined
const command = () => createPgTaskGraphCommandPort(pool as unknown as PgSubagentPool)
const spawn = (key: string): TaskGraphNativeCommandInput => ({
  scope, request: {
    kind: "spawn", idempotencyKey: key, role: "auditor", taskType: "audit",
    goal: `Inspect ${key}`, constraints: ["read only"], successCriteria: ["record findings"],
    context: { privateCallerContext: key },
  },
})

async function seed(): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'native command integration', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user])
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [ids.turn, ids.session, ids.user, ids.turnOwner])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'native command integration',
      '[]'::jsonb, '[]'::jsonb, '["jobs.search","jobs.get"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":64,"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [ids.root, ids.session, ids.turn, ids.taskOwner])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [ids.step, ids.session, ids.turn, ids.root])
}

async function event(type: "session.pause_requested" | "session.resume_requested"): Promise<void> {
  const updated = await pool!.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 RETURNING "eventSequence"`, [ids.session])
  await pool!.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, 'system', $3, $7, '{}'::jsonb)`, [randomUUID(), ids.session, ids.turn, ids.root,
    updated.rows[0]!.eventSequence, type, `test:${type}:${randomUUID()}`])
}

describePg("native TaskGraph PostgreSQL command durability", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 3 })
    await seed()
  })
  afterAll(async () => {
    if (!pool) return
    await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session])
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    await pool.end()
  })

  it("serializes independent commands, replays across revisions, and reads safe native receipts", async () => {
    const port = command(), a = spawn("race-a"), b = spawn("race-b")
    const [first, second] = await Promise.all([port.appendNativeCoordination!(a), port.appendNativeCoordination!(b)])
    expect([first.graphRevision, second.graphRevision].sort()).toEqual([1, 2])
    expect(first.child.taskId).not.toBe(second.child.taskId)
    const replay = await port.appendNativeCoordination!(a)
    expect(replay).toMatchObject({ status: "duplicate", replay: true, graphRevision: first.graphRevision, child: first.child })

    const changedKind: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "race-a", sourceTaskId: "missing-source", goal: "Refine" },
    }
    await expect(port.appendNativeCoordination!(changedKind)).rejects.toMatchObject({ code: "idempotency_conflict" })
    const current = await port.readCurrent(scope)
    expect(current.revision).toBe(2)
    expect(current.nodes.map(node => node.native?.operationId)).toContain(first.operationId)
    expect(current.nodes.find(node => node.native?.operationId === first.operationId)?.nativeResult)
      .toMatchObject({ role: "auditor", taskStatus: "queued", disposition: "missing", resultDigest: null })

    const stored = await pool!.query<{ content: unknown }>(`SELECT "content" FROM "agent_items" WHERE "id" = $1`, [taskGraphItemId(ids.root)])
    const serialized = JSON.stringify(stored.rows[0]?.content)
    expect(serialized).not.toContain("privateCallerContext")
    const rows = await pool!.query(`SELECT event."type", event."idempotencyKey", event."payload"
      FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."payload"->>'kind' = 'native_command'`, [ids.session])
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.map(row => row.type).sort()).toEqual(["item.delta", "item.started"])
    expect(rows.rows.every(row => String(row.idempotencyKey).includes(":native:") && !String(row.idempotencyKey).includes(":spawn:"))).toBe(true)
    expect(await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1`, [ids.session]))
      .toMatchObject({ rows: expect.arrayContaining([expect.any(Object), expect.any(Object)]) })
  }, 60_000)

  it("uses terminal same-root follow-up provenance, rejects foreign and malformed sources, and honors pause fences", async () => {
    const sourceId = `native-source-${suffix}`
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot",
       "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/root/source', 1, 'auditor', 'audit', 'completed', 'source', '[]'::jsonb, '[]'::jsonb,
        '["jobs.search"]'::jsonb, '{"sourceContext":"keep"}'::jsonb, '{}'::jsonb, '{"summary":"finished"}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{"subagentPolicy":{"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb, 0, 2, CURRENT_TIMESTAMP)`,
    [sourceId, ids.session, ids.turn, ids.root])
    const followup: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "followup-good", sourceTaskId: sourceId, goal: "Refine audit", context: { caller: "kept" } },
    }
    const accepted = await command().appendNativeCoordination!(followup)
    expect(accepted.source).toMatchObject({ taskId: sourceId, origin: "native_legacy", status: "completed", attemptCount: 0 })
    expect(accepted.child.role).toBe("auditor")
    const child = await pool!.query<{ context: unknown; allowedActions: unknown }>(`SELECT "context", "allowedActions" FROM "sub_agent_tasks" WHERE "id" = $1`, [accepted.child.taskId])
    expect(child.rows[0]?.context).toMatchObject({ callerContext: { caller: "kept" }, sourceContext: { sourceContext: "keep" }, provenance: { sourceTaskId: sourceId } })
    expect(child.rows[0]?.allowedActions).toEqual(["jobs.search"])

    const foreignId = `native-foreign-source-${suffix}`
    await pool!.query(`INSERT INTO "agent_turns"
      ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
       "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
    [ids.foreignTurn, ids.session, ids.user, `native-foreign-turn-owner-${suffix}`])
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
       "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'foreign root',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"subagentPolicy":{"maxConcurrency":64,"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb,
        1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
    [ids.foreignRoot, ids.session, ids.foreignTurn, `native-foreign-task-owner-${suffix}`])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.foreignRoot])
    await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.foreignRoot, ids.foreignTurn])
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/root/source', 1, 'auditor', 'audit', 'completed', 'source', '[]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{"subagentPolicy":{"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb, 0, 2, CURRENT_TIMESTAMP)`,
    [foreignId, ids.session, ids.foreignTurn, ids.foreignRoot])
    const foreignLineage = await pool!.query<{ sourceTaskId: string; sourceRootTaskId: string; rootTaskId: string; sourceTurnId: string; rootTurnId: string }>(
      `SELECT source."id" AS "sourceTaskId", source."rootTaskId" AS "sourceRootTaskId", root."id" AS "rootTaskId",
        source."turnId" AS "sourceTurnId", root."turnId" AS "rootTurnId"
       FROM "sub_agent_tasks" AS source JOIN "sub_agent_tasks" AS root
         ON root."id" = source."rootTaskId" AND root."sessionId" = source."sessionId"
       WHERE source."id" = $1`, [foreignId])
    expect(foreignLineage.rows[0]).toEqual({ sourceTaskId: foreignId, sourceRootTaskId: ids.foreignRoot, rootTaskId: ids.foreignRoot, sourceTurnId: ids.foreignTurn, rootTurnId: ids.foreignTurn })
    await expect(command().appendNativeCoordination!({
      scope, request: { kind: "followup", idempotencyKey: "followup-foreign", sourceTaskId: foreignId, goal: "Must not cross root" },
    })).rejects.toMatchObject({ code: "native_source_unavailable" })

    const malformedId = `native-malformed-source-${suffix}`
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot",
       "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/root/bad-source', 1, 'auditor', 'audit', 'completed', 'source', '[]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{"subagentPolicy":{"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb, 0, 2, CURRENT_TIMESTAMP)`,
    [malformedId, ids.session, ids.turn, ids.root, JSON.stringify({ status: "completed", structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" } })])
    await expect(command().appendNativeCoordination!({
      scope, request: { kind: "followup", idempotencyKey: "followup-malformed", sourceTaskId: malformedId, goal: "Fail closed" },
    })).rejects.toThrow("task_graph_native_result_invalid")

    await event("session.pause_requested")
    const before = await pool!.query(`SELECT COUNT(*)::int AS count FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2`, [ids.session, ids.root])
    await expect(command().appendNativeCoordination!(spawn("paused"))).rejects.toBeInstanceOf(SessionPauseRequestedError)
    const after = await pool!.query(`SELECT COUNT(*)::int AS count FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2`, [ids.session, ids.root])
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
    await event("session.resume_requested")
  }, 60_000)

  it("rolls back a child and dispatch when a full graph rejects the appended native node", async () => {
    const port = command()
    const children = await pool!.query<{ id: string }>(`SELECT "id" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2`, [ids.session, ids.root])
    if (children.rows.length) await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed' WHERE "id" = ANY($1::text[])`, [children.rows.map(row => row.id)])
    let state = await port.readCurrent(scope)
    let index = 0
    while (state.nodes.length < TASK_GRAPH_LIMITS.maxNodes) {
      const receipt = await port.appendNativeCoordination!(spawn(`fill-${index++}`))
      await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed' WHERE "id" = $1`, [receipt.child.taskId])
      state = await port.readCurrent(scope)
    }
    const before = await pool!.query(`SELECT (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1) AS dispatch,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "payload"->>'kind' = 'native_command') AS events`, [ids.session, ids.root])
    await expect(port.appendNativeCoordination!(spawn("overflow"))).rejects.toMatchObject({ code: "native_graph_node_invalid" })
    const after = await pool!.query(`SELECT (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1) AS dispatch,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "payload"->>'kind' = 'native_command') AS events`, [ids.session, ids.root])
    expect(after.rows).toEqual(before.rows)
  }, 120_000)
})
