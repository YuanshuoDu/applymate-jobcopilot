import { describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import type { GraphScope } from "./task-graph-pg-state.js"
import { isRegisteredObjectiveTaskGraphChildTemplate, admitOwnedObjectiveTaskGraphChild } from "./objective-task-graph-child-authority.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import { templatesForInteractiveScoutDelegation } from "./nested-scout-profile.js"

const scope: GraphScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-worker", turnLeaseVersion: 3, parentLeaseOwner: "root-worker", parentAttemptCount: 2 }
const objectiveInput = { goal: "Find software engineering roles", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }
const scout = TASK_GRAPH_TEMPLATES.scout
const analyst = TASK_GRAPH_TEMPLATES.analyst
const nestedScout = templatesForInteractiveScoutDelegation(TASK_GRAPH_TEMPLATES, TASK_GRAPH_TEMPLATES)!.scout!

function liveRow(overrides: Record<string, unknown> = {}) {
  return { sessionId: scope.sessionId, userId: scope.userId, sessionStatus: "active", turnId: scope.turnId,
    turnSource: "user", executionMode: "canonical_task_graph", turnStatus: "in_progress", turnRootTaskId: scope.rootTaskId,
    turnLeaseOwner: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion, input: objectiveInput,
    rootTaskId: scope.rootTaskId, rootRootTaskId: scope.rootTaskId, rootParentTaskId: null, rootRole: "orchestrator",
    rootTaskType: "root", rootStatus: "running", parentLeaseOwner: scope.parentLeaseOwner,
    parentAttemptCount: scope.parentAttemptCount, interruptRequestedAt: null, stepId: scope.stepId,
    stepTaskId: scope.rootTaskId, stepStatus: "streaming", ...overrides }
}

function clientFor(rows: unknown[], casRows: unknown[] = [{ id: scope.turnId }]) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    const selected = sql.startsWith('UPDATE "agent_turns"') ? casRows : rows
    return { rows: selected, rowCount: selected.length }
  })
  return { client: { query } as never, query }
}

