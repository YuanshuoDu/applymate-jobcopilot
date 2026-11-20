import { describe, expect, it, vi } from "vitest"
import type { Pool } from "pg"
import { artifactTaskFenceIsCurrent, artifactTaskLeaseIsLive } from "./agent-artifact-prepare-wait-fence.js"
import type { AgentArtifactTaskFence } from "./agent-artifact-repo-helpers.js"
import { parseTaskGraphSnapshot } from "../runtime/subagents/task-graph-snapshot.js"

const baseFence: AgentArtifactTaskFence = { taskId: "prepare-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  rootTaskId: "root-1", parentTaskId: "root-1", leaseOwner: "prepare-worker", attemptCount: 4,
  taskFenceMode: "scheduled_prepare", turnLeaseOwnerId: "turn-worker", turnLeaseVersion: 7, rootAttemptCount: 3 }
const graph = { schemaVersion: "agent-harness.v2.task-graph", nodes: [
  { key: "prepare", taskId: "prepare-1", templateId: "fixture", depth: 1, goal: "Prepare", dependsOn: [],
    successCriteria: ["Prepare"], verificationDisposition: "legacy_unverified" },
] }
const validRootResult = { status: "waiting_for_dependency", stepCount: 4, toolCallCount: 2, finalItemId: null, waitId: "wait-1" }
const validWait = {
  id: "wait-1", targetTaskIds: ["prepare-1"], mode: "all", status: "waiting", suspendedAt: new Date(), resolvedAt: null, consumedAt: null,
  result: { request: { mode: "all", targetTaskIds: ["prepare-1"], timeoutMs: 60_000 } },
  stepTaskId: "root-1", stepStatus: "waiting_for_tool", attempt: 3, ordinal: 5, latestOrdinal: 5,
}
const parseSnapshot = vi.fn(parseTaskGraphSnapshot)
const fence: AgentArtifactTaskFence = { ...baseFence, taskGraphItemId: "canonical-graph-item", parseTaskGraphSnapshot: parseSnapshot }

function client(options: { turnStatus?: string; turnLeaseVersion?: number; rootAttemptCount?: number; rootResult?: unknown;
  waits?: readonly Record<string, unknown>[]; tasks?: readonly Record<string, unknown>[]; taskLive?: boolean; graphContent?: unknown } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes("FOR UPDATE OF session, turn, root, task")) {
      if (values?.[11] !== (options.turnLeaseVersion ?? 7) || values[12] !== (options.rootAttemptCount ?? 3)) return { rows: [] }
      return { rows: [{ id: fence.taskId, turnStatus: options.turnStatus ?? "waiting_for_dependency",
        sessionStatus: "running", rootAttemptCount: options.rootAttemptCount ?? 3 }] }
    }
    if (sql.includes('FROM "agent_items" AS item')) return { rows: [{ content: options.graphContent ?? graph }] }
    if (sql.includes('FROM "agent_wait_conditions" AS wait')) {
      const waitRows = options.waits ?? [validWait]
      return { rows: waitRows.map(wait => ({ ...wait, rootResult: options.rootResult ?? validRootResult })) }
    }
    if (sql.includes("task.\"id\" = ANY($1::text[])")) return { rows: [...(options.tasks ?? [{ id: "prepare-1", status: "running" }])] }
    if (sql.includes('SELECT task."leaseExpiresAt"')) return { rows: [{ live: options.taskLive ?? true }] }
    throw new Error("unexpected artifact Prepare wait-fence query")
  })
  return { client: { query } as unknown as Pick<Pool, "query">, calls, query }
}

