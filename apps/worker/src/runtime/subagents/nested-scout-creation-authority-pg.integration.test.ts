import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"
import { executionOwnerFence, type ExecutionOwnerFence } from "../execution-owner.js"
import { claimTurnLease } from "../turns/lease.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { executionId, executionKey } from "../turns/turn-execution-types.js"
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

type BudgetRootFixture = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; owner: ExecutionOwnerFence }>

async function createBudgetRootFixture(pool: Pool, userId: string, suffix: string, policy = POLICY): Promise<BudgetRootFixture> {
  const sessionId = `nested-budget-session-${suffix}`, turnId = `nested-budget-turn-${suffix}`
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'nested Scout shared tool budget', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'queued', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [turnId, sessionId, userId])
  const turnLease = await claimTurnLease(pool, { turnId, sessionId, ownerId: `nested-budget-root-owner-${suffix}` })
  const root = await transaction(pool, async client => {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
    return createSubagentTask(client, { userId, sessionId, turnId, role: "orchestrator", taskType: "root",
      goal: "Bound nested Scout tool calls", constraints: [], successCriteria: [], allowedActions: ROOT_ACTIONS,
      context: {}, expectedOutputSchema: {}, policy }, false)
  })
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1 AND "sessionId" = $3`,
    [turnId, root.id, sessionId])
  await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "attemptCount" = 1, "leaseOwner" = $2,
    "leaseExpiresAt" = $3, "budgetSnapshot" = $4::jsonb WHERE "id" = $1 AND "sessionId" = $5`, [
    root.id, turnLease.ownerId, turnLease.leaseExpiresAt,
    JSON.stringify({ limits: { maxSteps: 16, maxToolCalls: 2 }, subagentPolicy: policy }), sessionId,
  ])
  return { userId, sessionId, turnId, rootTaskId: root.id, owner: executionOwnerFence({ kind: "turn", taskId: root.id, lease: turnLease }) }
}

