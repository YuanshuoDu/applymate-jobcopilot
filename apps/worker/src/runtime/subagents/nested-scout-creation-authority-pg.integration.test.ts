import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { AgentTreeManager } from "./manager.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { createSubagentTask } from "./pg-store-create.js"
import { transaction } from "./pg-store-persistence.js"
import { normalizeSubagentPolicy } from "./types.js"
import { NESTED_SCOUT_PROFILE_MARKER } from "./nested-scout-profile.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_ITEM_TYPE, TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"

const DATABASE = "applymate_nested_delegation_ci"
function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) { if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw Error("Required disposable PostgreSQL URL is missing"); return null }
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "nested_fixture"
    || url.password !== "nested_fixture_only" || url.pathname !== `/${DATABASE}` || url.search || url.hash) throw Error("Expected dedicated disposable PostgreSQL service")
  return value
}
const url = disposableUrl(), describePg = url ? describe : describe.skip
const ROOT_ACTIONS = ["jobs.search", "jobs.get", "jobs.discover", "tool_results.read", "wait_subagents", "scout.delegate", "scout.results"]
const PROFILE_ACTIONS = [...ROOT_ACTIONS]
const POLICY = normalizeSubagentPolicy({ maxConcurrency: 2, maxDepth: 2, maxFanOut: 2, maxAttempts: 2 })

describePg("nested Scout creation authority: disposable PostgreSQL", () => {
  let pool: Pool
  beforeAll(() => { pool = new Pool({ connectionString: url!, max: 5 }) })
  afterAll(async () => { await pool.end() })

  it("rejects generic Root attempts to mint the Scout profile while allowing only a persisted profile Scout to create a fenced read-scoped child", async () => {
    const suffix = randomUUID(), ids = { user: `nested-authority-user-${suffix}`, session: `nested-authority-session-${suffix}`,
      turn: `nested-authority-turn-${suffix}`, root: `nested-authority-root-${suffix}` }
    let manager: AgentTreeManager | undefined
    try {
      await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
      await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt") VALUES ($1, $2, 'nested Scout authority', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user])
      await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
        VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [ids.turn, ids.session, ids.user])
      const columns = `("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")`
      await pool.query(`INSERT INTO "sub_agent_tasks" ${columns} VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Root', '[]'::jsonb, '[]'::jsonb, $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5::jsonb, 0, 2, CURRENT_TIMESTAMP)`,
        [ids.root, ids.session, ids.turn, JSON.stringify(ROOT_ACTIONS), JSON.stringify({ subagentPolicy: POLICY })])
      await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = "id" WHERE "id" = $1`, [ids.root])
      await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
      const profileSpec = { userId: ids.user, sessionId: ids.session, turnId: ids.turn, parentTaskId: ids.root, role: "scout", taskType: "job_discovery",
        goal: "Discover bounded jobs", constraints: [], successCriteria: ["Return typed results"], allowedActions: PROFILE_ACTIONS,
        context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER }, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: POLICY }
      const before = Number((await pool.query(`SELECT count(*)::int AS count FROM "sub_agent_tasks" WHERE "sessionId" = $1`, [ids.session])).rows[0]?.count)
      await expect(transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        return createSubagentTask(client, { ...profileSpec, context: { ...profileSpec.context, nestedScoutSourceSlice: ["greenhouse"] } }, true)
      })).rejects.toThrow()
      expect(Number((await pool.query(`SELECT count(*)::int AS count FROM "sub_agent_tasks" WHERE "sessionId" = $1`, [ids.session])).rows[0]?.count)).toBe(before)
      const parent = await transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        return createSubagentTask(client, profileSpec, true, { nestedScoutAuthority: "parent_template", taskGraphChildDeadline: true })
      })
      const proposal = { expectedRevision: 0, nodes: [{ key: "scout", templateId: "scout", goal: profileSpec.goal,
        successCriteria: profileSpec.successCriteria, dependsOn: [] }] }
      const graphContent = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ ...proposal.nodes[0],
        depth: 1, taskId: parent.id }] })
      const graphItem = taskGraphItemId(ids.root)
      const graphRevision = 1, now = new Date().toISOString()
      const item = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: graphItem, sessionId: ids.session, turnId: ids.turn,
        stepId: null, taskId: ids.root, type: TASK_GRAPH_ITEM_TYPE, status: "streaming", phase: null, revision: graphRevision,
        content: graphContent, startedAt: now, completedAt: null, createdAt: now, updatedAt: now }
      const receipt = { status: "accepted", revision: graphRevision,
        nodes: [{ key: "scout", taskId: parent.id, status: "queued" }], readyTaskIds: [parent.id] }
      await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
        VALUES ($1, $2, $3, NULL, $4, $5, 'streaming', NULL, $6, $7::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [graphItem, ids.session, ids.turn, ids.root, TASK_GRAPH_ITEM_TYPE, graphRevision, JSON.stringify(graphContent)])
      await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, 1, 'item.started', 'orchestrator', $3, $6, $7::jsonb)`, [randomUUID(), ids.session, ids.turn, graphItem, ids.root,
        taskGraphProposalKey(ids.root, 0), JSON.stringify({ kind: "proposal", fingerprint: taskGraphFingerprint(proposal), revision: graphRevision, receipt, item })])
      manager = new AgentTreeManager(new PgSubagentTaskStore(pool), { heartbeatMs: 300_000 })
      const lease = await manager.claim({ taskId: parent.id, sessionId: ids.session, rootTaskId: ids.root, ownerId: "nested-authority-worker" })
      if (!lease) throw Error("Profile Scout fixture could not be claimed")
      const stepId = `nested-authority-step-${suffix}`, callId = `nested-authority-call-${suffix}`
      await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
        VALUES ($1, $2, $3, $4, 1, $5, 'waiting_for_tool', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [stepId, ids.session, ids.turn, parent.id, lease.attemptCount])
      await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [callId, ids.session, ids.turn, stepId, parent.id,
        JSON.stringify({ toolCallId: callId, toolName: "scout.delegate", toolVersion: "1" })])
      const child = await manager.spawnFromLease({ userId: ids.user, sessionId: ids.session, turnId: ids.turn, parentTaskId: parent.id,
        role: "scout", taskType: "job_discovery", goal: "Search the bounded source", constraints: [], successCriteria: ["Return typed results"],
        allowedActions: ["jobs.discover", "tool_results.read"], context: { nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [
          { source: "greenhouse", targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], maxPageSize: 20 },
        ] }, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: POLICY,
      }, `nested-authority-${suffix}`, lease, { stepId, toolCallId: callId })
      expect(child).toMatchObject({ atomic: true, duplicate: false, task: { parentTaskId: parent.id, rootTaskId: ids.root, depth: 2,
        role: "scout", taskType: "job_discovery", allowedActions: ["jobs.discover", "tool_results.read"] } })
    } finally {
      await manager?.shutdown()
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session])
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    }
  })
})
