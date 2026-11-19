import { describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import type { GraphScope } from "./task-graph-pg-state.js"
import { isRegisteredObjectiveScoutTemplate, hasOwnedObjectiveScoutAuthority } from "./objective-task-graph-scout-authority.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import { templatesForInteractiveScoutDelegation } from "./nested-scout-profile.js"

const scope: GraphScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-worker", turnLeaseVersion: 3, parentLeaseOwner: "root-worker", parentAttemptCount: 2 }
const objectiveInput = { goal: "Find software engineering roles", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }
const scout = TASK_GRAPH_TEMPLATES.scout
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

function clientFor(rows: unknown[]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows, rowCount: rows.length }))
  return { client: { query } as never, query }
}

describe("objective TaskGraph Scout authority", () => {
  it("recognizes only the plain and exact registered nested Scout variants", () => {
    expect(isRegisteredObjectiveScoutTemplate("scout", scout)).toBe(true)
    expect(isRegisteredObjectiveScoutTemplate("scout", nestedScout)).toBe(true)
    expect(isRegisteredObjectiveScoutTemplate("analyst", scout)).toBe(false)
    expect(isRegisteredObjectiveScoutTemplate("scout", { ...scout, allowedActions: [...scout.allowedActions, "applications.submit"] })).toBe(false)
    expect(isRegisteredObjectiveScoutTemplate("scout", { ...scout, constraints: ["changed"] })).toBe(false)
    expect(isRegisteredObjectiveScoutTemplate("scout", { ...scout, maxAttempts: 1 })).toBe(false)
    expect(isRegisteredObjectiveScoutTemplate("scout", { ...scout, internal: true } as never)).toBe(false)
  })

  it("requires the exact live user Turn, canonical objective, Root lease and streaming Step", async () => {
    const input = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: scout.role, taskType: scout.taskType, goal: "Find roles", allowedActions: scout.allowedActions, constraints: scout.constraints,
      context: {}, expectedOutputSchema: scout.expectedOutputSchema }
    const accepted = clientFor([liveRow()])
    await expect(hasOwnedObjectiveScoutAuthority(accepted.client, input, scope)).resolves.toBe(true)
    const sql = accepted.query.mock.calls[0]?.[0] ?? ""
    expect(sql).not.toContain("FOR UPDATE")
    for (const predicate of [
      'session."userId" = $2', "turn.\"source\" = 'user'", "turn.\"executionMode\" = 'canonical_task_graph'",
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
      const denied = clientFor([{ input: inputValue }])
      await expect(hasOwnedObjectiveScoutAuthority(denied.client, input, scope)).resolves.toBe(false)
    }
    const foreignOrStale = clientFor([])
    await expect(hasOwnedObjectiveScoutAuthority(foreignOrStale.client, input, scope)).resolves.toBe(false)
  })

  it("does not query or authorize a stale scope, non-root parent, or altered Scout spec", async () => {
    const input = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: scout.role, taskType: scout.taskType, goal: "Find roles", allowedActions: scout.allowedActions, constraints: scout.constraints,
      context: {}, expectedOutputSchema: scout.expectedOutputSchema }
    const mismatched = clientFor([])
    await expect(hasOwnedObjectiveScoutAuthority(mismatched.client, input, { ...scope, stepId: "stale-step" })).resolves.toBe(false)
    expect(mismatched.query.mock.calls[0]?.[1]?.[8]).toBe("stale-step")
    const childParent = clientFor([liveRow()])
    await expect(hasOwnedObjectiveScoutAuthority(childParent.client, { ...input, parentTaskId: "child-1" }, scope)).resolves.toBe(false)
    expect(childParent.query).not.toHaveBeenCalled()
    const altered = clientFor([liveRow()])
    await expect(hasOwnedObjectiveScoutAuthority(altered.client, { ...input, allowedActions: ["jobs.search"] }, scope)).resolves.toBe(false)
    expect(altered.query).not.toHaveBeenCalled()
  })

  it("accepts only the bounded reserved dependency projection without mutating the child context", async () => {
    const context = { taskGraphDependencyResults: { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{ role: "analyst" }] } }
    const input = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
      role: scout.role, taskType: scout.taskType, goal: "Find roles", allowedActions: scout.allowedActions, constraints: scout.constraints,
      context, expectedOutputSchema: scout.expectedOutputSchema }
    const accepted = clientFor([{ input: objectiveInput }])
    await expect(hasOwnedObjectiveScoutAuthority(accepted.client, input, scope)).resolves.toBe(true)
    expect(context.taskGraphDependencyResults).toEqual({ schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{ role: "analyst" }] })
    const invalid = clientFor([{ input: objectiveInput }])
    await expect(hasOwnedObjectiveScoutAuthority(invalid.client, { ...input, context: { ...context, extra: true } }, scope)).resolves.toBe(false)
    const tooMany = clientFor([{ input: objectiveInput }])
    await expect(hasOwnedObjectiveScoutAuthority(tooMany.client, { ...input, context: { taskGraphDependencyResults: {
      schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: Array.from({ length: 9 }, () => ({})),
    } } }, scope)).resolves.toBe(false)
    expect(tooMany.query).not.toHaveBeenCalled()
  })
})