async function createBudgetScoutChildren(pool: Pool, fixture: BudgetRootFixture, manager: AgentTreeManager, suffix: string, policy = POLICY) {
  const parentSpec = { userId: fixture.userId,
    sessionId: fixture.sessionId, turnId: fixture.turnId, parentTaskId: fixture.rootTaskId, role: "scout", taskType: "job_discovery",
    goal: "Bounded Scout parent", constraints: [], successCriteria: ["Return typed results"], allowedActions: PROFILE_ACTIONS,
    context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER }, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy }
  const parent = await transaction(pool, async client => {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [parentSpec.userId])
    return createSubagentTask(client, parentSpec, false, { nestedScoutAuthority: "parent_template", taskGraphChildDeadline: true })
  })
  const childScope = { nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [
    { source: "greenhouse", targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], maxPageSize: 20 },
  ] }
  const childSpec = { ...parentSpec, parentTaskId: parent.id, goal: "Read-only scoped child",
    allowedActions: ["jobs.discover", "tool_results.read"], context: childScope }
  const children = await Promise.all([0, 1].map(index => transaction(pool, async client => {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [parentSpec.userId])
    return createSubagentTask(client, childSpec, false, { nestedScoutAuthority: "child_execution", taskGraphChildDeadline: true })
  })))
  await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'waiting' WHERE "id" = $1 AND "sessionId" = $2`,
    [parent.id, fixture.sessionId])
  const leases = await Promise.all(children.map(async (child, index) => {
    const ownerId = `nested-budget-child-owner-${suffix}-${index}`
    const lease = await manager.claim({ taskId: child.id, sessionId: fixture.sessionId, rootTaskId: fixture.rootTaskId, ownerId })
    if (!lease) throw Error("Nested Scout budget child could not be claimed")
    return lease
  }))
  return leases
}

async function startBudgetStep(pool: Pool, owner: ExecutionOwnerFence, stepId: string, attempt: number): Promise<void> {
  await createPgTurnEngineStore(pool).startStep({ owner, stepId, ordinal: 0, attempt, inputThroughSequence: 0n,
    consumedInputIds: [], modelProfileSnapshot: {}, now: new Date() })
}

async function admitBudgetToolCall(pool: Pool, owner: ExecutionOwnerFence, stepId: string, callId: string): Promise<string> {
  const store = createPgTurnEngineStore(pool), itemId = executionId(owner, `item:tool-call:${callId}`)
  const now = new Date()
  await store.createItem({ owner, itemId, stepId, type: "tool_call", status: "started", phase: null,
    content: { toolCallId: callId, toolName: "jobs.discover", toolVersion: "1", input: {} }, now })
  const itemStartedId = executionId(owner, `event:item-started:${itemId}`), key = executionKey(owner)
  await store.appendEvent({ owner, id: itemStartedId, type: "item.started", itemId, correlationId: stepId, causationId: null,
    idempotencyKey: `${key}:event:item-started:${itemId}`, payload: { itemId, type: "tool_call", phase: null } })
  await store.appendEvent({ owner, id: executionId(owner, `event:tool-started:${callId}`), type: "tool_call.started", itemId,
    correlationId: callId, causationId: itemStartedId, idempotencyKey: `${key}:event:tool-started:${callId}`,
    payload: { toolCallId: callId, toolName: "jobs.discover", taskId: owner.taskId } })
  return itemId
}

async function countBudgetEvidence(pool: Pool, fixture: BudgetRootFixture, callId: string) {
  const result = await pool.query<{ items: number; startedEvents: number }>(`SELECT
      (SELECT count(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'tool_call'
        AND "content"->>'toolCallId' = $3) AS "items",
      (SELECT count(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "type" = 'tool_call.started' AND "payload"->>'toolCallId' = $3) AS "startedEvents"`,
    [fixture.sessionId, fixture.turnId, callId])
  return result.rows[0]
}

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

  it("enforces the shared Root maxToolCalls cap across competing nested Scout child leases", async () => {
    const suffix = randomUUID(), userId = `nested-budget-user-${suffix}`, sessions: string[] = []
    let manager: AgentTreeManager | undefined
    try {
      await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
        [userId, `${userId}@example.invalid`])
      const rootSuffix = `${suffix}-capped`, controlSuffix = `${suffix}-control`
      // maxConcurrency counts the running Root task too, so three slots are needed for Root plus both child leases.
      // The shared tool-call cap under test remains exactly two.
      const rootPolicy = normalizeSubagentPolicy({ ...POLICY, maxConcurrency: 3 })
      sessions.push(`nested-budget-session-${rootSuffix}`, `nested-budget-session-${controlSuffix}`)
      const root = await createBudgetRootFixture(pool, userId, rootSuffix, rootPolicy)
      const controlRoot = await createBudgetRootFixture(pool, userId, controlSuffix)
      manager = new AgentTreeManager(new PgSubagentTaskStore(pool), { heartbeatMs: 300_000 })
      const childLeases = await createBudgetScoutChildren(pool, root, manager, suffix, rootPolicy)
      expect(childLeases).toHaveLength(2)
      expect(manager.activeCount(root.sessionId)).toBe(2)
      expect(new Set(childLeases.map(lease => lease.ownerId)).size).toBe(2)
      expect(childLeases.every(lease => lease.rootTaskId === root.rootTaskId
        && lease.sessionId === root.sessionId && lease.turnId === root.turnId
        && lease.leaseExpiresAt.getTime() > Date.now())).toBe(true)
      const childLeaseRows = await pool.query<{ id: string; status: string; leaseOwner: string | null; attemptCount: number; rootTaskId: string | null; leaseExpiresAt: Date | null }>(
        `SELECT "id", "status", "leaseOwner", "attemptCount", "rootTaskId", "leaseExpiresAt"
          FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "id" = ANY($2::text[]) ORDER BY "id"`,
        [root.sessionId, childLeases.map(lease => lease.id)])
      expect(childLeaseRows.rows).toHaveLength(2)
      expect(childLeaseRows.rows.map(row => ({ id: row.id, status: row.status, leaseOwner: row.leaseOwner,
        attemptCount: row.attemptCount, rootTaskId: row.rootTaskId, live: !!row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now() }))
        .sort((left, right) => left.id.localeCompare(right.id))).toEqual(childLeases.map(lease => ({ id: lease.id,
          status: "running", leaseOwner: lease.ownerId, attemptCount: lease.attemptCount, rootTaskId: root.rootTaskId, live: true }))
          .sort((left, right) => left.id.localeCompare(right.id)))

      const rootStepId = `nested-budget-root-step-${suffix}`
      await startBudgetStep(pool, root.owner, rootStepId, 1)
      await admitBudgetToolCall(pool, root.owner, rootStepId, `nested-budget-root-call-${suffix}`)

      const contenders = await Promise.all(childLeases.map(async (lease, index) => {
        const owner = executionOwnerFence({ kind: "task", lease })
        const stepId = `nested-budget-child-step-${suffix}-${index}`
        const callId = `nested-budget-child-call-${suffix}-${index}`
        await startBudgetStep(pool, owner, stepId, lease.attemptCount)
        return { owner, stepId, callId }
      }))
      const attempts = await Promise.allSettled(contenders.map(contender =>
        admitBudgetToolCall(pool, contender.owner, contender.stepId, contender.callId)))
      const accepted = attempts.flatMap((attempt, index) => attempt.status === "fulfilled" ? [contenders[index]!] : [])
      const denied = attempts.flatMap((attempt, index) => attempt.status === "rejected" ? [{ contender: contenders[index]!, error: attempt.reason }] : [])
      expect(accepted).toHaveLength(1)
      expect(denied).toHaveLength(1)
      expect(denied[0]!.error).toMatchObject({ code: "budget_exhausted", metric: "tool_calls", limit: 2, used: 2, attempted: 3 })

      const durableCalls = await pool.query<{ taskId: string; callId: string }>(`SELECT "taskId", "content"->>'toolCallId' AS "callId"
        FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'tool_call' ORDER BY "id"`,
      [root.sessionId, root.turnId])
      expect(durableCalls.rows).toHaveLength(2)
      expect(durableCalls.rows.map(row => row.callId).sort()).toEqual([
        `nested-budget-root-call-${suffix}`, accepted[0]!.callId,
      ].sort())
      expect(durableCalls.rows.filter(row => row.taskId === accepted[0]!.owner.taskId)).toHaveLength(1)
      expect(await countBudgetEvidence(pool, root, denied[0]!.contender.callId)).toEqual({ items: 0, startedEvents: 0 })
      expect(await countBudgetEvidence(pool, root, accepted[0]!.callId)).toEqual({ items: 1, startedEvents: 1 })

      const controlStepId = `nested-budget-control-step-${suffix}`
      await startBudgetStep(pool, controlRoot.owner, controlStepId, 1)
      await expect(admitBudgetToolCall(pool, controlRoot.owner, controlStepId, `nested-budget-control-call-${suffix}`))
        .resolves.toBe(executionId(controlRoot.owner, `item:tool-call:nested-budget-control-call-${suffix}`))
      expect(await countBudgetEvidence(pool, controlRoot, `nested-budget-control-call-${suffix}`))
        .toEqual({ items: 1, startedEvents: 1 })
    } finally {
      await manager?.shutdown()
      for (const sessionId of sessions) await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [sessionId])
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [userId])
    }
  })
})
