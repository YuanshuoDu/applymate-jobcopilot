import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { scheduledPrepareReceiptOwnerRootMatches } from "./scheduled-prepare-owner-root.js"
import { SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE } from "./scheduled-audit-contract.js"
import { SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId: "prepare-1", attemptCount: 2 }
const owner = { ...scope, rootAttemptCount: 3 }
const audit = { id: "audit-1", role: SCHEDULED_AUDIT_ROLE, taskType: SCHEDULED_AUDIT_TASK_TYPE,
  status: "running", attemptCount: 1, failureReason: null }
const gate = { id: "gate-1", role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE,
  status: "running", attemptCount: 2, maxAttempts: 4, failureReason: null, leaseOwner: "gate-owner",
  leaseValid: true, deadlineValid: true, interruptRequestedAt: null }
const gateWitness = { gateTaskId: gate.id, gateAttemptCount: gate.attemptCount, leaseOwnerId: "gate-owner",
  requestAttemptCount: 1, preparedJobIds: ["job-1"] }
const prepare = { id: scope.taskId, role: "prepare", taskType: "scheduled_application_prepare",
  status: "completed", attemptCount: scope.attemptCount, failureReason: null }

function rootRow(overrides: Record<string, unknown> = {}) {
  return { id: scope.rootTaskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    status: "running", attemptCount: owner.rootAttemptCount, result: null, failureReason: null,
    turnStatus: "in_progress", turnLeaseOwnerId: "turn-owner", turnLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"), ...overrides }
}
function parkedRoot(waitId = "audit-wait") {
  return rootRow({ status: "waiting", result: { status: "waiting_for_dependency", stepCount: 4,
    toolCallCount: 2, finalItemId: null, waitId }, turnStatus: "waiting_for_dependency",
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
function prepareWaitRow(overrides: Record<string, unknown> = {}) {
  return { id: "prepare-wait", stepId: "root-step", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    parentTaskId: scope.rootTaskId, targetTaskIds: [prepare.id], mode: "all", status: "waiting",
    result: { request: { targetTaskIds: [prepare.id], mode: "all", timeoutMs: 60_000 } },
    suspendedAt: new Date("2026-10-27T00:00:00.000Z"), resolvedAt: null, consumedAt: null, activeWaitCount: 1,
    parentStatus: "waiting", parentAttemptCount: owner.rootAttemptCount,
    parentResult: { status: "waiting_for_dependency", stepCount: 4, toolCallCount: 2, finalItemId: null, waitId: "prepare-wait" },
    parentFailureReason: null, turnStatus: "waiting_for_dependency", turnLeaseOwnerId: null, turnLeaseExpiresAt: null,
    stepTaskId: scope.rootTaskId, stepAttempt: owner.rootAttemptCount, stepStatus: "waiting_for_tool", ordinal: 7, latestOrdinal: 7,
    targetTaskId: prepare.id, targetRootTaskId: scope.rootTaskId, targetParentTaskId: scope.rootTaskId,
    targetSessionId: scope.sessionId, targetTurnId: scope.turnId, targetRole: prepare.role, targetTaskType: prepare.taskType,
    targetStatus: "running", targetAttemptCount: prepare.attemptCount, targetFailureReason: null,
    targetLeaseOwner: "prepare-owner", targetLeaseValid: true, ...overrides }
}
function db(root = rootRow(), wait: Record<string, unknown> | null = null, gateRows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.includes('task."taskType" = \'root\'') ? [root]
    : sql.includes('FROM "sub_agent_tasks" AS task') ? gateRows
      : sql.includes('FROM "agent_wait_conditions"') && wait ? [wait] : [] }))
  return { query }
}
function gateWaitRow(overrides: Record<string, unknown> = {}) {
  const stepId = "gate-recovery-step", waitId = "gate-root-wait"
  const key = `scheduled-gate-wait:${createHash("sha256").update(JSON.stringify([gate.id, stepId, gateWitness.requestAttemptCount]), "utf8").digest("hex")}`
  return { id: waitId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    parentTaskId: scope.rootTaskId, stepId, idempotencyKey: key, targetTaskIds: [gate.id], mode: "any", status: "waiting",
    matchedTaskIds: [], result: { request: { targetTaskIds: [gate.id], mode: "any", timeoutMs: 86_400_000,
      scheduledGate: { gateTaskId: gate.id, requestAttemptCount: gateWitness.requestAttemptCount } } },
    suspendedAt: new Date("2026-10-27T00:00:00.000Z"), resolvedAt: null, consumedAt: null,
    parentStatus: "waiting", parentAttemptCount: owner.rootAttemptCount,
    parentResult: { status: "waiting_for_dependency", stepCount: 4, toolCallCount: 2, finalItemId: null, waitId },
    parentFailureReason: null, turnStatus: "waiting_for_dependency", turnLeaseOwnerId: null, turnLeaseExpiresAt: null,
    stepTaskId: scope.rootTaskId, stepAttempt: 1, stepStatus: "waiting_for_tool", activeGateWaitCount: 1, ...overrides }
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

  it("accepts Prepare completion only while the exact child lease owns the sole current parent wait", async () => {
    const client = db(parkedRoot("prepare-wait"), prepareWaitRow())
    await expect(scheduledPrepareReceiptOwnerRootMatches(client as never, scope, owner, "finish",
      new Map([[prepare.id, prepare]]), undefined, "prepare-owner"))
      .resolves.toMatchObject({ id: scope.rootTaskId, status: "waiting", attemptCount: owner.rootAttemptCount })
    expect(client.query).toHaveBeenCalledTimes(2)
    const [sql, values] = client.query.mock.calls[1]!
    expect(sql).toContain('target."leaseOwner"=$11')
    expect(values).toContain("prepare-owner")
  })

  it.each([
    ["a replaced wait", prepareWaitRow({ id: "other-wait" })],
    ["a duplicate active wait", prepareWaitRow({ activeWaitCount: 2 })],
    ["a widened target set", prepareWaitRow({ targetTaskIds: [prepare.id, "other-task"] })],
    ["a stale child attempt", prepareWaitRow({ targetAttemptCount: prepare.attemptCount + 1 })],
    ["a replaced child lease", prepareWaitRow({ targetLeaseOwner: "other-owner" })],
    ["an expired child lease", prepareWaitRow({ targetLeaseValid: false })],
  ] as const)("rejects Prepare completion with %s", async (_label, wait) => {
    const client = db(parkedRoot("prepare-wait"), wait)
    await expect(scheduledPrepareReceiptOwnerRootMatches(client as never, scope, owner, "finish",
      new Map([[prepare.id, prepare]]), undefined, "prepare-owner")).resolves.toBeNull()
  })

  it("requires the currently authenticated Prepare lease owner for a parent dependency wait", async () => {
    const client = db(parkedRoot("prepare-wait"), prepareWaitRow())
    await expect(scheduledPrepareReceiptOwnerRootMatches(client as never, scope, owner, "finish",
      new Map([[prepare.id, prepare]]))).resolves.toBeNull()
    expect(client.query).toHaveBeenCalledOnce()
  })

  it("accepts a Gate wait only with the current explicit Gate lease and attempt witness", async () => {
    const waiting = parkedRoot(), gateWait = gateWaitRow({ id: "audit-wait", parentResult: { status: "waiting_for_dependency",
      stepCount: 4, toolCallCount: 2, finalItemId: null, waitId: "audit-wait" } })
    const client = db(waiting, gateWait, [gate])
    await expect(scheduledPrepareReceiptOwnerRootMatches(client as never, scope, owner, "persisted_gate",
      new Map([[gate.id, gate]]), gateWitness)).resolves.toMatchObject({ id: scope.rootTaskId, status: "waiting" })
    expect(client.query).toHaveBeenCalledTimes(3)
    const leaseQuery = client.query.mock.calls[1]!
    expect(leaseQuery[1]).toContain(gateWitness.leaseOwnerId)
    expect(leaseQuery[0]).toContain('task."leaseOwner" = $8')
    const waitQuery = client.query.mock.calls[2]!
    expect(waitQuery[1]).toContain(gate.id)
    expect(waitQuery[0]).toContain('turn."status" = $7')
  })

  it("does not accept approval Turn state without a validated active same-Gate approval witness", async () => {
    const running = rootRow({ turnStatus: "waiting_for_approval", turnLeaseOwnerId: null, turnLeaseExpiresAt: null })
    await expect(scheduledPrepareReceiptOwnerRootMatches(db(running) as never, scope, owner, "persisted_gate",
      new Map([[gate.id, gate]]))).resolves.toBeNull()
    await expect(scheduledPrepareReceiptOwnerRootMatches(db(running, null, [gate]) as never, scope, owner, "persisted_gate",
      new Map([[gate.id, gate]]), gateWitness)).resolves.toBeNull()
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