describe("scheduled Prepare artifact dependency-wait transaction fence", () => {
  it("keeps the actively leased parent Turn path", async () => {
    const db = client({ turnStatus: "in_progress" })

    const accepted = await artifactTaskFenceIsCurrent(db.client, baseFence, "job-1")
    expect(accepted, JSON.stringify(db.calls.map(call => ({ sql: call.sql.slice(0, 90), values: call.values })))).toBe(true)

    expect(db.calls).toHaveLength(1)
    expect(db.calls[0]?.sql).toContain("FOR UPDATE OF session, turn, root, task")
  })

  it("locks and verifies one current suspended root wait and exact nonterminal graph targets", async () => {
    parseSnapshot.mockClear()
    const db = client()

    const accepted = await artifactTaskFenceIsCurrent(db.client, fence, "job-1")
    expect(accepted, JSON.stringify(db.calls.map(call => ({ sql: call.sql.slice(0, 90), values: call.values })))).toBe(true)

    const ownerLock = db.calls.findIndex(call => call.sql.includes("FOR UPDATE OF session, turn, root, task"))
    const graphLock = db.calls.findIndex(call => call.sql.includes('FROM "agent_items" AS item'))
    const waitLock = db.calls.findIndex(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))
    const graphTaskLock = db.calls.findIndex(call => call.sql.includes("task.\"id\" = ANY($1::text[])"))
    expect(ownerLock).toBeLessThan(graphLock)
    expect(graphLock).toBeLessThan(waitLock)
    expect(waitLock).toBeLessThan(graphTaskLock)
    expect(db.calls[waitLock]?.sql).toContain("FOR UPDATE OF wait, step")
    expect(db.calls[waitLock]?.sql).toContain('root."result" AS "rootResult"')
    expect(db.calls[waitLock]?.sql).toContain('root."id" = wait."parentTaskId"')
    expect(db.calls[0]?.values?.[11]).toBe(7)
    expect(db.calls[0]?.values?.[12]).toBe(3)
    expect(db.calls[graphLock]?.values?.[0]).toBe("canonical-graph-item")
    expect(db.calls[0]?.sql).not.toContain('root."result"')
    expect(parseSnapshot).toHaveBeenCalledOnce()
    expect(parseSnapshot).toHaveBeenCalledWith(graph)
  })

  it("fails closed when the dependency-wait parser binding is absent", async () => {
    const db = client()

    await expect(artifactTaskFenceIsCurrent(db.client, baseFence, "job-1")).resolves.toBe(false)
    expect(db.calls.some(call => call.sql.includes('FROM "agent_items" AS item'))).toBe(false)
  })

  it("fails closed when strict parsing rejects the graph or returns invalid node IDs", async () => {
    parseSnapshot.mockClear()
    const invalidSnapshot = client({ graphContent: { schemaVersion: "invalid", nodes: [] } })
    await expect(artifactTaskFenceIsCurrent(invalidSnapshot.client, fence, "job-1")).resolves.toBe(false)
    expect(parseSnapshot).toHaveBeenCalledOnce()

    const rejected = client()
    await expect(artifactTaskFenceIsCurrent(rejected.client, {
      ...fence, parseTaskGraphSnapshot: () => { throw new Error("task_graph_snapshot_invalid") },
    }, "job-1")).resolves.toBe(false)

    const invalidNodeId = client()
    await expect(artifactTaskFenceIsCurrent(invalidNodeId.client, {
      ...fence, parseTaskGraphSnapshot: () => ({ nodes: [{ taskId: "" }] }),
    }, "job-1")).resolves.toBe(false)
  })

  it.each([
    { label: "ambiguous waits", waits: [validWait, { ...validWait, id: "other" }] },
    { label: "missing wait identity", waits: [{ ...validWait, id: undefined }] },
    { label: "Root result has no wait ID", rootResult: { status: "waiting_for_dependency", stepCount: 4, toolCallCount: 2, finalItemId: null } },
    { label: "Root result names a different wait", rootResult: { ...validRootResult, waitId: "other-wait" } },
    { label: "resolved wait", waits: [{ ...validWait, resolvedAt: new Date() }] },
    { label: "unsuspended wait", waits: [{ ...validWait, suspendedAt: null }] },
    { label: "consumed wait", waits: [{ ...validWait, consumedAt: new Date() }] },
    { label: "wrong mode", waits: [{ ...validWait, mode: "any" }] },
    { label: "wrong root step", waits: [{ ...validWait, stepTaskId: "other-root" }] },
    { label: "stale step", waits: [{ ...validWait, ordinal: 4 }] },
    { label: "different root attempt", waits: [{ ...validWait, attempt: 2 }] },
    { label: "extra request fields", waits: [{ ...validWait, result: { request: { ...validWait.result.request, raw: true } } }] },
    { label: "changed wait targets", waits: [{ ...validWait, targetTaskIds: ["scout-1", "prepare-1"],
      result: { request: { mode: "all", targetTaskIds: ["scout-1", "prepare-1"], timeoutMs: 60_000 } } }] },
    { label: "changed graph states", tasks: [{ id: "prepare-1", status: "completed" }] },
  ])("fails closed for $label", async options => {
    const db = client(options)

    await expect(artifactTaskFenceIsCurrent(db.client, fence, "job-1")).resolves.toBe(false)
  })

  it("rechecks the exact wait owner and child lease before commit", async () => {
    const current = client()
    const live = await artifactTaskLeaseIsLive(current.client, fence)
    expect(live, JSON.stringify(current.calls.map(call => ({ sql: call.sql.slice(0, 90), values: call.values })))).toBe(true)
    expect(current.calls.some(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))).toBe(true)
    expect(current.calls.at(-1)?.sql).toContain("clock_timestamp()")

    const expired = client({ taskLive: false })
    await expect(artifactTaskLeaseIsLive(expired.client, fence)).resolves.toBe(false)

    const changedRootWait = client({ rootResult: { ...validRootResult, waitId: "other-wait" } })
    await expect(artifactTaskLeaseIsLive(changedRootWait.client, fence)).resolves.toBe(false)
    expect(changedRootWait.calls.some(call => call.sql.includes('SELECT task."leaseExpiresAt"'))).toBe(false)
  })

  it("rejects missing root-attempt or stale Turn-lease identity", async () => {
    const missingAttempt = client()
    await expect(artifactTaskFenceIsCurrent(missingAttempt.client, { ...fence, rootAttemptCount: undefined }, "job-1")).resolves.toBe(false)
    expect(missingAttempt.query).not.toHaveBeenCalled()

    const staleVersion = client({ turnStatus: "waiting_for_dependency", turnLeaseVersion: 7 })
    await expect(artifactTaskFenceIsCurrent(staleVersion.client, { ...fence, turnLeaseVersion: 6 }, "job-1")).resolves.toBe(false)
  })
})
