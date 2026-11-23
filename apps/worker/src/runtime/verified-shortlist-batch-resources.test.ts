import { describe, expect, it, vi } from "vitest"

const { loadGraphMock } = vi.hoisted(() => ({ loadGraphMock: vi.fn() }))
vi.mock("./subagents/task-graph-pg-state.js", () => ({ loadTaskGraph: loadGraphMock }))

import { loadVerifiedShortlistBatchResources, type VerifiedShortlistSelectionBinding } from "./verified-shortlist-batch-resources.js"
import { taskGraphItemId } from "./subagents/task-graph-snapshot.js"
import type { TurnLease } from "./turns/lease.js"

const lease: TurnLease = {
  turnId: "batch-turn", sessionId: "session-1", userId: "user-1", ownerId: "worker-1", leaseVersion: 7,
  leaseStartedAt: new Date("2026-11-22T10:00:00Z"), leaseExpiresAt: new Date("2026-11-22T10:01:00Z"),
}
const source = {
  sessionId: lease.sessionId, sourceTurnId: "discovery-turn", rootTaskId: "discovery-root",
  graphItemId: taskGraphItemId("discovery-root"), graphRevision: 12,
}
const binding: VerifiedShortlistSelectionBinding = {
  schemaVersion: "agent-harness.v2.verified-shortlist-selection.v1", source, selectedJobIds: ["job-1", "job-2"],
}
const shortlist = { schemaVersion: 1, status: "completed", failures: [], items: [
  { jobId: "job-1", score: 9, evidenceIds: ["read:job:job-1"] },
  { jobId: "job-2", score: 8, evidenceIds: ["read:job:job-2"] },
] }

type FixtureOptions = Readonly<{
  session?: boolean
  current?: Record<string, unknown> | null
  sourceTurn?: Record<string, unknown> | null
  root?: Record<string, unknown> | null
  graphRevision?: number
  graphItemId?: string
  graphNodes?: readonly unknown[]
  expectedRootTaskId?: string | null
  jobs?: readonly { id: string }[]
}>

function currentTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: lease.turnId, sessionId: lease.sessionId, userId: lease.userId, source: "user", status: "in_progress",
    executionMode: "canonical_task_graph", rootTaskId: null, leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion,
    input: { intent: { kind: "selected_job_batch_preparation", version: 1 }, verifiedShortlistSelection: binding },
    ...overrides,
  }
}

function sourceTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: source.sourceTurnId, sessionId: lease.sessionId, userId: lease.userId, source: "user", status: "completed",
    executionMode: null, rootTaskId: source.rootTaskId, input: { intent: { kind: "interactive_discovery_shortlist", version: 1 } },
    ...overrides,
  }
}

function root(overrides: Record<string, unknown> = {}) {
  return {
    id: source.rootTaskId, sessionId: lease.sessionId, turnId: source.sourceTurnId, rootTaskId: source.rootTaskId,
    parentTaskId: null, role: "orchestrator", taskType: "root", status: "completed", failureReason: null,
    result: { status: "completed", structuredResult: { interactiveDiscoveryShortlist: shortlist } },
    ...overrides,
  }
}

async function run(options: FixtureOptions = {}, selectedBinding: unknown = binding) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const responses: unknown[][] = [
    options.session === false ? [] : [{ id: lease.sessionId }],
    options.current === null ? [] : [options.current ?? currentTurn()],
    options.sourceTurn === null ? [] : [options.sourceTurn ?? sourceTurn()],
    options.root === null ? [] : [options.root ?? root()],
    [...(options.jobs ?? [{ id: "job-1" }, { id: "job-2" }])],
  ]
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values })
    return { rows: responses[calls.length - 1] ?? [] }
  })
  const client = { query } as never
  loadGraphMock.mockResolvedValue({
    rootTaskId: source.rootTaskId,
    item: { id: options.graphItemId ?? source.graphItemId, revision: options.graphRevision ?? source.graphRevision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: options.graphNodes ?? [{ key: "source", taskId: "source-task" }] },
    state: {}, tasks: new Map(),
  })
  const result = await loadVerifiedShortlistBatchResources({ client, lease, binding: selectedBinding,
    expectedRootTaskId: options.expectedRootTaskId ?? null })
  return { result, calls, client }
}

