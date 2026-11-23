import { describe, expect, it, vi } from "vitest"
import { assertPlanningRootHasNoUnresolvedSteering, assertTerminalPlanningRootHasNoUnresolvedSteering, createSubagentTask } from "./pg-store-create.js"
import { assertSessionTerminalAdmission } from "../session-gate.js"

const { assertNoUnresolvedSteeringMock } = vi.hoisted(() => ({ assertNoUnresolvedSteeringMock: vi.fn() }))
const { terminalSteeringReadMock } = vi.hoisted(() => ({ terminalSteeringReadMock: vi.fn() }))
vi.mock("./steering-reconciliation-ledger.js", async importOriginal => ({
  ...await importOriginal<typeof import("./steering-reconciliation-ledger.js")>(),
  assertNoUnresolvedSteering: assertNoUnresolvedSteeringMock,
}))
vi.mock("./steering-reconciliation-read.js", async importOriginal => ({
  ...await importOriginal<typeof import("./steering-reconciliation-read.js")>(),
  readSteeringReconciliationStateForTerminal: (...args: unknown[]) => terminalSteeringReadMock(...args),
}))
import { normalizeSubagentPolicy } from "./types.js"
import type { Queryable } from "./pg-store-persistence.js"
import { NESTED_SCOUT_PROFILE_MARKER } from "./nested-scout-profile.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import type { GraphScope } from "./task-graph-pg-state.js"

function authorityParent(overrides: Record<string, unknown> = {}) {
  return {
    id: "parent-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/parent-1", depth: 1,
    role: "scout", taskType: "job_discovery", status: "running",
    allowedActions: ["jobs.discover", "tool_results.read", "wait_subagents", "scout.delegate", "scout.results"],
    context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER },
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {}, ...overrides,
  }
}

function authorityRoot(overrides: Record<string, unknown> = {}) {
  return {
    id: "root-1", rootTaskId: "root-1", parentTaskId: null, turnId: "turn-1", path: "/root-1", depth: 0,
    role: "orchestrator", taskType: "root", status: "running", allowedActions: [], context: {}, expectedOutputSchema: {},
    modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {}, ...overrides,
  }
}

function authorizedCreateFixture(parent: Record<string, unknown>, childOverrides: Record<string, unknown> = {}, totalChildren = 0,
  objectiveAuthorityRows: readonly Record<string, unknown>[] = []) {
  const calls: string[] = []
  const insertValues: unknown[][] = []
  const child = {
    id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "parent-1",
    path: "/root-1/parent-1/child-1", depth: 2, role: "scout", taskType: "job_discovery", status: "queued", goal: "inspect",
    constraints: [], successCriteria: [], allowedActions: ["jobs.discover", "tool_results.read"], context: {},
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, result: null, failureReason: null,
    attemptCount: 0, maxAttempts: 3, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null,
    interruptRequestedAt: null, modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {}, ...childOverrides,
  }
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('FROM live') && sql.includes('JOIN "agent_steps" AS step')) {
        const [sessionId, userId, turnId, rootTaskId, turnLeaseOwner, turnLeaseVersion, parentLeaseOwner, parentAttemptCount, stepId] = params ?? []
        const rows = objectiveAuthorityRows.filter(row => row.sessionId === sessionId && row.userId === userId
          && row.sessionStatus !== "aborted" && row.sessionStatus !== "archived" && row.turnId === turnId
          && row.turnSource === "user" && (row.executionMode === null || row.executionMode === "canonical_task_graph") && row.turnStatus === "in_progress"
          && row.turnRootTaskId === rootTaskId && row.turnLeaseOwner === turnLeaseOwner && row.turnLeaseVersion === turnLeaseVersion
          && row.rootTaskId === rootTaskId && row.rootRootTaskId === rootTaskId && row.rootParentTaskId == null
          && row.rootRole === "orchestrator" && row.rootTaskType === "root" && row.rootStatus === "running"
          && row.parentLeaseOwner === parentLeaseOwner && row.parentAttemptCount === parentAttemptCount && row.interruptRequestedAt == null
          && row.stepId === stepId && row.stepTaskId === rootTaskId && row.stepStatus === "streaming")
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('UPDATE "agent_turns" AS turn SET')) {
        const [turnId, sessionId, userId, rootTaskId, turnLeaseOwner, turnLeaseVersion] = params ?? []
        const matchingNullMode = objectiveAuthorityRows.some(row => row.turnId === turnId && row.sessionId === sessionId
          && row.userId === userId && row.turnRootTaskId === rootTaskId && row.turnSource === "user"
          && row.executionMode === null && row.turnStatus === "in_progress" && row.turnLeaseOwner === turnLeaseOwner
          && row.turnLeaseVersion === turnLeaseVersion)
        return { rows: matchingNullMode ? [{ id: turnId }] : [], rowCount: matchingNullMode ? 1 : 0 }
      }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('SELECT "rootTaskId", "turnId"')) return { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" WHERE') && sql.includes("FOR UPDATE")) return { rows: [parent], rowCount: 1 }
      if (sql.includes("COUNT(*)") && sql.includes('"status" NOT IN')) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: totalChildren }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) { insertValues.push(params ?? []); return { rows: [{ id: "child-1" }], rowCount: 1 } }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [child], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
  } as unknown as Queryable
  return { client, calls, insertValues }
}

