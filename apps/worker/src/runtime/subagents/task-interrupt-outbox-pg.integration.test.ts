import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool } from "pg"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { TASK_GRAPH_ITEM_TYPE, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { drainTaskInterruptOutbox, TASK_INTERRUPT_OUTBOX_TOPIC } from "./task-interrupt-outbox.js"
import type { AgentTreeManager } from "./manager.js"
import type { PgSubagentPool } from "./types.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Task interrupt PostgreSQL integration requires its disposable service URL")
    return null
  }
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Task interrupt PostgreSQL integration accepts only the dedicated disposable CI service")
  }
  return value
}

const databaseUrl = disposableUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const ids = {
  suffix: randomUUID(), user: "", session: "", turn: "", root: "", target: "", descendant: "", sibling: "", item: "", intent: randomUUID(),
}
ids.user = `task-int-user-${ids.suffix}`
ids.session = `task-int-session-${ids.suffix}`
ids.turn = `task-int-turn-${ids.suffix}`
ids.root = `task-int-root-${ids.suffix}`
ids.target = `task-int-target-${ids.suffix}`
ids.descendant = `task-int-descendant-${ids.suffix}`
ids.sibling = `task-int-sibling-${ids.suffix}`
ids.item = taskGraphItemId(ids.root)