describe("verified shortlist batch resource revalidation", () => {
  it("returns only canonical finite slots after same-client owner and source proof", async () => {
    const { result, calls, client } = await run()

    expect(result).toEqual([{ slotId: "slot-1", jobId: "job-1" }, { slotId: "slot-2", jobId: "job-2" }])
    expect(loadGraphMock).toHaveBeenCalledWith(client, {
      userId: lease.userId, sessionId: lease.sessionId, turnId: source.sourceTurnId,
      rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId,
    }, false)
    const currentSql = calls[1]!.sql
    expect(currentSql).toContain(`turn."rootTaskId" IS NOT DISTINCT FROM $6`)
    expect(currentSql).toContain(`turn."input"->'verifiedShortlistSelection' = $7::jsonb`)
    expect(currentSql).toContain("turn.\"leaseExpiresAt\" > clock_timestamp()")
    expect(currentSql).toContain("turn.\"leaseVersion\" = $5")
    expect(calls[1]!.values[5]).toBeNull()
    expect(JSON.parse(String(calls[1]!.values[6]))).toEqual(binding)
    expect(calls[2]!.sql).toContain("turn.\"executionMode\" IS NULL OR turn.\"executionMode\" = 'canonical_task_graph'")
    expect(calls[4]!.values[1]).toEqual(["job-1", "job-2"])
  })

  it.each([
    ["missing owner Session", { session: false }],
    ["missing current Turn lease", { current: null }],
    ["wrong lease owner", { current: currentTurn({ leaseOwnerId: "other-worker" }) }],
    ["wrong lease attempt", { current: currentTurn({ leaseVersion: lease.leaseVersion + 1 }) }],
    ["wrong current Root", { current: currentTurn({ rootTaskId: "unexpected-root" }) }],
    ["wrong current intent", { current: currentTurn({ input: { intent: { kind: "objective_task_graph_execution", version: 1 }, verifiedShortlistSelection: binding } }) }],
    ["missing discovery Turn", { sourceTurn: null }],
    ["foreign discovery owner", { sourceTurn: sourceTurn({ userId: "other-user" }) }],
    ["wrong discovery intent", { sourceTurn: sourceTurn({ input: { intent: { kind: "objective_task_graph_execution", version: 1 } } }) }],
    ["missing completed Root", { root: null }],
    ["wrong Root lineage", { root: root({ turnId: "other-turn" }) }],
    ["noncompleted Root result", { root: root({ result: { status: "failed", structuredResult: { interactiveDiscoveryShortlist: shortlist } } }) }],
    ["stale graph revision", { graphRevision: source.graphRevision - 1 }],
    ["wrong graph item", { graphItemId: "another-graph" }],
    ["empty graph", { graphNodes: [] }],
    ["missing selected Job ownership", { jobs: [{ id: "job-1" }] }],
  ] as const)("denies %s", async (_name, options) => {
    const { result } = await run(options)
    expect(result).toBeNull()
  })

  it("rejects an unverified shortlist seed and noncanonical or out-of-scope selection order", async () => {
    const badEvidence = root({ result: { status: "completed", structuredResult: { interactiveDiscoveryShortlist: {
      ...shortlist, items: [{ ...shortlist.items[0], evidenceIds: ["read:job:job-1", "read:job:job-2"] }, shortlist.items[1]],
    } } } })
    expect((await run({ root: badEvidence })).result).toBeNull()
    expect((await run({}, { ...binding, selectedJobIds: ["job-2", "job-1"] })).result).toBeNull()
    expect((await run({}, { ...binding, selectedJobIds: ["job-1", "job-other"] })).result).toBeNull()
  })

  it("normalizes the closed shared binding before comparing the persisted turn input", async () => {
    const reordered = {
      selectedJobIds: ["job-1", "job-2"],
      source: { graphRevision: 12, graphItemId: source.graphItemId, rootTaskId: source.rootTaskId,
        sourceTurnId: source.sourceTurnId, sessionId: source.sessionId },
      schemaVersion: binding.schemaVersion,
    }
    const { result, calls } = await run({}, reordered)

    expect(result).toHaveLength(2)
    expect(calls[1]!.values[6]).toBe(JSON.stringify(binding))
  })

  it.each([
    ["extra binding field", { ...binding, callerAuthority: true }],
    ["wrong schema", { ...binding, schemaVersion: "future" }],
    ["single Job", { ...binding, selectedJobIds: ["job-1"] }],
    ["four Jobs", { ...binding, selectedJobIds: ["job-1", "job-2", "job-3", "job-4"] }],
  ])("rejects %s before any database read", async (_label, malformed) => {
    const { result, calls } = await run({}, malformed)

    expect(result).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("revalidates the caller's exact current Root after setup", async () => {
    const expectedRootTaskId = "batch-root"
    const { result, calls } = await run({ expectedRootTaskId, current: currentTurn({ rootTaskId: expectedRootTaskId }) })
    expect(result).toEqual([{ slotId: "slot-1", jobId: "job-1" }, { slotId: "slot-2", jobId: "job-2" }])
    expect(calls[1]!.values[5]).toBe(expectedRootTaskId)
  })
})
