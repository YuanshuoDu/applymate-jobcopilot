import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"
import { projectSelectedJobMemory } from "./selected-job-memory.js"
import { createPgSelectedJobHistoryStore, type SelectedJobHistoryLoadInput } from "./selected-job-history-store.js"
import { taskGraphItemId } from "../subagents/task-graph-snapshot.js"
import type { TurnLease } from "../turns/lease.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Selected-job history needs the dedicated disposable PostgreSQL CI service")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Selected-job history requires the dedicated disposable PostgreSQL CI URL")
  }
  return value
}
const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID()
const ids = {
  user: `job-history-user-${suffix}`, session: `job-history-session-${suffix}`,
  currentTurn: `job-history-current-turn-${suffix}`, currentRoot: `job-history-current-root-${suffix}`,
  currentStep: `job-history-current-step-${suffix}`, sourceTurn: `job-history-source-turn-${suffix}`,
  sourceRoot: `job-history-source-root-${suffix}`, child: `job-history-source-child-${suffix}`,
  finalItem: `job-history-final-item-${suffix}`, terminalEvent: `job-history-terminal-${suffix}`,
  duplicateTerminalEvent: `job-history-duplicate-terminal-${suffix}`,
  currentStartEvent: `job-history-current-start-${suffix}`,
}
const jobId = `job-${suffix}`
const workerId = `worker-${suffix}`
let pool: PgPool | undefined
let lease: TurnLease
let record: NonNullable<ReturnType<typeof projectSelectedJobMemory>>