describe("objective TaskGraph child authority", () => {
  it("recognizes only exact registered Scout and canonical Analyst variants", () => {
    expect(isRegisteredObjectiveTaskGraphChildTemplate("scout", scout)).toBe(true)
    expect(isRegisteredObjectiveTaskGraphChildTemplate("scout", nestedScout)).toBe(true)
    expect(isRegisteredObjectiveTaskGraphChildTemplate("analyst", analyst)).toBe(true)
    expect(isRegisteredObjectiveTaskGraphChildTemplate("analyst", scout)).toBe(false)
    expect(isRegisteredObjectiveTaskGraphChildTemplate("scout", analyst)).toBe(false)
    expect(isRegisteredObjectiveTaskGraphChildTemplate("analyst", { ...analyst, allowedActions: [...analyst.allowedActions, "applications.submit"] })).toBe(false)
    expect(isRegisteredObjectiveTaskGraphChildTemplate("analyst", { ...analyst, constraints: ["changed"] })).toBe(false)
    expect(isRegisteredObjectiveTaskGraphChildTemplate("analyst", { ...analyst, maxAttempts: 1 })).toBe(false)
    expect(isRegisteredObjectiveTaskGraphChildTemplate("analyst", { ...analyst, internal: true } as never)).toBe(false)
  })

  it("requires the exact live user Turn, canonical objective, Root lease and streaming Step", async () => {
    const input = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: scout.role, taskType: scout.taskType, goal: "Find roles", allowedActions: scout.allowedActions, constraints: scout.constraints,
      context: {}, expectedOutputSchema: scout.expectedOutputSchema }
    const accepted = clientFor([liveRow()])
    await expect(admitOwnedObjectiveTaskGraphChild(accepted.client, input, scope)).resolves.toBe(true)
    const sql = accepted.query.mock.calls[0]?.[0] ?? ""
    expect(sql).not.toContain("FOR UPDATE")
    for (const predicate of [
      'session."userId" = $2', "turn.\"source\" = 'user'", 'turn."executionMode" IS NULL OR turn."executionMode" = \'canonical_task_graph\'',
      'turn."leaseExpiresAt" > live."at"', 'root."leaseExpiresAt" > live."at"', 'root."leaseOwner" = $7',
      'root."attemptCount" = $8', 'step."taskId" = root."id"', 'step."status" = \'streaming\'',
      'newer."ordinal" > step."ordinal"',
    ]) expect(sql).toContain(predicate)
    expect(accepted.query.mock.calls[0]?.[1]).toEqual([scope.sessionId, scope.userId, scope.turnId, scope.rootTaskId,
      scope.turnLeaseOwner, scope.turnLeaseVersion, scope.parentLeaseOwner, scope.parentAttemptCount, scope.stepId])

    for (const inputValue of [
      { ...objectiveInput, intent: { kind: "objective_task_graph_execution", version: 2 } },
      { ...objectiveInput, intent: { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, extra: true } },
      { ...objectiveInput, input: { goal: objectiveInput.goal, intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } },
    ]) {
      const denied = clientFor([liveRow({ input: inputValue })])
      await expect(admitOwnedObjectiveTaskGraphChild(denied.client, input, scope)).resolves.toBe(false)
      expect(denied.query).toHaveBeenCalledTimes(1)
    }
    const conflictingMode = clientFor([liveRow({ executionMode: "selected_job" })])
    await expect(admitOwnedObjectiveTaskGraphChild(conflictingMode.client, input, scope)).resolves.toBe(false)
    expect(conflictingMode.query).toHaveBeenCalledTimes(1)
    const foreignOrStale = clientFor([])
    await expect(admitOwnedObjectiveTaskGraphChild(foreignOrStale.client, input, scope)).resolves.toBe(false)
  })

  it("admits only the canonical Analyst persisted spec", async () => {
    const input = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: analyst.role, taskType: analyst.taskType, goal: "Analyze Scout evidence", allowedActions: analyst.allowedActions,
      constraints: analyst.constraints, context: {}, expectedOutputSchema: analyst.expectedOutputSchema }
    const accepted = clientFor([liveRow()])
    await expect(admitOwnedObjectiveTaskGraphChild(accepted.client, input, scope)).resolves.toBe(true)
    for (const changed of [
      { ...input, taskType: "research" },
      { ...input, allowedActions: ["jobs.search"] },
      { ...input, expectedOutputSchema: { schemaVersion: "agent-harness.v2.role-result", role: "scout" } },
      { ...input, context: { unrelated: true } },
    ]) {
      const denied = clientFor([liveRow()])
      await expect(admitOwnedObjectiveTaskGraphChild(denied.client, changed, scope)).resolves.toBe(false)
      expect(denied.query).not.toHaveBeenCalled()
    }
  })

  it("promotes only a verified NULL execution mode with an exact live owner-and-lease CAS", async () => {
    const input = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: scout.role, taskType: scout.taskType, goal: "Find roles", allowedActions: scout.allowedActions,
      constraints: scout.constraints, context: {}, expectedOutputSchema: scout.expectedOutputSchema }
    const unpinned = clientFor([liveRow({ executionMode: null })])
    await expect(admitOwnedObjectiveTaskGraphChild(unpinned.client, input, scope)).resolves.toBe(true)
    expect(unpinned.query).toHaveBeenCalledTimes(2)
    expect(unpinned.query.mock.calls[0]?.[0]).toContain('(turn."executionMode" IS NULL OR turn."executionMode" = \'canonical_task_graph\')')
    const cas = unpinned.query.mock.calls[1]?.[0] ?? ""
    for (const predicate of [
      'turn."userId" = $3', 'turn."source" = \'user\'', 'turn."rootTaskId" = $4',
      'turn."leaseOwnerId" = $5', 'turn."leaseVersion" = $6', 'turn."executionMode" IS NULL',
      'turn."leaseExpiresAt" > clock_timestamp()',
    ]) expect(cas).toContain(predicate)
    expect(unpinned.query.mock.calls[1]?.[1]).toEqual([scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId,
      scope.turnLeaseOwner, scope.turnLeaseVersion])
    const failedCas = clientFor([liveRow({ executionMode: null })], [])
    await expect(admitOwnedObjectiveTaskGraphChild(failedCas.client, input, scope)).resolves.toBe(false)
    expect(failedCas.query).toHaveBeenCalledTimes(2)
  })

  it("does not query or authorize a stale scope, non-root parent, or altered Scout spec", async () => {
    const input = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: scout.role, taskType: scout.taskType, goal: "Find roles", allowedActions: scout.allowedActions, constraints: scout.constraints,
      context: {}, expectedOutputSchema: scout.expectedOutputSchema }
    const mismatched = clientFor([])
    await expect(admitOwnedObjectiveTaskGraphChild(mismatched.client, input, { ...scope, stepId: "stale-step" })).resolves.toBe(false)
    expect(mismatched.query.mock.calls[0]?.[1]?.[8]).toBe("stale-step")
    const childParent = clientFor([liveRow()])
    await expect(admitOwnedObjectiveTaskGraphChild(childParent.client, { ...input, parentTaskId: "child-1" }, scope)).resolves.toBe(false)
    expect(childParent.query).not.toHaveBeenCalled()
    const altered = clientFor([liveRow()])
    await expect(admitOwnedObjectiveTaskGraphChild(altered.client, { ...input, allowedActions: ["jobs.search"] }, scope)).resolves.toBe(false)
    expect(altered.query).not.toHaveBeenCalled()
  })

  it("accepts only the bounded reserved dependency projection without mutating the child context", async () => {
    const context = { taskGraphDependencyResults: { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{ role: "analyst" }] } }
    const input = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: scout.role, taskType: scout.taskType, goal: "Find roles", allowedActions: scout.allowedActions, constraints: scout.constraints,
      context, expectedOutputSchema: scout.expectedOutputSchema }
    const accepted = clientFor([liveRow({ input: objectiveInput })])
    await expect(admitOwnedObjectiveTaskGraphChild(accepted.client, input, scope)).resolves.toBe(true)
    expect(context.taskGraphDependencyResults).toEqual({ schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{ role: "analyst" }] })
    const invalid = clientFor([liveRow({ input: objectiveInput })])
    await expect(admitOwnedObjectiveTaskGraphChild(invalid.client, { ...input, context: { ...context, extra: true } }, scope)).resolves.toBe(false)
    const tooMany = clientFor([liveRow({ input: objectiveInput })])
    await expect(admitOwnedObjectiveTaskGraphChild(tooMany.client, { ...input, context: { taskGraphDependencyResults: {
      schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: Array.from({ length: 9 }, () => ({})),
    } } }, scope)).resolves.toBe(false)
    expect(tooMany.query).not.toHaveBeenCalled()
  })
})
