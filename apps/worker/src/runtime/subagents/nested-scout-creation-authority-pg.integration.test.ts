import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"
import { AgentTreeManager } from "./manager.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { createSubagentTask } from "./pg-store-create.js"
import { transaction } from "./pg-store-persistence.js"
import { createNestedScoutTools } from "./nested-scout-tools.js"
import { visibleChildDefinitions } from "./child-executor-admission.js"
import { NestedScoutBudgetPolicyError, normalizeSubagentPolicy, SubagentLeaseError, SubagentLimitError, type SubagentTaskSpec } from "./types.js"
import { NESTED_SCOUT_PROFILE_MARKER } from "./nested-scout-profile.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { writePlanReceipt } from "./task-graph-pg-events.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphFingerprint, taskGraphState, taskGraphProposalKey } from "./task-graph-snapshot.js"

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

  it("rejects unregistered and privilege-escalation nested Scout attempts while allowing a persisted profile Scout to create fenced read-scoped children", async () => {
    const suffix = randomUUID(), ids = { user: `nested-authority-user-${suffix}`, session: `nested-authority-session-${suffix}`,
      turn: `nested-authority-turn-${suffix}`, root: `nested-authority-root-${suffix}` }
    let manager: AgentTreeManager | undefined, unregisteredManager: AgentTreeManager | undefined
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
      const sessionCounts = async () => {
        const tasks = await pool.query(`SELECT count(*)::int AS "count" FROM "sub_agent_tasks" WHERE "sessionId" = $1`, [ids.session])
        const outbox = await pool.query(`SELECT count(*)::int AS "count" FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session])
        return { tasks: Number(tasks.rows[0]?.count), outbox: Number(outbox.rows[0]?.count) }
      }
      const insertStep = async (taskId: string, stepId: string, attemptCount: number, ordinal: number) => pool.query(
        `INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 'waiting_for_tool', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
        [stepId, ids.session, ids.turn, taskId, ordinal, attemptCount],
      )
      const insertToolCall = async (taskId: string, stepId: string, callId: string) => pool.query(
        `INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [callId, ids.session, ids.turn, stepId, taskId, JSON.stringify({ toolCallId: callId, toolName: "scout.delegate", toolVersion: "1" })],
      )
      const profileSpec = { userId: ids.user, sessionId: ids.session, turnId: ids.turn, parentTaskId: ids.root, role: "scout", taskType: "job_discovery",
        goal: "Discover bounded jobs", constraints: [], successCriteria: ["Return typed results"], allowedActions: PROFILE_ACTIONS,
        context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER }, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: POLICY }
      const childSpecFor = (parentTaskId: string): SubagentTaskSpec => ({ userId: ids.user, sessionId: ids.session, turnId: ids.turn, parentTaskId,
        role: "scout", taskType: "job_discovery", goal: "Search the bounded source", constraints: [], successCriteria: ["Return typed results"],
        allowedActions: ["jobs.discover", "tool_results.read"], context: { nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [
          { source: "greenhouse", targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], maxPageSize: 20 },
        ] }, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: POLICY })
      const before = Number((await pool.query(`SELECT count(*)::int AS count FROM "sub_agent_tasks" WHERE "sessionId" = $1`, [ids.session])).rows[0]?.count)
      await expect(transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        return createSubagentTask(client, { ...profileSpec, context: { ...profileSpec.context, nestedScoutSourceSlice: ["greenhouse"] } }, true)
      })).rejects.toThrow()
      expect(Number((await pool.query(`SELECT count(*)::int AS count FROM "sub_agent_tasks" WHERE "sessionId" = $1`, [ids.session])).rows[0]?.count)).toBe(before)
      const unregistered = await transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        return createSubagentTask(client, { ...profileSpec, goal: "Unregistered profile Scout" }, true,
          { nestedScoutAuthority: "parent_template", taskGraphChildDeadline: true })
      })
      unregisteredManager = new AgentTreeManager(new PgSubagentTaskStore(pool), { heartbeatMs: 300_000 })
      const unregisteredLease = await unregisteredManager.claim({ taskId: unregistered.id, sessionId: ids.session, rootTaskId: ids.root, ownerId: "unregistered-scout-worker" })
      if (!unregisteredLease) throw Error("Unregistered profile Scout fixture could not be claimed")
      const unregisteredStepId = `nested-authority-unregistered-step-${suffix}`, unregisteredCallId = `nested-authority-unregistered-call-${suffix}`
      await insertStep(unregistered.id, unregisteredStepId, unregisteredLease.attemptCount, 1)
      await insertToolCall(unregistered.id, unregisteredStepId, unregisteredCallId)
      const beforeUnregisteredSpawn = await sessionCounts()
      await expect(unregisteredManager.spawnFromLease(childSpecFor(unregistered.id), `unregistered-${suffix}`, unregisteredLease,
        { stepId: unregisteredStepId, toolCallId: unregisteredCallId })).rejects.toMatchObject({ name: SubagentLeaseError.name, code: "lost" })
      expect(await sessionCounts()).toEqual(beforeUnregisteredSpawn)
      await unregisteredManager.shutdown()
      const parent = await transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        return createSubagentTask(client, profileSpec, true, { nestedScoutAuthority: "parent_template", taskGraphChildDeadline: true })
      })
      const proposal = { expectedRevision: 0, nodes: [{ key: "scout", templateId: "scout", goal: profileSpec.goal,
        successCriteria: profileSpec.successCriteria, dependsOn: [] }] }
      const graphContent = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ ...proposal.nodes[0],
        depth: 1, taskId: parent.id }] })
      const graphRevision = 1
      const graphState = taskGraphState(graphContent, graphRevision, new Map([[parent.id, { status: "queued" as const, failureReason: null }]]), [])
      const receipt = { status: "accepted" as const, revision: graphRevision,
        nodes: [{ key: "scout", taskId: parent.id, status: "queued" as const }], readyTaskIds: [parent.id] }
      // Use the canonical writer so this proposal shares the Session sequence with task and lifecycle events.
      await transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        await writePlanReceipt(client, { scope: { userId: ids.user, sessionId: ids.session, turnId: ids.turn,
          rootTaskId: ids.root, parentTaskId: ids.root }, state: graphState, snapshot: graphContent, expectedRevision: 0,
        now: new Date(), idempotencyKey: taskGraphProposalKey(ids.root, 0), fingerprint: taskGraphFingerprint(proposal), receipt })
      })
      manager = new AgentTreeManager(new PgSubagentTaskStore(pool), { heartbeatMs: 300_000 })
      const lease = await manager.claim({ taskId: parent.id, sessionId: ids.session, rootTaskId: ids.root, ownerId: "nested-authority-worker" })
      if (!lease) throw Error("Profile Scout fixture could not be claimed")
      const stepId = `nested-authority-step-${suffix}`, callId = `nested-authority-call-${suffix}`
      await insertStep(parent.id, stepId, lease.attemptCount, 2)
      await insertToolCall(parent.id, stepId, callId)
      const childSpec = childSpecFor(parent.id)
      const spawnKey = `nested-authority-${suffix}`
      const treeCounts = async (parentTaskId: string) => {
        const session = await sessionCounts()
        const children = await pool.query(`SELECT count(*)::int AS "count" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2`, [ids.session, parentTaskId])
        return { ...session, children: Number(children.rows[0]?.count) }
      }
      const nestedDefinitions = createNestedScoutTools({ pool, lease, profile: { sourceSlice: ["greenhouse"] }, subagentManager: () => manager })
      expect(visibleChildDefinitions(lease, nestedDefinitions).map(definition => definition.name)).toEqual(["scout.delegate", "scout.results"])
      const beforeProfileFilters = await treeCounts(parent.id)
      for (const context of [
        { ...lease.context as object, selectedJobPreparation: { jobId: "selected-job" } },
        { ...lease.context as object, scheduledAutomationCriteria: { targetRoles: ["Engineer"], targetLocations: ["Dublin"], minScore: 80 } },
      ]) {
        expect(visibleChildDefinitions({ ...lease, context }, nestedDefinitions).map(definition => definition.name)).toEqual([])
      }
      expect(await treeCounts(parent.id)).toEqual(beforeProfileFilters)
      for (const [key, limit] of [["maxInputTokens", 0], ["maxOutputTokens", 0], ["maxCostUsd", 0]] as const) {
        await pool.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3`,
          [ids.root, JSON.stringify({ limits: { [key]: limit }, subagentPolicy: POLICY }), ids.session])
        const before = await treeCounts(parent.id)
        await expect(manager.spawnFromLease(childSpec, `${spawnKey}-${key}`, lease, { stepId, toolCallId: callId }))
          .rejects.toBeInstanceOf(NestedScoutBudgetPolicyError)
        expect(await treeCounts(parent.id)).toEqual(before)
      }
      await pool.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3`,
        [ids.root, JSON.stringify({ limits: { maxSteps: 32, maxToolCalls: 16 }, subagentPolicy: POLICY }), ids.session])
      const deniedChildSpecs: readonly { label: string; spec: SubagentTaskSpec }[] = [
        { label: "selected-job child context", spec: { ...childSpec, context: { ...childSpec.context as object, selectedJobPreparation: { jobId: "selected-job" } } } },
        { label: "scheduled child context", spec: { ...childSpec, context: { ...childSpec.context as object, scheduledAutomationCriteria: { targetRoles: ["Engineer"], targetLocations: ["Dublin"], minScore: 80 } } } },
        { label: "forged profile marker", spec: { ...childSpec, context: { ...childSpec.context as object, nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER } } },
        { label: "foreign template marker", spec: { ...childSpec, context: { ...childSpec.context as object, nestedScoutProfile: "foreign:scout-template:v1" } } },
        { label: "non-Scout role", spec: { ...childSpec, role: "analyst", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" } } },
        { label: "external application write", spec: { ...childSpec, allowedActions: [...(childSpec.allowedActions ?? []), "application.submit"] } },
        { label: "scheduled application prepare", spec: { ...childSpec, allowedActions: [...(childSpec.allowedActions ?? []), "scheduled.application.prepare"] } },
      ]
      for (const [index, denied] of deniedChildSpecs.entries()) {
        const beforeDeniedSpawn = await treeCounts(parent.id)
        await expect(manager.spawnFromLease(denied.spec, `${spawnKey}-denied-${index}`, lease, { stepId, toolCallId: callId }))
          .rejects.toMatchObject({ name: SubagentLeaseError.name, code: "lost" })
        expect(await treeCounts(parent.id), denied.label).toEqual(beforeDeniedSpawn)
      }
      const child = await manager.spawnFromLease(childSpec, spawnKey, lease, { stepId, toolCallId: callId })
      const childId = child.task?.id
      if (!childId) throw Error("Nested Scout child was not returned")
      expect(child).toMatchObject({ atomic: true, duplicate: false, task: { parentTaskId: parent.id, rootTaskId: ids.root, depth: 2,
        role: "scout", taskType: "job_discovery", allowedActions: ["jobs.discover", "tool_results.read"] } })
      const afterCreate = await treeCounts(parent.id)
      const replay = await manager.spawnFromLease(childSpec, spawnKey, lease, { stepId, toolCallId: callId })
      expect(replay).toMatchObject({ atomic: true, duplicate: true, task: { id: childId } })
      expect(await treeCounts(parent.id)).toEqual(afterCreate)
      await pool.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3`,
        [ids.root, JSON.stringify({ limits: { maxCostUsd: 0 }, subagentPolicy: POLICY }), ids.session])
      await expect(manager.spawnFromLease(childSpec, spawnKey, lease, { stepId, toolCallId: callId })).rejects.toBeInstanceOf(NestedScoutBudgetPolicyError)
      expect(await treeCounts(parent.id)).toEqual(afterCreate)
      await pool.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3`,
        [ids.root, JSON.stringify({ limits: { maxSteps: 32, maxToolCalls: 16 }, subagentPolicy: POLICY }), ids.session])

      const secondCallId = `nested-authority-second-call-${suffix}`
      await insertToolCall(parent.id, stepId, secondCallId)
      const second = await manager.spawnFromLease(childSpec, `${spawnKey}-second`, lease, { stepId, toolCallId: secondCallId })
      const secondChildId = second.task?.id
      if (!secondChildId) throw Error("Second nested Scout child was not returned")
      expect(second).toMatchObject({ atomic: true, duplicate: false, task: { parentTaskId: parent.id, rootTaskId: ids.root, depth: 2,
        role: "scout", taskType: "job_discovery", allowedActions: ["jobs.discover", "tool_results.read"] } })

      const childLease = await manager.claim({ taskId: childId, sessionId: ids.session, rootTaskId: ids.root, ownerId: "nested-child-worker" })
      if (!childLease) throw Error("Depth-two Scout fixture could not be claimed")
      const childStepId = `nested-authority-depth-two-step-${suffix}`, childCallId = `nested-authority-depth-two-call-${suffix}`
      await insertStep(childId, childStepId, childLease.attemptCount, 3)
      await insertToolCall(childId, childStepId, childCallId)
      const beforeDepthTwoSpawn = await treeCounts(parent.id)
      await expect(manager.spawnFromLease(childSpecFor(childId), `${spawnKey}-depth-two`, childLease,
        { stepId: childStepId, toolCallId: childCallId })).rejects.toMatchObject({ name: SubagentLeaseError.name, code: "lost" })
      expect(await treeCounts(parent.id)).toEqual(beforeDepthTwoSpawn)

      const thirdCallId = `nested-authority-third-call-${suffix}`
      await insertToolCall(parent.id, stepId, thirdCallId)
      const beforeFanoutLimit = await treeCounts(parent.id)
      await expect(manager.spawnFromLease(childSpec, `${spawnKey}-third`, lease, { stepId, toolCallId: thirdCallId }))
        .rejects.toMatchObject({ name: SubagentLimitError.name, code: "fan_out" })
      expect(await treeCounts(parent.id)).toEqual(beforeFanoutLimit)
    } finally {
      await unregisteredManager?.shutdown()
      await manager?.shutdown()
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session])
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    }
  })
})
