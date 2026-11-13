import { describe, expect, it, vi } from "vitest"

import { NESTED_SCOUT_ALLOWED_SOURCES, NESTED_SCOUT_PROFILE_MARKER } from "./nested-scout-profile.js"
import { captureDiscoveryQueryCriteria, createDiscoveryQueryFootprintForAttempts } from "./child-discovery-query-footprint.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./child-discovery-attempt.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import {
  createNestedScoutTools, deriveNestedScoutSourceScope, nestedScoutQueryAllowed,
  nestedScoutTaskScopeFromContext, readDirectScoutChildren, restrictNestedScoutScope,
} from "./nested-scout-tools.js"
import type { SubagentLease } from "./types.js"

const profile = { sourceSlice: NESTED_SCOUT_ALLOWED_SOURCES }
const health = {
  schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION, attemptedCalls: 1, completedCalls: 1,
  failedCalls: 0, unresolvedCalls: 0, candidateCount: 1, providerFailures: 0,
  materializationFailures: 0, hasMore: false,
}

function sidecar(criteria: Record<string, unknown> = { targetRoles: ["Engineer"], targetLocations: ["Berlin"] }, attemptCount = 2) {
  return {
    attemptCount, health,
    queryFootprint: createDiscoveryQueryFootprintForAttempts([{
      query: captureDiscoveryQueryCriteria(criteria), phase: "completed",
      receipt: { requestCount: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false },
    }]),
  }
}

const lease = {
  id: "parent-task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-task",
  parentTaskId: "root-task", depth: 1, role: "scout", taskType: "job_discovery", status: "running", goal: "find engineers",
  constraints: ["Do not invent role requirements."],
  ownerId: "owner-1", leaseOwner: "owner-1", attemptCount: 2, maxAttempts: 3,
  leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null, context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER },
  allowedActions: ["scout.delegate", "scout.results", "wait_subagents", "jobs.discover"],
} as SubagentLease
const childScopeContext = { nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [
  { source: "greenhouse", targetRoles: ["Engineer"], targetLocations: ["Berlin"], maxPageSize: 20 },
] }

function executionContext() {
  return {
    scope: { userId: lease.userId }, sessionId: lease.sessionId, turnId: lease.turnId!, stepId: "step-7",
    toolCallId: "call-9", taskId: lease.id, rootTaskId: lease.rootTaskId, actorRole: "subagent" as const,
    signal: new AbortController().signal, capabilities: ["read"], reportProgress: async () => undefined,
  }
}

describe("nested Scout source scope", () => {
  it("derives only exact, cursor-free criteria from the current discovery attempt", () => {
    const value = sidecar({ targetRoles: ["Engineer"], targetLocations: ["Berlin"], pageSize: 20 }, 2)
    const parent = deriveNestedScoutSourceScope(value, profile, 2)
    expect(parent?.sourceSlice).toEqual([...NESTED_SCOUT_ALLOWED_SOURCES])
    expect(parent?.queries).toHaveLength(5)
    expect(deriveNestedScoutSourceScope(value, profile, 1)).toBeNull()
    expect(deriveNestedScoutSourceScope({ ...value, queryFootprint: undefined }, profile, 2)).toBeNull()
    expect(deriveNestedScoutSourceScope(sidecar({ targetRoles: ["Engineer"], targetLocations: ["Berlin"], cursor: "cursor-1" }), profile, 2)).toBeNull()
  })

  it("intersects requested sources and enforces roles, locations, source, cursor, and page size", () => {
    const parent = deriveNestedScoutSourceScope(sidecar({ targetRoles: ["Engineer"], targetLocations: ["Berlin", "Dublin"], source: "greenhouse", pageSize: 20 }), profile, 2)!
    const child = restrictNestedScoutScope(parent, ["greenhouse"] )!
    const inherited = { source: "greenhouse", targetRoles: ["Engineer"], targetLocations: ["Berlin"], pageSize: 10 }
    expect(nestedScoutQueryAllowed(child, inherited)).toBe(true)
    expect(nestedScoutQueryAllowed(child, { ...inherited, source: "lever" })).toBe(false)
    expect(nestedScoutQueryAllowed(child, { ...inherited, targetRoles: ["Engineer", "Designer"] })).toBe(false)
    expect(nestedScoutQueryAllowed(child, { ...inherited, targetLocations: [] })).toBe(false)
    expect(nestedScoutQueryAllowed(child, { ...inherited, cursor: "page-2" })).toBe(false)
    expect(nestedScoutQueryAllowed(child, { ...inherited, pageSize: undefined })).toBe(false)
    expect(nestedScoutQueryAllowed(child, { ...inherited, pageSize: 21 })).toBe(false)
    expect(restrictNestedScoutScope(parent, ["lever"])).toBeNull()
    expect(restrictNestedScoutScope(parent, ["greenhouse", "greenhouse"])).toBeNull()
  })

  it("round-trips only exact persisted child scopes", () => {
    const parent = deriveNestedScoutSourceScope(sidecar(), profile, 2)!
    const child = restrictNestedScoutScope(parent, ["greenhouse", "personio"])!
    const parsed = nestedScoutTaskScopeFromContext({ nestedScoutSourceSlice: child.sourceSlice, nestedScoutQueryScope: child.queries })
    expect(parsed).toEqual(child)
    expect(nestedScoutTaskScopeFromContext({ nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: child.queries })).toBeNull()
    expect(nestedScoutTaskScopeFromContext({ nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: child.queries, private: true })).toBeNull()
  })
})