describePg("selected-job history PostgreSQL source revalidation", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    const leaseExpires = new Date(Date.now() + 5 * 60_000)
    lease = { turnId: ids.currentTurn, sessionId: ids.session, userId: ids.user, ownerId: workerId,
      leaseVersion: 1, leaseStartedAt: new Date(), leaseExpiresAt: leaseExpires }
    const input = JSON.stringify({ selectedJobPreparation: { jobId } })
    const graph = {
      schemaVersion: "agent-harness.v2.task-graph",
      nodes: [{ key: "scout", templateId: "scout", goal: "Find roles", successCriteria: ["Find one role"],
        dependsOn: [], depth: 1, taskId: ids.child }],
    }
    const projected = projectSelectedJobMemory({ jobId, sourceTurnId: ids.sourceTurn, sourceRootTaskId: ids.sourceRoot,
      throughSequence: "2", graph: { revision: 1, nodes: [{ key: "scout", templateId: "scout", goal: "Find roles",
        successCriteria: ["Find one role"], dependsOn: [], taskId: ids.child, status: "completed", readiness: "terminal",
        resultProjection: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "unavailable" } }] } })
    if (!projected) throw new Error("History fixture could not produce a typed source projection")
    record = projected

    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt")
      VALUES ($1, $2, 'Find a role', 'running', 'test', 5, CURRENT_TIMESTAMP)`, [ids.session, ids.user])
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
      "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP),
             ($7, $2, $3, 'completed', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $8, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
    [ids.currentTurn, ids.session, ids.user, input, ids.currentRoot, workerId, ids.sourceTurn, ids.sourceRoot])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $1, NULL, '/current', 0, 'orchestrator', 'root', 'running', 'Find a role', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 3, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', NULL, CURRENT_TIMESTAMP),
             ($5, $2, $6, $5, NULL, '/source', 0, 'orchestrator', 'root', 'completed', 'Find a role', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.currentRoot, ids.session, ids.currentTurn, workerId, ids.sourceRoot, ids.sourceTurn])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/source/scout', 1, 'scout', 'scout', 'completed', 'Find roles', '[]'::jsonb, '["Find one role"]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP)`,
    [ids.child, ids.session, ids.sourceTurn, ids.sourceRoot])
    await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [ids.currentStep, ids.session, ids.currentTurn, ids.currentRoot])
    await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ($6, $2, $3, $4, 'agent_message', 'completed', 0, '{"text":"done"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [taskGraphItemId(ids.sourceRoot), ids.session, ids.sourceTurn, ids.sourceRoot, JSON.stringify(graph), ids.finalItem])
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, NULL, $4, 1, 'turn.started', 'orchestrator', $3, NULL, $5, $6::jsonb),
             ($7, $2, $8, $9, $10, 3, 'turn.completed', 'orchestrator', 'source-step', NULL, $11, $12::jsonb),
             ($13, $2, $14, NULL, $15, 5, 'turn.started', 'orchestrator', $14, NULL, $16, $17::jsonb)`,
    [`source-start-${suffix}`, ids.session, ids.sourceTurn, ids.sourceRoot, `turn:${ids.sourceTurn}:event:turn-started`, JSON.stringify({ taskId: ids.sourceRoot, rootTaskId: ids.sourceRoot }),
      ids.terminalEvent, ids.sourceTurn, ids.finalItem, ids.sourceRoot, `turn:${ids.sourceTurn}:event:turn-completed`, JSON.stringify({ turnId: ids.sourceTurn, taskId: ids.sourceRoot, finalItemId: ids.finalItem }),
      ids.currentStartEvent, ids.currentTurn, ids.currentRoot, `turn:${ids.currentTurn}:event:turn-started`, JSON.stringify({ taskId: ids.currentRoot, rootTaskId: ids.currentRoot })])
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user]).catch(() => undefined)
      await pool.end()
    }
  })

  it("validates the exact prior Root terminal event and persisted graph using the live Root attempt/Step fence", async () => {
    const store = createPgSelectedJobHistoryStore(pool!)
    const input: SelectedJobHistoryLoadInput = { lease, rootTaskId: ids.currentRoot, rootAttemptCount: 2,
      stepId: ids.currentStep, jobId, records: [record], now: new Date() }
    const sequenceBefore = await pool!.query(`SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [ids.session])

    await expect(store.load(input)).resolves.toEqual([{ record, terminalSequence: 3n }])
    const wrongSource = projectSelectedJobMemory({ jobId, sourceTurnId: ids.sourceTurn, sourceRootTaskId: `foreign-root-${suffix}`,
      throughSequence: "2", graph: { revision: 1, nodes: [{ key: "scout", templateId: "scout", goal: "Find roles",
        successCriteria: ["Find one role"], dependsOn: [], taskId: ids.child, status: "completed", readiness: "terminal",
        resultProjection: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "unavailable" } }] } })
    if (!wrongSource) throw new Error("Foreign-root fixture could not be projected")
    await expect(store.load({ ...input, records: [wrongSource] })).resolves.toEqual([])
    await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [ids.sourceTurn, JSON.stringify({ selectedJobPreparation: { jobId: "another-job" } })])
    await expect(store.load(input)).resolves.toEqual([])
    await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [ids.sourceTurn, JSON.stringify({ selectedJobPreparation: { jobId } })])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'failed' WHERE "id" = $1`, [ids.sourceRoot])
    await expect(store.load(input)).resolves.toEqual([])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed' WHERE "id" = $1`, [ids.sourceRoot])
    const newerProjection = projectSelectedJobMemory({ jobId, sourceTurnId: ids.sourceTurn, sourceRootTaskId: ids.sourceRoot,
      throughSequence: "2", graph: { revision: 2, nodes: [{ key: "scout", templateId: "scout", goal: "Find roles",
        successCriteria: ["Find one role"], dependsOn: [], taskId: ids.child, status: "completed", readiness: "terminal",
        resultProjection: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "unavailable" } }] } })
    if (!newerProjection) throw new Error("Stale graph fixture could not be projected")
    await expect(store.load({ ...input, records: [newerProjection] })).resolves.toEqual([])

    await pool!.query(`UPDATE "agent_events" SET "sequence" = 6 WHERE "id" = $1`, [ids.terminalEvent])
    await expect(store.load(input)).resolves.toEqual([])
    await pool!.query(`UPDATE "agent_events" SET "sequence" = 3 WHERE "id" = $1`, [ids.terminalEvent])

    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, 4, 'turn.completed', 'orchestrator', 'source-step-duplicate', NULL, $6, $7::jsonb)`,
    [ids.duplicateTerminalEvent, ids.session, ids.sourceTurn, ids.finalItem, ids.sourceRoot,
      `turn:${ids.sourceTurn}:event:turn-completed:duplicate`,
      JSON.stringify({ turnId: ids.sourceTurn, taskId: ids.sourceRoot, finalItemId: ids.finalItem })])
    await expect(store.load(input)).resolves.toEqual([])
    await pool!.query(`DELETE FROM "agent_events" WHERE "id" = $1`, [ids.duplicateTerminalEvent])

    await pool!.query(`DELETE FROM "agent_events" WHERE "id" = $1`, [ids.terminalEvent])
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, 3, 'turn.completed', 'orchestrator', 'source-step', $6, $7::jsonb)`,
    [ids.terminalEvent, ids.session, ids.sourceTurn, ids.finalItem, ids.child, `child-terminal:${suffix}`,
      JSON.stringify({ turnId: ids.sourceTurn, taskId: ids.sourceRoot, finalItemId: ids.finalItem })])
    await expect(store.load(input)).resolves.toEqual([])

    const sequenceAfter = await pool!.query(`SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [ids.session])
    expect(sequenceAfter.rows).toEqual(sequenceBefore.rows)
  })
})
