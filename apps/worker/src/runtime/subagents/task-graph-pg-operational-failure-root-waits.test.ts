import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { proveTaskGraphOperationalRootWaitReferences } from "./task-graph-pg-operational-failure-root-waits.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
const scope: GraphIdentityScope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root" }
const createdAt = new Date("2026-10-01T00:00:00.000Z")
const deadlineAt = new Date("2026-10-01T00:00:01.000Z")
const suspendedAt = new Date("2026-10-01T00:00:00.200Z")
const resolvedAt = new Date("2026-10-01T00:00:00.500Z")
const consumedAt = new Date("2026-10-01T00:00:00.700Z")
const canceled = { id: "canceled-child", rootTaskId: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId,
  userId: scope.userId, status: "cancelled", role: "analyst", attemptCount: 0, failureReason: "A prerequisite task did not complete.",
  startedAt: null, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, completedAt: new Date("2026-10-01T00:00:00.300Z"),
  closedAt: null, interruptRequestedAt: null, result: null, confidence: null, qualityGateResult: null, contextSnapshotId: null,
  outputArtifactIds: [], hasCanonicalDispatch: false }
const failed = { id: "failed-source", rootTaskId: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId,
  userId: scope.userId, status: "failed", role: "scout", attemptCount: 1, failureReason: "child_resume_unavailable",
  startedAt: new Date("2026-10-01T00:00:00.100Z"), leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
  completedAt: new Date("2026-10-01T00:00:00.400Z"), closedAt: null, interruptRequestedAt: null, result: null,
  confidence: null, qualityGateResult: null, contextSnapshotId: null, outputArtifactIds: [], hasCanonicalDispatch: true }
const targetIds = [canceled.id, failed.id].sort()
const taskRows = [canceled, failed]
const request = (mode: "all" | "any", ids = targetIds) => ({ targetTaskIds: ids, mode, timeoutMs: 1_000 })
const outcome = (waitId: string, status: "ready" | "timed_out", ids = targetIds) => ({ waitId, status,
  matchedTaskIds: ids, targetTaskIds: targetIds, tasks: targetIds.map(taskId => {
    const row = taskRows.find(task => task.id === taskId)!
    return { taskId, status: row.status, role: row.role, result: null,
      failureReason: row.failureReason }
  }) })

function rootWait(changes: Row = {}): Row {
  const id = "wait-root-1", stepId = "root-step-1"
  return { id, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
    stepId, idempotencyKey: "root-wait-call", targetTaskIds: targetIds, mode: "all", status: "ready", matchedTaskIds: targetIds,
    createdAt, deadlineAt, resolvedAt: null, suspendedAt: null, consumedAt: null, result: { request: request("all") },
    sessionUserId: scope.userId, parentId: scope.rootTaskId, parentSessionId: scope.sessionId, parentTurnId: scope.turnId,
    parentRootTaskId: scope.rootTaskId, parentParentTaskId: null, parentRole: "orchestrator", parentTaskType: "root",
    turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId, resolvedStepId: stepId, stepTaskId: scope.rootTaskId,
    stepAttempt: 1, ...changes }
}
function consumed(status: "ready" | "timed_out", mode: "all" | "any" = "all", ids = targetIds, changes: Row = {}): Row {
  const wait = rootWait({ mode, matchedTaskIds: ids, suspendedAt, resolvedAt, consumedAt,
    result: { request: request(mode), outcome: outcome("wait-root-1", status, ids) }, ...changes })
  wait.status = status
  return wait
}
function fixture(waitRows: readonly Row[], rows: readonly Row[] = taskRows) {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    void values
    return sql.includes('FROM "agent_wait_conditions" wait')
      ? { rows: [...waitRows], rowCount: waitRows.length }
      : { rows: [...rows], rowCount: rows.length }
  })
  const client: Client = { query: query as unknown as Client["query"] }
  return { client, query }
}
const input = { scope, taskIds: [canceled.id] }

