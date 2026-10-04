import { describe, expect, it, vi } from "vitest"
import type { Queryable } from "./pg-store-persistence.js"
import { cleanupFailedRootTaskGraph, settleRecoveredTaskGraph, type RootFailureCleanupAuthority } from "./task-graph-pg-root-failure-cleanup.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "./task-graph-snapshot.js"
import type { SubagentTaskRecord } from "./types.js"

const identity = { id: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null, taskType: "root" } as const
const now = new Date("2026-10-04T12:00:00.000Z")
const recoveryAuthority = { kind: "terminal-failed-turn-recovery" } as const
const liveFailureAuthority: RootFailureCleanupAuthority = {
  kind: "persisted-root-result-failed", lease: { ownerId: "worker-1", leaseVersion: 3 },
}

function fixture(options: {
  turnStatus?: string; turnOwnerId?: string; turnLeaseVersion?: number; turnLeaseValid?: boolean
  sessionStatus?: string; sessionUserId?: string; rootStatus?: string
  noGraph?: boolean; missingProposal?: boolean; malformedProposal?: boolean; missingChildId?: string; foreignChildId?: string
} = {}) {
  const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
    node("waiter", "wait-1"), node("queued", "queue-1"), node("runner", "run-1"), node("done", "done-1"),
  ] }
  const statuses: Record<string, string> = { "wait-1": "waiting", "queue-1": "queued", "run-1": "running", "done-1": "completed", "legacy-1": "waiting" }
  const rows = new Map<string, { id: string; status: string; attemptCount: number; interruptRequestedAt: Date | null; leaseOwner: string | null; leaseExpiresAt: Date | null; failureReason: string | null }>(Object.entries(statuses).map(([id, status]) => [id, {
    id, status, attemptCount: id === "run-1" ? 1 : 0, interruptRequestedAt: null as Date | null,
    leaseOwner: id === "run-1" ? "child-owner" : null, leaseExpiresAt: id === "run-1" ? new Date("2026-10-04T12:01:00.000Z") : null,
    failureReason: null as string | null,
  }] as const))
  let revision = 2
  let sequence = 0
  const itemId = taskGraphItemId(identity.id)
  const proposalPayload = {
    kind: "proposal", fingerprint: "fingerprint", revision,
    receipt: { revision, nodes: snapshot.nodes.map((item, index) => ({ key: item.key, taskId: item.taskId, status: index === 1 ? "queued" : "waiting" })), readyTaskIds: ["queue-1"] },
  }
  const events: Array<{ type: string; payload: unknown }> = []
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    if (sql.includes('SELECT session."userId"') && sql.includes('FROM "agent_sessions" AS session')) {
      return { rows: [{ userId: options.sessionUserId ?? identity.userId, status: options.sessionStatus ?? "running" }], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_turns" AS turn WHERE')) {
      const liveFailure = sql.includes(`turn."status" = 'in_progress'`)
      const status = liveFailure ? "in_progress" : options.turnStatus ?? "failed"
      const authorized = options.turnStatus !== "missing" && (options.turnStatus ?? "failed") === status
        && (!liveFailure || (
          (options.turnOwnerId ?? "worker-1") === params?.[4]
          && (options.turnLeaseVersion ?? 3) === params?.[5]
          && options.turnLeaseValid !== false
        ))
      return authorized ? { rows: [{
        id: identity.turnId, sessionId: identity.sessionId, userId: identity.userId, rootTaskId: identity.id,
        status, leaseOwnerId: options.turnOwnerId ?? "worker-1", leaseVersion: options.turnLeaseVersion ?? 3,
      }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('task."taskType" = \'root\'')) {
      return options.rootStatus === "missing" ? { rows: [], rowCount: 0 } : { rows: [{
        ...identity, status: options.rootStatus ?? "failed",
      }], rowCount: 1 }
    }
    if (sql.includes('SELECT item."id"')) return options.noGraph ? { rows: [], rowCount: 0 } : { rows: [{
      id: itemId, revision, content: snapshot, createdAt: new Date("2026-10-04T11:00:00.000Z"),
    }], rowCount: 1 }
    if (sql.includes('event."payload"->>\'kind\' = \'proposal\'')) {
      if (options.noGraph || options.missingProposal) return { rows: [], rowCount: 0 }
      const payload = options.malformedProposal ? { kind: "proposal", receipt: { revision: 2, nodes: "invalid", readyTaskIds: [] } } : proposalPayload
      return { rows: [{ payload }], rowCount: 1 }
    }
    if (sql.includes('SELECT task."id", task."status", task."role"')) {
      const ids = params?.[0] as string[]
      return { rows: ids.map(id => rows.get(id)).filter(Boolean).map(row => ({
        id: row!.id, status: row!.status, role: "analyst", failureReason: row!.failureReason, result: null,
      })), rowCount: ids.length }
    }
    if (sql.includes('SELECT event."type", event."payload"')) return { rows: events, rowCount: events.length }
    if (sql.includes('SELECT task."id", task."status", task."attemptCount"') && sql.includes("FOR UPDATE OF task")) {
      const ids = params?.[0] as string[]
      const found = ids.map(id => id === options.missingChildId || id === options.foreignChildId ? undefined : rows.get(id)).filter(Boolean)
      return { rows: found.map(row => ({ id: row!.id, status: row!.status, attemptCount: row!.attemptCount })), rowCount: found.length }
    }
    if (sql.includes('SELECT task."turnId"')) {
      const id = String(params?.[0])
      return { rows: [{ turnId: identity.turnId, rootTaskId: identity.id, parentTaskId: identity.id, attemptCount: rows.get(id)?.attemptCount ?? 0, userId: identity.userId }], rowCount: 1 }
    }
    if (sql.includes('SET "interruptRequestedAt"')) {
      const row = rows.get(String(params?.[0]))!
      if (row.status === "running" && row.interruptRequestedAt === null) {
        row.interruptRequestedAt = params?.[6] as Date
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('SET "status" = \'cancelled\'')) {
      const row = rows.get(String(params?.[0]))!
      if (row.status !== params?.[7]) return { rows: [], rowCount: 0 }
      row.status = "cancelled"; row.failureReason = "Root task failed."
      row.leaseOwner = null; row.leaseExpiresAt = null
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE "agent_items" AS item')) {
      revision = Number(params?.[5])
      return { rows: [{ stepId: null, status: "streaming", phase: null, startedAt: now, completedAt: null, createdAt: now }], rowCount: 1 }
    }
    if (sql.includes('UPDATE "agent_sessions" AS session')) return { rows: [{ eventSequence: String(++sequence) }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_events"')) {
      events.push({ type: String(params?.[6]), payload: JSON.parse(String(params?.[10])) as unknown })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_outbox"') || sql.includes('DELETE FROM "agent_outbox"')) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  return { client: { query } as unknown as Queryable, query, rows, events, calls, snapshot }
}

function node(key: string, taskId: string) {
  return { key, templateId: "analyst", goal: key, successCriteria: ["done"], dependsOn: [], depth: 1, taskId, verificationDisposition: "legacy_unverified" }
}

describe("cleanupFailedRootTaskGraph", () => {
  it("cancels only active snapshot members, receipts nonrunning cancellations, and marks a running member without releasing its lease", async () => {
    const fake = fixture()
    await cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, now)

    expect(fake.rows.get("wait-1")).toMatchObject({ status: "cancelled", failureReason: "Root task failed.", leaseOwner: null, leaseExpiresAt: null })
    expect(fake.rows.get("queue-1")?.status).toBe("cancelled")
    expect(fake.rows.get("run-1")).toMatchObject({ status: "running", interruptRequestedAt: now, leaseOwner: "child-owner", leaseExpiresAt: new Date("2026-10-04T12:01:00.000Z") })
    expect(fake.rows.get("done-1")?.status).toBe("completed")
    expect(fake.rows.get("legacy-1")?.status).toBe("waiting")
    const lifecycle = fake.events.map(event => event.payload as { kind?: string; event?: { type?: string; nodeKey?: string } })
      .filter(payload => payload.kind === "lifecycle")
    expect(lifecycle.map(payload => [payload.event?.type, payload.event?.nodeKey])).toEqual([
      ["task.cancelled", "waiter"], ["task.cancelled", "queued"],
    ])
    const dispatchDeletes = fake.calls.filter(call => call.sql.startsWith('DELETE FROM "agent_outbox"'))
    expect(dispatchDeletes.map(call => call.params?.[1])).toEqual(["subagent-dispatch:wait-1", "subagent-dispatch:queue-1"])
    expect(dispatchDeletes.every(call => call.sql.includes('"publishedAt" IS NULL'))).toBe(true)
    const childLock = fake.calls.find(call => call.sql.includes('task."attemptCount"') && call.sql.includes("FOR UPDATE OF task"))
    expect(childLock?.params?.[0]).not.toContain("legacy-1")
    const lockOrder = [
      fake.calls.findIndex(call => call.sql.includes('SELECT session."userId"')),
      fake.calls.findIndex(call => call.sql.includes('FROM "agent_turns" AS turn WHERE')),
      fake.calls.findIndex(call => call.sql.includes('task."taskType" = \'root\'')),
      fake.calls.findIndex(call => call.sql.includes('SELECT item."id"')),
      fake.calls.findIndex(call => call.sql.includes('task."attemptCount"') && call.sql.includes("FOR UPDATE OF task")),
    ]
    expect(lockOrder.every((index, position) => index >= 0 && (position === 0 || lockOrder[position - 1]! < index))).toBe(true)
  })

  it("is idempotent across repeated cleanup", async () => {
    const fake = fixture()
    await cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, now)
    await cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, new Date("2026-10-04T12:05:00.000Z"))

    expect(fake.events.filter(event => (event.payload as { kind?: string }).kind === "lifecycle")).toHaveLength(2)
    expect(fake.calls.filter(call => call.sql.startsWith('DELETE FROM "agent_outbox"'))).toHaveLength(2)
    expect(fake.rows.get("run-1")?.interruptRequestedAt).toEqual(now)
  })

  it.each(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])("defers cleanup while the exact linked Turn is %s", async turnStatus => {
    const fake = fixture({ turnStatus })
    await expect(cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, now)).resolves.toBeUndefined()
    expect(fake.calls.some(call => call.sql.includes('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.events).toHaveLength(0)
    const turnGuard = fake.calls.find(call => call.sql.includes('FROM "agent_turns" AS turn WHERE'))
    expect(turnGuard?.sql).toContain('turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3')
    expect(turnGuard?.sql).toContain('turn."rootTaskId" = $4')
    expect(turnGuard?.params).toEqual([identity.turnId, identity.sessionId, identity.userId, identity.id])
  })

  it("requires an exact live owned lease for explicit root-result failure cleanup", async () => {
    const live = fixture({ turnStatus: "in_progress" })
    await cleanupFailedRootTaskGraph(live.client, identity, liveFailureAuthority, now)
    const turnGuard = live.calls.find(call => call.sql.includes('FROM "agent_turns" AS turn WHERE'))
    expect(turnGuard?.sql).toContain(`turn."status" = 'in_progress'`)
    expect(turnGuard?.sql).toContain('turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6')
    expect(turnGuard?.sql).toContain('turn."leaseExpiresAt" > clock_timestamp()')
    expect(turnGuard?.params).toEqual([identity.turnId, identity.sessionId, identity.userId, identity.id, "worker-1", 3])

    for (const options of [
      { turnStatus: "in_progress", turnOwnerId: "other-worker" },
      { turnStatus: "in_progress", turnLeaseVersion: 4 },
      { turnStatus: "in_progress", turnLeaseValid: false },
      { turnStatus: "failed" },
    ]) {
      const unauthorized = fixture(options)
      await expect(cleanupFailedRootTaskGraph(unauthorized.client, identity, liveFailureAuthority, now))
        .rejects.toThrow("task_graph_turn_fenced")
      expect(unauthorized.calls.some(call => call.sql.includes('SELECT item."id"'))).toBe(false)
      expect(unauthorized.calls.some(call => !call.sql.trimStart().startsWith("SELECT"))).toBe(false)
    }
  })

  it("requires a valid canonical root and exact persisted lineage", async () => {
    const malformed = { ...identity, rootTaskId: "foreign-root" }
    const malformedFake = fixture()
    await expect(cleanupFailedRootTaskGraph(malformedFake.client, malformed, recoveryAuthority, now)).rejects.toThrow("task_graph_failed_root_scope_invalid")
    expect(malformedFake.calls).toHaveLength(0)

    const missingTurn = fixture({ turnStatus: "missing" })
    await expect(cleanupFailedRootTaskGraph(missingTurn.client, identity, recoveryAuthority, now)).rejects.toThrow("task_graph_turn_fenced")
    expect(missingTurn.calls.some(call => call.sql.includes('SELECT item."id"'))).toBe(false)

    const nonfailedRoot = fixture({ rootStatus: "missing" })
    await expect(cleanupFailedRootTaskGraph(nonfailedRoot.client, identity, recoveryAuthority, now)).rejects.toThrow("task_graph_failed_root_fenced")
    expect(nonfailedRoot.calls.some(call => call.sql.includes('SELECT item."id"'))).toBe(false)
  })

  it("does nothing when the failed root has no persisted graph proposal", async () => {
    const fake = fixture({ noGraph: true })
    await expect(cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, now)).resolves.toBeUndefined()
    expect(fake.calls.some(call => call.sql.includes('task."id" = ANY($1::text[])'))).toBe(false)
    expect(fake.calls.some(call => call.sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.events).toHaveLength(0)
  })

  it("preserves queued dispatch reset and terminal unpublished-dispatch deletion during ordinary recovery", async () => {
    const task = { ...identity, status: "running" } as unknown as SubagentTaskRecord
    const queued = fixture({ noGraph: true })
    await settleRecoveredTaskGraph(queued.client, {
      task, graph: null, status: "queued", terminal: false, closedSession: false, now, canonicalFailedRoot: false,
    })
    const reset = queued.calls.find(call => call.sql.includes('UPDATE "agent_outbox"'))
    expect(reset?.sql).toContain('SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1, "lastError" = NULL')
    expect(reset?.params).toEqual([identity.sessionId, "subagent-dispatch:root-1"])

    const terminal = fixture({ noGraph: true })
    await settleRecoveredTaskGraph(terminal.client, {
      task, graph: null, status: "failed", terminal: true, closedSession: false, now, canonicalFailedRoot: false,
    })
    const removal = terminal.calls.find(call => call.sql.startsWith('DELETE FROM "agent_outbox"'))
    expect(removal?.sql).toContain('"publishedAt" IS NULL')
    expect(removal?.params).toEqual([identity.sessionId, "subagent-dispatch:root-1"])
  })

  it.each(["aborted", "archived"])("skips a %s session before graph reads", async sessionStatus => {
    const fake = fixture({ sessionStatus })
    await expect(cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, now)).resolves.toBeUndefined()
    expect(fake.calls.some(call => call.sql.includes('FROM "agent_turns" AS turn WHERE'))).toBe(false)
    expect(fake.calls.some(call => call.sql.includes('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("fails closed without writes when a snapshot member is missing or foreign", async () => {
    for (const options of [{ missingChildId: "wait-1" }, { foreignChildId: "run-1" }]) {
      const fake = fixture(options)
      await expect(cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, now)).rejects.toThrow("task_graph_failed_root_child_scope_invalid")
      expect(fake.calls.some(call => !call.sql.trimStart().startsWith("SELECT"))).toBe(false)
      expect(fake.rows.get("wait-1")?.status).toBe("waiting")
      const childGuard = fake.calls.find(call => call.sql.includes('task."attemptCount"') && call.sql.includes("FOR UPDATE OF task"))
      expect(childGuard?.sql).toContain('task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6')
      expect(childGuard?.params).toEqual([["wait-1", "queue-1", "run-1", "done-1"], identity.sessionId, identity.turnId, identity.id, identity.id, identity.userId])
    }
  })

  it.each(["missingProposal", "malformedProposal"] as const)("fails closed without writes for %s membership", async membershipState => {
    const fake = fixture({ [membershipState]: true })
    await expect(cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, now)).rejects.toThrow(
      membershipState === "missingProposal" ? "task_graph_failed_root_membership_invalid" : "task_graph_receipt_invalid",
    )
    expect(fake.calls.filter(call => !call.sql.trimStart().startsWith("SELECT"))).toEqual([])
    expect(fake.calls.some(call => call.sql.includes('task."id" = ANY($1::text[])') && call.sql.includes("FOR UPDATE OF task"))).toBe(false)
  })

  it("rejects a foreign session identity before locking a Turn", async () => {
    const fake = fixture({ sessionUserId: "other-user" })
    await expect(cleanupFailedRootTaskGraph(fake.client, identity, recoveryAuthority, now)).rejects.toThrow("task_graph_session_fenced")
    expect(fake.calls.some(call => call.sql.includes('FROM "agent_turns" AS turn WHERE'))).toBe(false)
    expect(fake.calls.some(call => !call.sql.trimStart().startsWith("SELECT"))).toBe(false)
  })
})
