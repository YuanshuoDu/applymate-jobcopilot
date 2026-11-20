import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { ScheduledPrepareOwner } from "../tools/scheduled-application-prepare.js"
import type { SubagentLease } from "./types.js"
import { readScheduledPrepareOwnerAdmission, scheduledPrepareDependencyWaitMatchesGraph,
  scheduledPrepareTurnOwnerFromAdmission, type ScheduledPrepareOwnerAdmission } from "./scheduled-prepare-owner-admission.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"

const now = new Date("2026-10-21T10:00:00.000Z")
const snapshotInput = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
  targetLocations: ["Dublin"], minScore: 70, dailyCap: 2, requireApproval: true, autoApply: false }
const lease = { id: "prepare-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", role: "prepare", taskType: "scheduled_application_prepare", attemptCount: 4,
  ownerId: "prepare-worker", leaseOwner: "prepare-worker" } as unknown as SubagentLease
const owner: ExecutionOwnerFence = { kind: "task", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!,
  taskId: lease.id, rootTaskId: lease.rootTaskId, ownerId: lease.ownerId, attemptCount: lease.attemptCount,
  leaseExpiresAt: new Date(now.getTime() + 60_000) }
const graph: TaskGraphSnapshot = { schemaVersion: "agent-harness.v2.task-graph", nodes: [
  { key: "scout", taskId: "scout-1", templateId: "scout", depth: 1, goal: "Scout", dependsOn: [], successCriteria: [] },
  { key: "analyst", taskId: "analyst-1", templateId: "analyst", depth: 2, goal: "Analyze", dependsOn: ["scout"], successCriteria: [] },
  { key: "prepare", taskId: lease.id, templateId: "prepare", depth: 3, goal: "Prepare", dependsOn: ["analyst"], successCriteria: [] },
] }
const currentNodes = [
  { key: "scout", taskId: "scout-1", status: "completed" },
  { key: "analyst", taskId: "analyst-1", status: "completed" },
  { key: "prepare", taskId: lease.id, status: "running" },
]
const receiptOwner: ScheduledPrepareOwner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 3, turnLeaseOwnerId: "turn-worker", turnLeaseVersion: 7, executionId: "execution-1", executionAttemptCount: 2 }

function parentRow(overrides: Record<string, unknown> = {}) {
  return { userId: "user-1", sessionStatus: "running", role: "prepare", taskType: "scheduled_application_prepare", taskStatus: "running",
    taskLeaseOwner: "prepare-worker", taskLeaseExpiresAt: new Date(now.getTime() + 30_000), taskAttemptCount: 4, interruptRequestedAt: null,
    turnId: "turn-1", turnRootTaskId: "root-1", source: "automation", executionMode: "canonical_task_graph",
    input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshotInput },
    turnStatus: "in_progress", leaseOwnerId: "turn-worker", leaseVersion: 7, leaseExpiresAt: new Date(now.getTime() + 60_000),
    leaseStartedAt: new Date(now.getTime() - 10_000), rootStatus: "running", rootAttemptCount: 3, rootLeaseOwner: "turn-worker",
    rootLeaseExpiresAt: new Date(now.getTime() + 30_000), rootInterruptRequestedAt: null, rootCompletedAt: null, rootClosedAt: null,
    rootNextAttemptAt: null, ...overrides }
}

function waitRow(overrides: Record<string, unknown> = {}) {
  const targetTaskIds = [lease.id]
  return { targetTaskIds, mode: "all", status: "waiting", suspendedAt: now, consumedAt: null,
    result: { request: { mode: "all", targetTaskIds, timeoutMs: 60_000 } }, stepTaskId: "root-1",
    stepStatus: "waiting_for_tool", attempt: 3, ordinal: 5, latestOrdinal: 5, ...overrides }
}

function client(row = parentRow(), waits: readonly Record<string, unknown>[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [row] }
    if (sql.includes('FROM "agent_wait_conditions" wait')) return { rows: waits }
    throw new Error("unexpected owner-admission query")
  })
  return { query } as unknown as Pick<pg.PoolClient, "query">
}

function waitingAdmission(overrides: Record<string, unknown> = {}, waits = [waitRow()]): Promise<ScheduledPrepareOwnerAdmission> {
  const waiting = parentRow({ turnStatus: "waiting_for_dependency", leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null,
    rootStatus: "waiting", rootLeaseOwner: null, rootLeaseExpiresAt: null, ...overrides })
  return readScheduledPrepareOwnerAdmission(client(waiting, waits), lease, owner, now)
}

