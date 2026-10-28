import { describe, expect, it, vi } from "vitest"
import { scheduledPrepareReceiptOwnerRootMatches } from "./scheduled-prepare-owner-root.js"
import { SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE } from "./scheduled-audit-contract.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const owner = { ...scope, rootAttemptCount: 3 }
const audit = { id: "audit-1", role: SCHEDULED_AUDIT_ROLE, taskType: SCHEDULED_AUDIT_TASK_TYPE,
  status: "running", attemptCount: 1, failureReason: null }

function rootRow(overrides: Record<string, unknown> = {}) {
  return { id: scope.rootTaskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    status: "running", attemptCount: owner.rootAttemptCount, result: null, failureReason: null,
    turnStatus: "in_progress", turnLeaseOwnerId: "turn-owner", turnLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"), ...overrides }
}
function parkedRoot() {
  return rootRow({ status: "waiting", result: { status: "waiting_for_dependency", stepCount: 4,
    toolCallCount: 2, finalItemId: null, waitId: "audit-wait" }, turnStatus: "waiting_for_dependency",
  turnLeaseOwnerId: null, turnLeaseExpiresAt: null })
}
function waitRow(overrides: Record<string, unknown> = {}) {
  return { id: "audit-wait", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    parentTaskId: scope.rootTaskId, stepId: "root-step", targetTaskIds: [audit.id], mode: "all", status: "waiting",
    result: { request: { targetTaskIds: [audit.id], mode: "all", timeoutMs: 60_000 } },
    suspendedAt: new Date("2026-10-27T00:00:00.000Z"), resolvedAt: null, consumedAt: null,
    parentStatus: "waiting", parentAttemptCount: owner.rootAttemptCount,
    parentResult: { status: "waiting_for_dependency", stepCount: 4, toolCallCount: 2, finalItemId: null, waitId: "audit-wait" },
    parentFailureReason: null, turnStatus: "waiting_for_dependency", turnLeaseOwnerId: null, turnLeaseExpiresAt: null,
    stepTaskId: scope.rootTaskId, stepAttempt: 1, stepStatus: "waiting_for_tool", targetTaskId: audit.id,
    targetRootTaskId: scope.rootTaskId, targetParentTaskId: scope.rootTaskId, targetSessionId: scope.sessionId,
    targetTurnId: scope.turnId, targetRole: audit.role, targetTaskType: audit.taskType, targetStatus: audit.status,
    targetAttemptCount: audit.attemptCount, targetFailureReason: null, ...overrides }
}
function db(root = rootRow(), wait: Record<string, unknown> | null = null) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.includes('FROM "sub_agent_tasks" AS task') ? [root]
    : sql.includes('FROM "agent_wait_conditions" AS wait') && wait ? [wait] : [] }))
  return { query }
}