describe("pg-store task creation helpers", () => {
  it("allows only exact owned objective child specs past the parent action subset check", async () => {
    const scope: GraphScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 2, parentLeaseOwner: "root-owner", parentAttemptCount: 1 }
    const actions = ["jobs.search", "jobs.get", "jobs.discover", "tool_results.read"]
    const row = { sessionId: scope.sessionId, userId: scope.userId, sessionStatus: "active", turnId: scope.turnId,
      turnSource: "user", executionMode: "canonical_task_graph", turnStatus: "in_progress", turnRootTaskId: scope.rootTaskId,
      turnLeaseOwner: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion,
      input: { goal: "Find roles", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT },
      rootTaskId: scope.rootTaskId, rootRootTaskId: scope.rootTaskId, rootParentTaskId: null, rootRole: "orchestrator",
      rootTaskType: "root", rootStatus: "running", parentLeaseOwner: scope.parentLeaseOwner, parentAttemptCount: scope.parentAttemptCount,
      interruptRequestedAt: null, stepId: scope.stepId, stepTaskId: scope.rootTaskId, stepStatus: "streaming" }
    const parent = authorityRoot({ allowedActions: ["agent.plan", "agent.wait", "agent.list"] })
    const fixture = authorizedCreateFixture(parent, {}, 0, [row])
    const task = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: "scout", taskType: "job_discovery", goal: "Find roles", constraints: TASK_GRAPH_TEMPLATES.scout.constraints,
      successCriteria: ["Return matching jobs"], allowedActions: actions, context: {},
      expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, policy: normalizeSubagentPolicy() }
    await createSubagentTask(fixture.client, task, true, { objectiveTaskGraphChildAuthority: scope })
    expect(fixture.insertValues).toHaveLength(1)
    expect(fixture.insertValues[0]?.[12]).toBe(JSON.stringify(actions))

    const legacyMode = authorizedCreateFixture(parent, {}, 0, [{ ...row, executionMode: null }])
    await createSubagentTask(legacyMode.client, task, true, { objectiveTaskGraphChildAuthority: scope })
    const promotionIndex = legacyMode.calls.findIndex(sql => sql.startsWith('UPDATE "agent_turns" AS turn SET'))
    const insertIndex = legacyMode.calls.findIndex(sql => sql.startsWith('INSERT INTO "sub_agent_tasks"'))
    expect(promotionIndex).toBeGreaterThanOrEqual(0)
    expect(promotionIndex).toBeLessThan(insertIndex)

    const fake = authorizedCreateFixture(parent)
    await expect(createSubagentTask(fake.client, task, true, { objectiveTaskGraphChildAuthority: scope }))
      .rejects.toThrow("Child allowed actions exceed parent policy")
    expect(fake.insertValues).toHaveLength(0)

    const stale = authorizedCreateFixture(parent, {}, 0, [row])
    await expect(createSubagentTask(stale.client, task, true, { objectiveTaskGraphChildAuthority: { ...scope, stepId: "old-step" } }))
      .rejects.toThrow("Child allowed actions exceed parent policy")
    expect(stale.insertValues).toHaveLength(0)

    const altered = authorizedCreateFixture(parent, {}, 0, [row])
    await expect(createSubagentTask(altered.client, { ...task, allowedActions: [...actions, "applications.submit"] }, true,
      { objectiveTaskGraphChildAuthority: scope })).rejects.toThrow("Child allowed actions exceed parent policy")
    expect(altered.insertValues).toHaveLength(0)

    const analystActions = TASK_GRAPH_TEMPLATES.analyst.allowedActions
    const analystTask = { ...task, role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType,
      constraints: TASK_GRAPH_TEMPLATES.analyst.constraints, allowedActions: analystActions,
      expectedOutputSchema: TASK_GRAPH_TEMPLATES.analyst.expectedOutputSchema }
    const analystChild = { role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, allowedActions: analystActions,
      expectedOutputSchema: TASK_GRAPH_TEMPLATES.analyst.expectedOutputSchema }
    const admittedAnalyst = authorizedCreateFixture(parent, analystChild, 0, [row])
    await createSubagentTask(admittedAnalyst.client, analystTask, true, { objectiveTaskGraphChildAuthority: scope })
    expect(admittedAnalyst.insertValues[0]?.[12]).toBe(JSON.stringify(analystActions))

    const foreignAnalyst = authorizedCreateFixture(parent, analystChild, 0, [{ ...row, userId: "foreign-user" }])
    await expect(createSubagentTask(foreignAnalyst.client, analystTask, true, { objectiveTaskGraphChildAuthority: scope }))
      .rejects.toThrow("Child allowed actions exceed parent policy")
    expect(foreignAnalyst.insertValues).toHaveLength(0)

    const alteredAnalyst = authorizedCreateFixture(parent, analystChild, 0, [row])
    await expect(createSubagentTask(alteredAnalyst.client, { ...analystTask, allowedActions: [...analystActions, "applications.submit"] }, true,
      { objectiveTaskGraphChildAuthority: scope })).rejects.toThrow("Child allowed actions exceed parent policy")
    expect(alteredAnalyst.insertValues).toHaveLength(0)

    const noAuthority = authorizedCreateFixture(parent, analystChild, 0, [row])
    await expect(createSubagentTask(noAuthority.client, analystTask, true)).rejects.toThrow("Child allowed actions exceed parent policy")
    expect(noAuthority.insertValues).toHaveLength(0)
  })

  it("keeps the root bootstrap action union while rejecting unproven nested actions and context", async () => {
    const rootActions = ["scout.delegate", "scout.results", "agent.plan"]
    const rootFixture = authorizedCreateFixture(authorityRoot(), { parentTaskId: null, depth: 0, allowedActions: rootActions })
    await createSubagentTask(rootFixture.client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", role: "orchestrator", taskType: "root",
      goal: "plan", allowedActions: rootActions, context: {}, policy: normalizeSubagentPolicy(),
    }, true)
    expect(rootFixture.insertValues[0]?.[12]).toBe(JSON.stringify(rootActions))

    for (const input of [
      { parentTaskId: "parent-1", allowedActions: ["scout.delegate"] },
      { parentTaskId: "parent-1", allowedActions: ["scout.results"] },
      { parentTaskId: "parent-1", allowedActions: [], context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER } },
      { parentTaskId: undefined, allowedActions: ["scout.delegate"], context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER } },
    ]) {
      const client = { query: vi.fn() } as unknown as Queryable
      await expect(createSubagentTask(client, {
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", role: "analyst", taskType: "research",
        goal: "inspect", policy: normalizeSubagentPolicy(), ...input,
      }, true)).rejects.toThrow("nested_scout_creation_authority_unavailable")
      expect(client.query).not.toHaveBeenCalled()
    }
  })

  it("inherits generic child actions without granting nested Scout controls", async () => {
    const actions = ["jobs.search", "wait_subagents", "scout.delegate", "scout.results"]
    const parent = { ...authorityParent(), role: "analyst", taskType: "research", allowedActions: actions }
    const fixture = authorizedCreateFixture(parent, { allowedActions: ["jobs.search", "wait_subagents"] })
    const child = await createSubagentTask(fixture.client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "analyst", taskType: "research", goal: "inspect", policy: normalizeSubagentPolicy(),
    }, true)
    expect(fixture.insertValues[0]?.[12]).toBe(JSON.stringify(["jobs.search", "wait_subagents"]))
    expect(child.allowedActions).toEqual(["jobs.search", "wait_subagents"])
  })

  it("accepts parent-template authority only for a typed direct Scout template", async () => {
    const actions = ["jobs.discover", "tool_results.read", "wait_subagents", "scout.delegate", "scout.results"]
    const context = { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER }
    const fixture = authorizedCreateFixture(authorityRoot({ allowedActions: actions }), {
      parentTaskId: "root-1", depth: 1, allowedActions: actions, context,
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    })
    await createSubagentTask(fixture.client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1",
      role: "scout", taskType: "job_discovery", goal: "discover", allowedActions: actions, context,
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: normalizeSubagentPolicy(),
    }, true, { nestedScoutAuthority: "parent_template" })
    expect(fixture.insertValues[0]?.[12]).toBe(JSON.stringify(actions))
    expect(fixture.insertValues[0]?.[13]).toBe(JSON.stringify(context))

    const invalid = authorizedCreateFixture(authorityRoot({ allowedActions: actions, taskType: "research" }), {
      parentTaskId: "root-1", depth: 1, allowedActions: actions, context,
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    })
    await expect(createSubagentTask(invalid.client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1",
      role: "scout", taskType: "job_discovery", goal: "discover", allowedActions: actions, context,
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: normalizeSubagentPolicy(),
    }, true, { nestedScoutAuthority: "parent_template" })).rejects.toThrow("nested_scout_creation_authority_invalid")
    expect(invalid.insertValues).toHaveLength(0)
  })

  it("accepts child-execution authority only beneath the database-locked Scout profile", async () => {
    const context = {
      nestedScoutSourceSlice: ["greenhouse"],
      nestedScoutQueryScope: [{ source: "greenhouse", targetRoles: ["Engineer"], targetLocations: ["Dublin"], maxPageSize: 20 }],
    }
    const actions = ["jobs.discover", "tool_results.read"]
    const fixture = authorizedCreateFixture(authorityParent(), { context, allowedActions: actions })
    await createSubagentTask(fixture.client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "scout", taskType: "job_discovery", goal: "inspect", allowedActions: actions, context,
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: normalizeSubagentPolicy(),
    }, true, { nestedScoutAuthority: "child_execution" })
    expect(fixture.insertValues[0]?.[12]).toBe(JSON.stringify(actions))
    expect(fixture.insertValues[0]?.[13]).toBe(JSON.stringify(context))

    const invalid = authorizedCreateFixture(authorityParent({ role: "analyst" }), { context, allowedActions: actions })
    await expect(createSubagentTask(invalid.client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "scout", taskType: "job_discovery", goal: "inspect", allowedActions: actions, context,
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: normalizeSubagentPolicy(),
    }, true, { nestedScoutAuthority: "child_execution" })).rejects.toThrow("nested_scout_creation_authority_invalid")
    expect(invalid.insertValues).toHaveLength(0)
  })

  it("caps nested children for the parent's lifetime, including terminal children and tighter policy", async () => {
    const context = {
      nestedScoutSourceSlice: ["greenhouse"],
      nestedScoutQueryScope: [{ source: "greenhouse", targetRoles: ["Engineer"], targetLocations: [], maxPageSize: 20 }],
    }
    const actions = ["jobs.discover", "tool_results.read"]
    const secondChild = authorizedCreateFixture(authorityParent(), { context, allowedActions: actions }, 1)
    await createSubagentTask(secondChild.client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "scout", taskType: "job_discovery", goal: "inspect", allowedActions: actions,
      context, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, policy: normalizeSubagentPolicy(),
    }, true, { nestedScoutAuthority: "child_execution" })
    expect(secondChild.insertValues).toHaveLength(1)

    for (const [totalChildren, maxFanOut] of [[2, 8], [1, 1]]) {
      const fixture = authorizedCreateFixture(authorityParent(), { context, allowedActions: actions }, totalChildren)
      await expect(createSubagentTask(fixture.client, {
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
        role: "scout", taskType: "job_discovery", goal: "inspect", allowedActions: actions,
        context, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
        policy: normalizeSubagentPolicy({ maxFanOut }),
      }, true, { nestedScoutAuthority: "child_execution" })).rejects.toMatchObject({ code: "fan_out" })
      expect(fixture.insertValues).toHaveLength(0)
      const lifetimeCount = fixture.calls.find(sql => sql.includes("COUNT(*)") && !sql.includes('"status" NOT IN'))
      expect(lifetimeCount).toContain('"parentTaskId" = $2')
      expect(lifetimeCount).not.toContain('"status"')
    }
  })

  it("gates only a server-confirmed planning Root and rejects malformed action metadata", async () => {
    const client = { query: vi.fn() } as unknown as Queryable
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: "worker-1", turnLeaseVersion: 2, parentLeaseOwner: "worker-1", parentAttemptCount: 1 }
    assertNoUnresolvedSteeringMock.mockReset().mockResolvedValue(undefined)
    await assertPlanningRootHasNoUnresolvedSteering(client, ["jobs.search"], scope)
    expect(assertNoUnresolvedSteeringMock).not.toHaveBeenCalled()
    await assertPlanningRootHasNoUnresolvedSteering(client, ["agent.plan"], scope)
    expect(assertNoUnresolvedSteeringMock).toHaveBeenCalledWith(client, scope)
    await expect(assertPlanningRootHasNoUnresolvedSteering(client, undefined, scope)).rejects.toThrow("steering_reconciliation_root_policy_invalid")
  })

  it("uses the named terminal read only for an admitted planning Root and still rejects pending steering", async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ id: "session-1" }] })) } as never
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: "worker-1", turnLeaseVersion: 2, parentLeaseOwner: "worker-1", parentAttemptCount: 1 }
    const admission = await assertSessionTerminalAdmission(client, { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, source: "user", executionMode: "canonical_task_graph" })
    terminalSteeringReadMock.mockReset().mockResolvedValue({ unresolvedInputs: [] })

    await assertTerminalPlanningRootHasNoUnresolvedSteering(client, ["jobs.search"], scope, admission)
    expect(terminalSteeringReadMock).not.toHaveBeenCalled()
    await assertTerminalPlanningRootHasNoUnresolvedSteering(client, ["agent.plan"], scope, admission)
    expect(terminalSteeringReadMock).toHaveBeenCalledWith(client, scope, admission)
    terminalSteeringReadMock.mockResolvedValueOnce({ unresolvedInputs: [{ id: "steer-1" }] })
    await expect(assertTerminalPlanningRootHasNoUnresolvedSteering(client, ["agent.plan"], scope, admission))
      .rejects.toThrow("steering_reconciliation_pending")
  })

  it("inherits parent route and action bounds without relocking an already locked session", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const parent = {
      id: "parent-1", rootTaskId: "root-1", path: "/root-1/parent-1", depth: 1, status: "running",
      allowedActions: ["jobs.search", "wait_subagents", "scout.delegate", "scout.results"], modelProfileSnapshot: { provider: "fixture", model: "parent" },
      budgetSnapshot: {}, toolPolicySnapshot: { tools: ["jobs"] },
    }
    const row = {
      id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "parent-1",
      path: "/root-1/parent-1/child-1", depth: 2, role: "analyst", taskType: "research", status: "queued", goal: "inspect",
      constraints: [], successCriteria: [], allowedActions: ["jobs.search", "wait_subagents"], context: {}, expectedOutputSchema: {}, result: null,
      failureReason: null, attemptCount: 0, maxAttempts: 3, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null,
      interruptRequestedAt: null, modelProfileSnapshot: parent.modelProfileSnapshot, budgetSnapshot: {}, toolPolicySnapshot: parent.toolPolicySnapshot,
    }
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
        if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT "rootTaskId", "turnId"')) return { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('FOR UPDATE')) return { rows: [parent], rowCount: 1 }
        if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
        if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: "child-1" }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [row], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Queryable

    const created = await createSubagentTask(client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "analyst", taskType: "research", goal: "inspect", allowedActions: [],
      modelProfileSnapshot: { provider: "fixture", model: "override" }, policy: normalizeSubagentPolicy(),
    }, true)

    expect(created).toMatchObject({ id: "child-1", rootTaskId: "root-1", depth: 2, status: "queued" })
    expect(calls.some(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))).toBe(false)
    const parentIndex = calls.findIndex(([sql]) => sql.includes('FROM "sub_agent_tasks" WHERE') && sql.includes("FOR UPDATE"))
    const rootIndex = calls.findIndex(([sql]) => sql.includes('FROM "sub_agent_tasks" AS root'))
    const insertIndex = calls.findIndex(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))
    expect(parentIndex).toBeGreaterThanOrEqual(0)
    expect(rootIndex).toBeLessThan(parentIndex)
    expect(parentIndex).toBeLessThan(insertIndex)
    expect(calls[insertIndex]?.[1]).toEqual(expect.arrayContaining([
      JSON.stringify(["jobs.search", "wait_subagents"]), JSON.stringify(parent.modelProfileSnapshot), JSON.stringify(parent.toolPolicySnapshot),
      JSON.stringify({ subagentPolicy: normalizeSubagentPolicy() }),
    ]))
    expect(calls[insertIndex]?.[1]?.[19]).toBe(false)
  })

  it("stamps an opted-in canonical child from the database clock and starts with no segment", async () => {
    const deadline = new Date("2026-10-26T13:00:00.000Z")
    let insertSql = "", insertValues: unknown[] = []
    const parent = {
      id: "parent-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running",
      allowedActions: ["jobs.search"], modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
    }
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
        if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT "rootTaskId", "turnId"')) return { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("FOR UPDATE")) return { rows: [parent], rowCount: 1 }
        if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
        if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) {
          insertSql = sql
          insertValues = params ?? []
          return { rows: [{ id: "child-1" }], rowCount: 1 }
        }
        if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [{
          id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
          parentTaskId: "parent-1", path: "/root-1/child-1", depth: 1, role: "analyst", taskType: "research",
          status: "queued", goal: "inspect", attemptCount: 0, maxAttempts: 3, absoluteDeadlineAt: deadline,
          leaseSegmentStartedAt: null, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
          modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
        }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Queryable

    const child = await createSubagentTask(client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "analyst", taskType: "research", goal: "inspect", policy: normalizeSubagentPolicy(),
    }, true, { taskGraphChildDeadline: true })

    expect(insertSql).toContain(`CASE WHEN $20::boolean THEN clock_timestamp() + interval '60 minutes' ELSE NULL END`)
    expect(insertValues[19]).toBe(true)
    expect(child.absoluteDeadlineAt).toEqual(deadline)
    expect(child.leaseSegmentStartedAt).toBeNull()
  })

  it("can preserve an explicit action intersection, including an empty one, in the inserted task", async () => {
    for (const actions of [[], ["jobs.search"]]) {
      const parent = {
        id: "parent-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running",
        allowedActions: ["jobs.search", "jobs.get"], modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }
      let insertedActions: unknown
      const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
          if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
          if (sql.includes('SELECT "rootTaskId", "turnId"')) return { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
          if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
          if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("FOR UPDATE")) return { rows: [parent], rowCount: 1 }
          if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
          if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) {
            insertedActions = JSON.parse(String(params?.[12])) as unknown
            return { rows: [{ id: "child-1" }], rowCount: 1 }
          }
          if (sql.includes('FROM "sub_agent_tasks" task')) return {
            rows: [{
              id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
              parentTaskId: "parent-1", path: "/root-1/child-1", depth: 1, role: "analyst", taskType: "research",
              status: "queued", goal: "inspect", constraints: [], successCriteria: [], allowedActions: insertedActions,
              context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 0, maxAttempts: 3,
              nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
              modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
            }], rowCount: 1,
          }
          return { rows: [], rowCount: 0 }
        }),
      } as unknown as Queryable

      const child = await createSubagentTask(client, {
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
        role: "analyst", taskType: "research", goal: "inspect", allowedActions: actions,
        policy: normalizeSubagentPolicy(),
      }, true, { preserveEmptyAllowedActions: true })

      expect(insertedActions).toEqual(actions)
      expect(child.allowedActions).toEqual(actions)
    }
  })

  it("rejects child creation when the locked root has an interrupt request", async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
        if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT "rootTaskId", "turnId"')) return { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: new Date() }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Queryable
    await expect(createSubagentTask(client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1",
      role: "analyst", taskType: "research", goal: "inspect", policy: normalizeSubagentPolicy(),
    }, true)).rejects.toThrow("Root task is unavailable")
    expect(calls.some(sql => sql.includes("FOR UPDATE") && sql.includes('FROM "sub_agent_tasks" WHERE'))).toBe(false)
    expect(calls.some(sql => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })
})