describe("scheduled Prepare parent owner admission", () => {
  it("keeps the existing live Turn and Root lease path", async () => {
    const db = client()
    const admitted = await readScheduledPrepareOwnerAdmission(db, lease, owner, now)

    expect(admitted.state).toBe("live")
    expect(admitted.turnLeaseOwnerId).toBe("turn-worker")
    expect(admitted.taskFence).toMatchObject({ taskId: lease.id, leaseOwner: lease.ownerId, attemptCount: lease.attemptCount })
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(1)
  })

  it("admits one suspended dependency wait bound to the exact current TaskGraph", async () => {
    const admitted = await waitingAdmission()
    const currentOwner = scheduledPrepareTurnOwnerFromAdmission(admitted, receiptOwner)

    expect(admitted.state).toBe("dependency_wait")
    expect(currentOwner).toMatchObject({ turnLeaseOwnerId: "turn-worker", turnLeaseVersion: 7, rootAttemptCount: 3 })
    expect(scheduledPrepareDependencyWaitMatchesGraph(admitted, graph, currentNodes, lease.id)).toBe(true)
  })

  it("rejects terminal, interrupted, replaced, or differently leased parent states", async () => {
    await expect(readScheduledPrepareOwnerAdmission(client(parentRow({ sessionStatus: "archived" })), lease, owner, now))
      .rejects.toThrow("scheduled_prepare_owner_stale")
    await expect(waitingAdmission({ rootStatus: "failed" })).rejects.toThrow("scheduled_prepare_owner_stale")
    await expect(waitingAdmission({ rootInterruptRequestedAt: now })).rejects.toThrow("scheduled_prepare_owner_stale")
    await expect(waitingAdmission({ turnStatus: "waiting_for_user" })).rejects.toThrow("scheduled_prepare_owner_stale")
  })

  it("rejects missing, ambiguous, unsuspended, consumed, or non-root waits", async () => {
    await expect(waitingAdmission({}, [])).rejects.toThrow("scheduled_prepare_owner_stale")
    await expect(waitingAdmission({}, [waitRow(), waitRow({ id: "duplicate" })])).rejects.toThrow("scheduled_prepare_owner_stale")
    await expect(waitingAdmission({}, [waitRow({ suspendedAt: null })])).rejects.toThrow("scheduled_prepare_owner_stale")
    await expect(waitingAdmission({}, [waitRow({ consumedAt: now })])).rejects.toThrow("scheduled_prepare_owner_stale")
    await expect(waitingAdmission({}, [waitRow({ stepTaskId: "other-root" })])).rejects.toThrow("scheduled_prepare_owner_stale")
    await expect(waitingAdmission({}, [waitRow({ attempt: 2 })])).rejects.toThrow("scheduled_prepare_owner_stale")
  })

  it("binds a released Turn lease to the continuation's exact historical version", async () => {
    const admitted = await waitingAdmission()
    expect(() => scheduledPrepareTurnOwnerFromAdmission(admitted, { ...receiptOwner, turnLeaseVersion: 6 }))
      .toThrow("scheduled_prepare_owner_stale")
    expect(() => scheduledPrepareTurnOwnerFromAdmission(admitted, { ...receiptOwner, rootAttemptCount: 2 }))
      .toThrow("scheduled_prepare_owner_stale")
    const replaced = await waitingAdmission({ leaseVersion: 8 })
    expect(() => scheduledPrepareTurnOwnerFromAdmission(replaced, receiptOwner)).toThrow("scheduled_prepare_owner_stale")
  })

  it("fails closed when the wait target set differs from the graph, omits Prepare, or is not materialized", async () => {
    const admitted = await waitingAdmission()
    expect(scheduledPrepareDependencyWaitMatchesGraph(admitted, graph, currentNodes.slice(0, 2), lease.id)).toBe(false)
    expect(scheduledPrepareDependencyWaitMatchesGraph(admitted, graph, currentNodes, "other-prepare")).toBe(false)
    const targetTaskIds = ["scout-1", "analyst-1"]
    const staleWait = await waitingAdmission({}, [waitRow({ targetTaskIds,
      result: { request: { mode: "all", targetTaskIds, timeoutMs: 60_000 } } })])
    expect(scheduledPrepareDependencyWaitMatchesGraph(staleWait, graph, currentNodes, lease.id)).toBe(false)
  })
})