describe("proveTaskGraphOperationalRootWaitReferences", () => {
  it("accepts producer-shaped inline ready waits without suspension or a consumed outcome", async () => {
    const f = fixture([rootWait()])
    await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(true)
    expect(f.query).toHaveBeenCalledTimes(2)
    expect(f.query.mock.calls[0]?.[1]).toEqual([[canceled.id]])
  })

  it("accepts immediate any waits when at least one recorded target is terminal", async () => {
    const pending = { ...canceled, id: "other-child", status: "queued", attemptCount: 0, failureReason: null, role: "application_filler" }
    const ids = [canceled.id, pending.id].sort()
    const wait = rootWait({ targetTaskIds: ids, matchedTaskIds: [canceled.id], mode: "any", result: { request: request("any", ids) } })
    const f = fixture([wait], [canceled, pending])
    await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(true)
  })

  it("rejects inline ready waits that mark a selected nonterminal target as matched", async () => {
    const pending = { ...canceled, status: "waiting", failureReason: null, completedAt: null }
    for (const mode of ["all", "any"] as const) {
      const matchedTaskIds = mode === "all" ? targetIds : [canceled.id]
      const wait = rootWait({ mode, matchedTaskIds, result: { request: request(mode) } })
      const f = fixture([wait], [pending, failed])
      await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(false)
    }
  })

  it("rejects inline ready waits that match nonselected nonterminal targets", async () => {
    const pending = { ...failed, status: "waiting" }
    for (const mode of ["all", "any"] as const) {
      const matchedTaskIds = mode === "all" ? targetIds : [pending.id]
      const wait = rootWait({ mode, matchedTaskIds, result: { request: request(mode) } })
      const f = fixture([wait], [canceled, pending])
      await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(false)
    }
  })

  it("rejects request-only ready all and any waits when a nonselected matched target is nonterminal", async () => {
    const pending = { ...failed, id: "pending-unselected", status: "waiting", attemptCount: 0,
      failureReason: null, startedAt: null, completedAt: null, hasCanonicalDispatch: false }
    const ids = [canceled.id, pending.id].sort()
    for (const mode of ["all", "any"] as const) {
      const matchedTaskIds = mode === "all" ? ids : [pending.id]
      const wait = rootWait({ targetTaskIds: ids, mode, matchedTaskIds,
        result: { request: request(mode, ids) } })
      const f = fixture([wait], [canceled, pending])
      await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(false)
    }
  })

  it.each(["ready", "timed_out"] as const)("accepts suspended consumed all-target %s waits without exporting proof", async status => {
    const f = fixture([consumed(status)])
    await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(true)
  })

  it("accepts consumed any waits with a terminal matched subset", async () => {
    const pending = { ...canceled, id: "other-child", status: "queued", attemptCount: 0, failureReason: null, role: "application_filler" }
    const ids = [canceled.id, pending.id].sort()
    const wait = consumed("ready", "any", [canceled.id], { targetTaskIds: ids })
    const waitResult = wait.result as Row
    const waitRequest = waitResult.request as Row
    waitRequest.targetTaskIds = ids
    const waitOutcome = waitResult.outcome as Row
    waitOutcome.targetTaskIds = ids
    waitOutcome.tasks = ids.map(taskId => {
      const row = [...taskRows, pending].find(task => task.id === taskId)!
      return { taskId, status: row.status, role: row.role, result: null, failureReason: null }
    })
    const f = fixture([wait], [canceled, pending])
    await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(true)
  })

  it("allows a same-root wait to retain a newly relation-cancelled pristine target only after exact receipt proof", async () => {
    const priorWaiting = { ...canceled, status: "waiting", failureReason: null, completedAt: null }
    const operationCancelled = { ...canceled, failureReason: null }
    const wait = consumed("timed_out", "all", [failed.id])
    const result = wait.result as Row, priorOutcome = result.outcome as Row
    priorOutcome.tasks = targetIds.map(taskId => taskId === canceled.id
      ? { taskId, status: "waiting", role: canceled.role, result: null, failureReason: null }
      : { taskId, status: failed.status, role: failed.role, result: null, failureReason: failed.failureReason })
    const receipt = { source: { nodeKey: "analyst-node", taskId: canceled.id }, event: { id: "cancel-event", sequence: "90",
      idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "analyst-node", 0, "task.cancelled") } }
    const before = fixture([wait], [priorWaiting, failed])
    await expect(proveTaskGraphOperationalRootWaitReferences(before.client, input)).resolves.toBe(true)

    const after = fixture([wait], [operationCancelled, failed])
    await expect(proveTaskGraphOperationalRootWaitReferences(after.client, input)).resolves.toBe(false)
    await expect(proveTaskGraphOperationalRootWaitReferences(after.client, { ...input, operationCancellations: [receipt] }))
      .resolves.toBe(true)
    await expect(proveTaskGraphOperationalRootWaitReferences(after.client, { ...input, operationCancellations: [
      { ...receipt, event: { ...receipt.event, idempotencyKey: "wrong-event-key" } },
    ] })).resolves.toBe(false)
    const childOwned = fixture([rootWait({ parentTaskId: canceled.id, parentId: canceled.id, parentParentTaskId: scope.rootTaskId,
      parentRole: "analyst", parentTaskType: "analyst" })], [operationCancelled, failed])
    await expect(proveTaskGraphOperationalRootWaitReferences(childOwned.client, { ...input, operationCancellations: [receipt] }))
      .resolves.toBe(false)
    const malformed = fixture([rootWait({ targetTaskIds: [canceled.id, canceled.id] })], [operationCancelled, failed])
    await expect(proveTaskGraphOperationalRootWaitReferences(malformed.client, { ...input, operationCancellations: [receipt] }))
      .resolves.toBe(false)
  })

  it("accepts stale unrelated target observations without treating them as fresh authority", async () => {
    const unrelated = { ...canceled, id: "unrelated-child", status: "completed", role: "writer", attemptCount: 1,
      failureReason: null, startedAt: new Date("2026-10-01T00:00:00.600Z"), completedAt: new Date("2026-10-01T00:00:00.900Z"),
      result: { summary: "completed after the observation" }, hasCanonicalDispatch: true }
    const ids = [canceled.id, failed.id, unrelated.id].sort()
    const matched = [canceled.id, failed.id].sort()
    const wait = consumed("ready", "any", matched, { targetTaskIds: ids })
    const waitResult = wait.result as Row
    const waitRequest = waitResult.request as Row
    waitRequest.targetTaskIds = ids
    const waitOutcome = waitResult.outcome as Row
    waitOutcome.targetTaskIds = ids
    waitOutcome.tasks = ids.map(taskId => {
      if (taskId === unrelated.id) return { taskId, status: "running", role: unrelated.role, result: null, failureReason: null }
      const row = taskRows.find(task => task.id === taskId)!
      return { taskId, status: row.status, role: row.role, result: null,
        failureReason: row.status === "failed" ? row.failureReason : null }
    })
    const f = fixture([wait], [canceled, failed, unrelated])
    await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(true)
  })

  it("rejects pending suspended waits and impossible ready/result combinations", async () => {
    for (const wait of [
      rootWait({ status: "waiting", suspendedAt, resolvedAt: null, consumedAt: null }),
      rootWait({ status: "ready", suspendedAt, resolvedAt, consumedAt: null }),
      rootWait({ result: { request: request("all"), extra: true } }),
      rootWait({ mode: "any", matchedTaskIds: [], result: { request: request("any"), outcome: outcome("wait-root-1", "ready", []) } }),
      consumed("ready", "all", [canceled.id]),
    ]) {
      const f = fixture([wait])
      await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(false)
    }
  })

  it("rejects child-owned, foreign, malformed, and non-pristine cancelled target references", async () => {
    for (const wait of [
      rootWait({ parentTaskId: canceled.id, parentId: canceled.id, parentParentTaskId: scope.rootTaskId,
        parentRole: "analyst", parentTaskType: "analyst" }),
      rootWait({ sessionUserId: "foreign-user" }),
      rootWait({ targetTaskIds: [canceled.id, canceled.id] }),
      rootWait({ resolvedStepId: "other-step" }),
    ]) {
      const f = fixture([wait])
      await expect(proveTaskGraphOperationalRootWaitReferences(f.client, input)).resolves.toBe(false)
    }
    const attempted = fixture([rootWait()], [{ ...canceled, attemptCount: 1 }, failed])
    await expect(proveTaskGraphOperationalRootWaitReferences(attempted.client, input)).resolves.toBe(false)
    const historicallyQueued = consumed("ready", "any", [failed.id])
    const historicalResult = historicallyQueued.result as Row
    const historicalOutcome = historicalResult.outcome as Row
    historicalOutcome.targetTaskIds = targetIds
    historicalOutcome.tasks = targetIds.map(taskId => taskId === canceled.id
      ? { taskId, status: "queued", role: canceled.role, result: null, failureReason: null }
      : { taskId, status: failed.status, role: failed.role, result: null, failureReason: failed.failureReason })
    const nowExecuted = fixture([historicallyQueued], [{ ...canceled, status: "completed", attemptCount: 1,
      failureReason: null, startedAt: new Date("2026-10-01T00:00:00.800Z"), result: { output: true }, hasCanonicalDispatch: true }, failed])
    await expect(proveTaskGraphOperationalRootWaitReferences(nowExecuted.client, input)).resolves.toBe(false)
  })
})