describe("scheduled Prepare receipt root owner", () => {
  it.each(["finish", "persisted_gate"] as const)("keeps a running parent for %s verification", async phase => {
    const client = db()
    await expect(scheduledPrepareReceiptOwnerRootMatches(client as never, scope, owner, phase, new Map()))
      .resolves.toMatchObject({ id: scope.rootTaskId, status: "running", attemptCount: owner.rootAttemptCount })
    expect(client.query).toHaveBeenCalledOnce()
  })

  it("accepts persisted proof verification only for the exact suspended root wait on its running Audit node", async () => {
    const client = db(parkedRoot(), waitRow())
    await expect(scheduledPrepareReceiptOwnerRootMatches(client as never, scope, owner, "persisted_gate", new Map([[audit.id, audit]])))
      .resolves.toMatchObject({ id: scope.rootTaskId, status: "waiting", attemptCount: owner.rootAttemptCount })
    expect(client.query).toHaveBeenCalledTimes(2)
    const [sql, values] = client.query.mock.calls[1]!
    expect(values).toEqual(["audit-wait", scope.userId, scope.sessionId, scope.rootTaskId, scope.turnId,
      audit.id, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, audit.attemptCount, owner.rootAttemptCount])
    const placeholders = Array.from(String(sql).matchAll(/\$(\d+)/g), match => Number(match[1]))
    expect(Math.max(...placeholders)).toBe(values?.length)
  })

  it("rejects waiting roots during initial Prepare verification and for wrong root owner or attempt", async () => {
    const waiting = parkedRoot(), client = db(waiting, waitRow())
    await expect(scheduledPrepareReceiptOwnerRootMatches(client as never, scope, owner, "finish", new Map([[audit.id, audit]]))).resolves.toBeNull()
    expect(client.query).toHaveBeenCalledOnce()
    await expect(scheduledPrepareReceiptOwnerRootMatches(db(waiting) as never, scope, { ...owner, rootTaskId: "foreign-root" },
      "persisted_gate", new Map([[audit.id, audit]]))).resolves.toBeNull()
    await expect(scheduledPrepareReceiptOwnerRootMatches(db({ ...waiting, attemptCount: owner.rootAttemptCount - 1 }, waitRow()) as never,
      scope, owner, "persisted_gate", new Map([[audit.id, audit]]))).resolves.toBeNull()
  })

  it.each([
    ["missing wait", null],
    ["foreign wait owner", waitRow({ userId: "foreign-user" })],
    ["wrong parent", waitRow({ parentTaskId: "foreign-root" })],
    ["different target", waitRow({ targetTaskIds: ["other-task"], targetTaskId: "other-task",
      result: { request: { targetTaskIds: ["other-task"], mode: "all", timeoutMs: 60_000 } } })],
    ["multiple targets", waitRow({ targetTaskIds: [audit.id, "other-task"],
      result: { request: { targetTaskIds: [audit.id, "other-task"], mode: "all", timeoutMs: 60_000 } } })],
    ["unlinked root result", waitRow({ id: "other-wait" })],
    ["not suspended", waitRow({ suspendedAt: null })],
    ["already resolved", waitRow({ resolvedAt: new Date("2026-10-27T00:01:00.000Z") })],
    ["already consumed", waitRow({ consumedAt: new Date("2026-10-27T00:01:00.000Z") })],
    ["wrong step attempt", waitRow({ stepAttempt: 2 })],
  ] as const)("rejects a parked parent with %s", async (_label, wait) => {
    await expect(scheduledPrepareReceiptOwnerRootMatches(db(parkedRoot(), wait) as never, scope, owner, "persisted_gate",
      new Map([[audit.id, audit]]))).resolves.toBeNull()
  })

  it("rejects parked roots without one exact running Audit node in the loaded TaskGraph", async () => {
    for (const tasks of [new Map(), new Map([[audit.id, { ...audit, status: "completed" }]]),
      new Map([[audit.id, audit], ["audit-2", { ...audit, id: "audit-2" }]])]) {
      await expect(scheduledPrepareReceiptOwnerRootMatches(db(parkedRoot(), waitRow()) as never, scope, owner, "persisted_gate", tasks))
        .resolves.toBeNull()
    }
  })

  it.each([
    ["the parent resumed", waitRow({ parentStatus: "running" })],
    ["the parent wait id changed", waitRow({ parentResult: { status: "waiting_for_dependency", stepCount: 4,
      toolCallCount: 2, finalItemId: null, waitId: "different-wait" } })],
    ["the Turn lease was reacquired", waitRow({ turnStatus: "in_progress", turnLeaseOwnerId: "new-owner",
      turnLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z") })],
  ] as const)("rejects if the parent or Turn changes after the initial parked-root read: %s", async (_label, wait) => {
    const client = db(parkedRoot(), wait)
    await expect(scheduledPrepareReceiptOwnerRootMatches(client as never, scope, owner, "persisted_gate",
      new Map([[audit.id, audit]]))).resolves.toBeNull()
    expect(client.query).toHaveBeenCalledTimes(2)
  })
})