describeWithPostgres("durable child task interruption on disposable PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl!, max: 4 })
  let disconnectWebDb: (() => Promise<void>) | null = null
  beforeAll(async () => {
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'interrupt fixture', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user])
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [ids.turn, ids.session, ids.user])
    const insertTask = `INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $12, 1, $13, $14, CURRENT_TIMESTAMP)`
    await pool.query(insertTask, [ids.root, ids.session, ids.turn, ids.root, null, `/${ids.root}`, 0, "orchestrator", "root", "running", "root task", 1, "root-worker", new Date(Date.now() + 60_000)])
    await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1`, [ids.turn, ids.root])
    await pool.query(insertTask, [ids.target, ids.session, ids.turn, ids.root, ids.root, `/${ids.root}/${ids.target}`, 1, "analyst", "research", "queued", "selected task", 0, null, null])
    await pool.query(insertTask, [ids.descendant, ids.session, ids.turn, ids.root, ids.target, `/${ids.root}/${ids.target}/${ids.descendant}`, 2, "scout", "research", "running", "descendant task", 1, "child-worker", new Date(Date.now() + 60_000)])
    await pool.query(insertTask, [ids.sibling, ids.session, ids.turn, ids.root, ids.root, `/${ids.root}/${ids.sibling}`, 1, "analyst", "research", "queued", "sibling task", 0, null, null])

    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { key: "selected", templateId: "analyst", goal: "selected task", successCriteria: ["complete"], dependsOn: [], depth: 1, taskId: ids.target },
      { key: "sibling", templateId: "analyst", goal: "sibling task", successCriteria: ["complete"], dependsOn: [], depth: 1, taskId: ids.sibling },
    ] }
    const item = { schemaVersion, id: ids.item, sessionId: ids.session, turnId: ids.turn, stepId: null, taskId: ids.root,
      type: TASK_GRAPH_ITEM_TYPE, status: "streaming", phase: null, revision: 1, content: snapshot, startedAt: new Date().toISOString(), completedAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "startedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'streaming', 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [ids.item, ids.session, ids.turn, ids.root, TASK_GRAPH_ITEM_TYPE, JSON.stringify(snapshot)])
    const proposal = { kind: "proposal", fingerprint: "a".repeat(64), revision: 1,
      receipt: { status: "accepted", revision: 1, nodes: [{ key: "selected", taskId: ids.target, status: "queued" }, { key: "sibling", taskId: ids.sibling, status: "queued" }], readyTaskIds: [ids.target, ids.sibling] }, item }
    await pool.query(`UPDATE "agent_sessions" SET "eventSequence" = 1 WHERE "id" = $1`, [ids.session])
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, 1, 'item.started', 'orchestrator', $3, $6, $7::jsonb)`, [randomUUID(), ids.session, ids.turn, ids.item, ids.root, taskGraphProposalKey(ids.root, 0), JSON.stringify(proposal)])
  })

  afterAll(async () => {
    if (disconnectWebDb) await disconnectWebDb().catch(() => undefined)
    await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session]).catch(() => undefined)
    await pool.query(`DELETE FROM "agent_events" WHERE "sessionId" = $1`, [ids.session]).catch(() => undefined)
    await pool.query(`DELETE FROM "agent_items" WHERE "sessionId" = $1`, [ids.session]).catch(() => undefined)
    await pool.query(`DELETE FROM "sub_agent_tasks" WHERE "sessionId" = $1`, [ids.session]).catch(() => undefined)
    await pool.query(`DELETE FROM "agent_turns" WHERE "sessionId" = $1`, [ids.session]).catch(() => undefined)
    await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.session]).catch(() => undefined)
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user]).catch(() => undefined)
    await pool.end()
    vi.unstubAllEnvs()
  })

  it("persists and replays the Web command before draining only the selected subtree", async () => {
    const clientMessageId = "integration-interrupt-1"
    vi.stubEnv("DATABASE_URL", databaseUrl!)
    // @ts-expect-error The Worker Vitest alias resolves the allowlisted Web database module at runtime.
    const { db } = await import("@/lib/db")
    // @ts-expect-error The Worker Vitest alias resolves the allowlisted Web interrupt service at runtime.
    const { TaskInterruptService } = await import("@/lib/agent/control-plane/commands/task-interrupt-service")
    disconnectWebDb = () => db.$disconnect()
    const service = new TaskInterruptService(db)
    const command = { sessionId: ids.session, taskId: ids.target, userId: ids.user, clientMessageId }
    const eventKey = `agent-task-interrupt-accepted:${ids.session}:${clientMessageId}`
    const intentKey = `agent-task-interrupt:${ids.session}:${clientMessageId}`

    await expect(service.interrupt({ ...command, userId: `foreign-${ids.suffix}` })).rejects.toMatchObject({
      code: "task_interrupt_target_not_found", status: 404,
    })
    const rejectedWrites = await pool.query(`SELECT
      (SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1) AS "eventSequence",
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2) AS "events",
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "idempotencyKey" = $3) AS "intents"`,
    [ids.session, eventKey, intentKey])
    expect(String(rejectedWrites.rows[0]?.eventSequence)).toBe("1")
    expect(rejectedWrites.rows[0]).toMatchObject({ events: 0, intents: 0 })

    const acceptedCommand = await service.interrupt(command)
    ids.intent = acceptedCommand.intentId
    expect(acceptedCommand).toMatchObject({ taskId: ids.target, turnId: ids.turn, disposition: "accepted", sequence: "2" })
    const persisted = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "taskId" = $2 AND "type" = 'task.interrupt.accepted' AND "idempotencyKey" = $3) AS "events",
      (SELECT "aggregateId" FROM "agent_outbox" WHERE "idempotencyKey" = $4 AND "topic" = $5) AS "aggregateId",
      (SELECT "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $4 AND "topic" = $5) AS "payload"`,
    [ids.session, ids.target, eventKey, intentKey, TASK_INTERRUPT_OUTBOX_TOPIC])
    expect(persisted.rows[0]).toMatchObject({ events: 1, aggregateId: ids.session,
      payload: { sessionId: ids.session, turnId: ids.turn, taskId: ids.target, intentId: acceptedCommand.intentId } })

    await expect(service.interrupt(command)).resolves.toEqual({ ...acceptedCommand, disposition: "duplicate" })
    await expect(service.interrupt({ ...command, taskId: ids.sibling })).rejects.toMatchObject({
      code: "task_interrupt_idempotency_conflict", status: 409,
    })
    const replayWrites = await pool.query(`SELECT
      (SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1) AS "eventSequence",
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2) AS "events",
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "idempotencyKey" = $3) AS "intents"`,
    [ids.session, eventKey, intentKey])
    expect(String(replayWrites.rows[0]?.eventSequence)).toBe("2")
    expect(replayWrites.rows[0]).toMatchObject({ events: 1, intents: 1 })

    const outbox = await pool.query(`SELECT "aggregateId", "topic", "idempotencyKey" FROM "agent_outbox"
      WHERE "topic" = $1 AND "aggregateId" = $2 AND "idempotencyKey" = $3`,
    [TASK_INTERRUPT_OUTBOX_TOPIC, ids.session, intentKey])
    expect(outbox.rows).toEqual([{ aggregateId: ids.session, topic: TASK_INTERRUPT_OUTBOX_TOPIC,
      idempotencyKey: intentKey }])
    const acceptedEvent = await pool.query(`SELECT "sequence", "type", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "taskId" = $2 AND "type" = 'task.interrupt.accepted' AND "idempotencyKey" = $3`, [ids.session, ids.target, eventKey])
    expect(acceptedEvent.rows).toHaveLength(1)
    expect(String(acceptedEvent.rows[0]?.sequence)).toBe("2")
    expect(acceptedEvent.rows[0]).toMatchObject({ type: "task.interrupt.accepted", payload: { intentId: ids.intent, taskId: ids.target, status: "accepted" } })

    const manager = { signalTaskSubtree: vi.fn() } as unknown as AgentTreeManager
    await expect(drainTaskInterruptOutbox(pool as unknown as PgSubagentPool, manager)).resolves.toBe(1)
    const tasks = await pool.query(`SELECT "id", "status", "interruptRequestedAt" FROM "sub_agent_tasks" WHERE "sessionId" = $1 ORDER BY "id"`, [ids.session])
    const byId = new Map(tasks.rows.map(row => [row.id, row]))
    expect(byId.get(ids.target)).toMatchObject({ status: "interrupted" })
    expect(byId.get(ids.descendant)?.status).toBe("running")
    expect(byId.get(ids.descendant)?.interruptRequestedAt).toBeTruthy()
    expect(byId.get(ids.root)).toMatchObject({ status: "running", interruptRequestedAt: null })
    expect(byId.get(ids.sibling)).toMatchObject({ status: "queued", interruptRequestedAt: null })
    expect(manager.signalTaskSubtree).toHaveBeenCalledWith(ids.session, ids.root, [ids.descendant])

    const graph = await pool.query(`SELECT "revision" FROM "agent_items" WHERE "id" = $1`, [ids.item])
    const receipt = await pool.query(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'item.delta' AND "itemId" = $2`, [ids.session, ids.item])
    expect(graph.rows[0]?.revision).toBe(2)
    expect(receipt.rows[0]?.payload).toMatchObject({ kind: "lifecycle", event: { type: "task.interrupted", nodeKey: "selected" } })

    const closedClientMessageId = "integration-interrupt-closed-session"
    const closedAccepted = await service.interrupt({ ...command, taskId: ids.sibling, clientMessageId: closedClientMessageId })
    expect(closedAccepted.disposition).toBe("accepted")
    await pool.query(`UPDATE "agent_sessions" SET "status" = 'aborted' WHERE "id" = $1`, [ids.session])
    const tasksBeforeClosedDrain = await pool.query(`SELECT "id", "status", "interruptRequestedAt" FROM "sub_agent_tasks" WHERE "sessionId" = $1 ORDER BY "id"`, [ids.session])
    await expect(drainTaskInterruptOutbox(pool as unknown as PgSubagentPool, manager)).resolves.toBe(1)
    const closedIntentKey = `agent-task-interrupt:${ids.session}:${closedClientMessageId}`
    const closedIntent = await pool.query(`SELECT "publishedAt" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [closedIntentKey])
    const failedOutcome = await pool.query(`SELECT "type", "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "taskId" = $2 AND "idempotencyKey" = $3`,
      [ids.session, ids.sibling, `agent-task-interrupt:${closedAccepted.intentId}:${ids.sibling}:failed`])
    const tasksAfterClosedDrain = await pool.query(`SELECT "id", "status", "interruptRequestedAt" FROM "sub_agent_tasks" WHERE "sessionId" = $1 ORDER BY "id"`, [ids.session])
    expect(closedIntent.rows[0]?.publishedAt).toBeTruthy()
    expect(failedOutcome.rows).toEqual([{ type: "task.interrupt.failed", payload: { intentId: closedAccepted.intentId, taskId: ids.sibling, status: "failed", code: "target_unavailable" } }])
    expect(tasksAfterClosedDrain.rows).toEqual(tasksBeforeClosedDrain.rows)
    expect(manager.signalTaskSubtree).toHaveBeenCalledTimes(1)

    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'interrupted', "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL, "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [ids.descendant])
    for (let index = 0; index < 25; index++) {
      const noiseIntentId = randomUUID()
      const noiseTaskId = `missing-${index}-${ids.suffix}`
      await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt", "createdAt")
        VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($6::int * INTERVAL '1 second'))`,
      [randomUUID(), TASK_INTERRUPT_OUTBOX_TOPIC, ids.session, `noise:${noiseIntentId}`,
        JSON.stringify({ sessionId: ids.session, turnId: ids.turn, taskId: noiseTaskId, intentId: noiseIntentId }), index + 1])
    }
    await expect(drainTaskInterruptOutbox(pool as unknown as PgSubagentPool, manager)).resolves.toBe(0)
    const descendantOutcome = await pool.query(`SELECT "type", "idempotencyKey" FROM "agent_events"
      WHERE "sessionId" = $1 AND "taskId" = $2 AND "idempotencyKey" = $3`,
    [ids.session, ids.descendant, `agent-task-interrupt:${ids.intent}:${ids.descendant}:interrupted`])
    expect(descendantOutcome.rows).toEqual([{ type: "task.interrupted", idempotencyKey: `agent-task-interrupt:${ids.intent}:${ids.descendant}:interrupted` }])
  })
})