describe("nested Scout tools", () => {
  it("spawns through the canonical manager with the actual step and tool-call identity", async () => {
    const spawnFromLease = vi.fn(async (spec: Record<string, unknown>) => ({ atomic: true as const, duplicate: false,
      task: { id: "subagent-child", parentTaskId: lease.id, userId: lease.userId, sessionId: lease.sessionId,
        turnId: lease.turnId, rootTaskId: lease.rootTaskId, depth: 2, role: "scout", taskType: "job_discovery", context: spec.context } }))
    const tools = createNestedScoutTools({ pool: { connect: async () => { throw new Error("not used") } } as never,
      lease, profile, subagentManager: () => ({ spawnFromLease } as never), discoveryAttemptSidecar: () => sidecar() })
    const result = await tools[0]!.execute(executionContext(), { goal: "Check Berlin engineers", sourceSlice: ["greenhouse"] })

    expect(result).toEqual({ taskId: "subagent-child", status: "queued" })
    expect(spawnFromLease).toHaveBeenCalledWith(expect.objectContaining({
      role: "scout", taskType: "job_discovery", allowedActions: ["jobs.discover", "tool_results.read"],
      constraints: ["Do not invent role requirements.", "Use only the server-published Scout tools and immutable discovery scope in task context."],
      context: expect.objectContaining({ nestedScoutSourceSlice: ["greenhouse"] }),
    }), expect.stringMatching(/^scout-delegate:/), lease, { stepId: "step-7", toolCallId: "call-9" })
  })

  it("fails closed when the parent scope or canonical manager is unavailable", async () => {
    const tools = createNestedScoutTools({ pool: { connect: async () => { throw new Error("not used") } } as never,
      lease, profile, subagentManager: () => undefined, discoveryAttemptSidecar: () => undefined })
    await expect(tools[0]!.execute(executionContext(), { goal: "Check jobs", sourceSlice: ["greenhouse"] }))
      .rejects.toMatchObject({ code: "nested_scout_source_scope_unavailable" })
    const staleTools = createNestedScoutTools({ pool: { connect: async () => { throw new Error("not used") } } as never,
      lease, profile, subagentManager: () => undefined, discoveryAttemptSidecar: () => sidecar({}, 1) })
    await expect(staleTools[0]!.execute(executionContext(), { goal: "Check jobs", sourceSlice: ["greenhouse"] }))
      .rejects.toMatchObject({ code: "nested_scout_source_scope_unavailable" })
  })

  it("fails closed when parent constraints cannot fit the validated child boundary", async () => {
    const spawnFromLease = vi.fn()
    const invalid = createNestedScoutTools({ pool: { connect: async () => { throw new Error("not used") } } as never,
      lease: { ...lease, constraints: ["  "] }, profile, subagentManager: () => ({ spawnFromLease } as never),
      discoveryAttemptSidecar: () => sidecar() })
    await expect(invalid[0]!.execute(executionContext(), { goal: "Check jobs", sourceSlice: ["greenhouse"] }))
      .rejects.toMatchObject({ code: "nested_scout_constraints_unavailable" })
    expect(spawnFromLease).not.toHaveBeenCalled()

    const full = createNestedScoutTools({ pool: { connect: async () => { throw new Error("not used") } } as never,
      lease: { ...lease, constraints: Array.from({ length: 32 }, (_, index) => `Constraint ${index}`) }, profile,
      subagentManager: () => ({ spawnFromLease } as never), discoveryAttemptSidecar: () => sidecar() })
    await expect(full[0]!.execute(executionContext(), { goal: "Check jobs", sourceSlice: ["greenhouse"] }))
      .rejects.toMatchObject({ code: "nested_scout_constraints_unavailable" })
    expect(spawnFromLease).not.toHaveBeenCalled()
  })

  it("rolls back the tenant transaction on an invalid active owner", async () => {
    const statements: string[] = []
    const client = {
      query: async (sql: string) => { statements.push(sql); return { rows: [] } },
      release: vi.fn(),
    }
    await expect(readDirectScoutChildren({ connect: async () => client } as never, lease)).resolves.toBeNull()
    expect(statements).toContain("ROLLBACK")
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("projects completed child candidates only after checking the persisted child scope", async () => {
    const candidate = {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: [{ jobId: "job-123", source: "greenhouse", url: null, evidenceIds: ["evidence-1"] }],
      evidence: [{ id: "evidence-1", kind: "job", ref: "job-123", source: "private evidence" }],
      summary: "private child prose",
    }
    const row = {
      taskId: "subagent-123", status: "completed", role: "scout", taskType: "job_discovery",
      context: childScopeContext, result: { status: "completed", structuredResult: candidate }, failureReason: null,
    }
    const pool = poolForChildren([row])
    const tools = createNestedScoutTools({ pool: pool as never, lease, profile, subagentManager: () => undefined })
    const result = await tools[1]!.execute(executionContext(), {})

    expect(result).toEqual({ availability: "available", children: [
      { taskId: "subagent-123", status: "completed", candidates: [{ jobId: "job-123", source: "greenhouse" }] },
    ] })
    expect(JSON.stringify(result)).not.toContain("private")

    const foreignScope = createNestedScoutTools({ pool: poolForChildren([{ ...row,
      result: { status: "completed", structuredResult: { ...candidate, candidates: [{ ...candidate.candidates[0], source: "lever" }] } },
    }]) as never, lease, profile, subagentManager: () => undefined })
    await expect(foreignScope[1]!.execute(executionContext(), {})).resolves.toEqual({ availability: "unavailable", children: [] })
  })

  it("distinguishes active children from terminal failures without treating failures as pending", async () => {
    const toolFor = (status: string) => createNestedScoutTools({ pool: poolForChildren([{
      taskId: "subagent-123", status, role: "scout", taskType: "job_discovery",
      context: childScopeContext, result: null, failureReason: status === "failed" ? "failed" : null,
    }]) as never, lease, profile, subagentManager: () => undefined })[1]!

    await expect(toolFor("running").execute(executionContext(), {})).resolves.toEqual({ availability: "pending", children: [
      { taskId: "subagent-123", status: "running", candidates: [] },
    ] })
    await expect(toolFor("failed").execute(executionContext(), {})).resolves.toEqual({ availability: "available", children: [
      { taskId: "subagent-123", status: "failed", candidates: [] },
    ] })
  })
})

function poolForChildren(rows: readonly Record<string, unknown>[]) {
  const client = {
    query: async (sql: string) => sql.includes('SELECT task."id"') ? { rows: [{ id: lease.id }] }
      : sql.includes('SELECT child."id"') ? { rows }
      : { rows: [] },
    release: vi.fn(),
  }
  return { connect: async () => client }
}
