import { describe, expect, it, vi } from "vitest"
const projectionMocks = vi.hoisted(() => ({ forceTruncation: false, limits: [] as number[] }))
vi.mock("./durable-subagent-wait-store.js", async importOriginal => {
  const original = await importOriginal<typeof import("./durable-subagent-wait-store.js")>()
  return { ...original, safeSubagentWaitJson: (value: unknown, maxBytes = 512) => {
    projectionMocks.limits.push(maxBytes)
    return projectionMocks.forceTruncation ? { truncated: true, byteLength: maxBytes + 1, preview: "" } : original.safeSubagentWaitJson(value, maxBytes)
  } }
})
import { projectDurableSubagentWait } from "./durable-subagent-wait-store.js"
import { repairStaleWaitProjection } from "./pg-store-expiry-recovery-wait-projection.js"

const now = new Date("2026-10-06T10:00:00.000Z")
const lease = { id: "waiter-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  ownerId: "owner-1", attemptCount: 3, leaseExpiresAt: new Date(now.getTime() - 1_000) } as const

type Options = {
  wait?: Record<string, unknown>
  call?: Record<string, unknown>
  targets?: Array<Record<string, unknown>>
  noCall?: boolean
  duplicateCalls?: boolean
  missingWait?: boolean
  updateRowCount?: number
}
function fixture(options: Options = {}) {
  const createdAt = new Date(now.getTime() - 20_000)
  const wait = {
    id: "wait-1", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, parentTaskId: lease.id,
    stepId: "step-1", idempotencyKey: "wait-key-1", targetTaskIds: ["target-1"], mode: "any", status: "ready",
    createdAt, deadlineAt: new Date(createdAt.getTime() + 10_000), resolvedAt: new Date(now.getTime() - 5_000), matchedTaskIds: ["target-1"],
    suspendedAt: new Date(now.getTime() - 5_000), consumedAt: null,
    result: { preserved: "keep", request: { targetTaskIds: ["target-1"], mode: "any", timeoutMs: 9_999 }, outcome: { waitId: "wait-1", status: "waiting" } },
    repairTaskStatus: "running", repairLeaseOwner: lease.ownerId, repairTaskAttempt: lease.attemptCount,
    repairLeaseExpiresAt: lease.leaseExpiresAt, repairInterruptAt: null, repairNextAttemptAt: null, repairUserId: lease.userId,
    repairSessionStatus: "running", repairTurnStatus: "in_progress", repairRootStatus: "running", repairRootInterruptAt: null,
    repairAttempt: lease.attemptCount, repairOrdinal: 4, repairLatestOrdinal: 4, repairStepStatus: "waiting_for_tool",
  }
  const call = {
    callId: "call-item-1", callSessionId: lease.sessionId, callTurnId: lease.turnId, callTaskId: lease.id, callStepId: "step-1", status: "started",
    content: { toolCallId: "call-1", toolName: "wait_subagents", toolVersion: "1",
      input: { idempotencyKey: "wait-key-1", mode: "any", taskIds: ["target-1"], timeoutMs: 10_000 } },
    eventId: "event-1", eventSessionId: lease.sessionId, eventTurnId: lease.turnId, eventTaskId: lease.id,
    eventItemId: "call-item-1", eventCorrelationId: "call-1", eventCreatedAt: new Date(createdAt.getTime() - 1_000),
  }
  const target = { id: "target-1", parentTaskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
    turnId: lease.turnId, userId: lease.userId, status: "completed", role: "writer", result: { finalText: "done" }, failureReason: null }
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_wait_conditions" AS wait')) return options.missingWait
      ? { rows: [], rowCount: 0 } : { rows: [{ ...wait, ...options.wait }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS child')) return { rows: options.targets ?? [target], rowCount: (options.targets ?? [target]).length }
    if (sql.includes('FROM "agent_items" AS call')) {
      if (options.noCall) return { rows: [], rowCount: 0 }
      const callRows = [{ ...call, ...options.call }]
      if (options.duplicateCalls) callRows.push({ ...call, callId: "call-item-2", eventId: "event-2", eventItemId: "call-item-2",
        eventCorrelationId: "call-2", content: { ...call.content, toolCallId: "call-2" } })
      return { rows: callRows, rowCount: callRows.length }
    }
    if (sql.startsWith('UPDATE "agent_wait_conditions"')) return { rows: [{ id: "wait-1" }], rowCount: options.updateRowCount ?? 1 }
    throw new Error(`Unexpected SQL in projection test: ${sql}`)
  }) }
  return { client, calls }
}
function canonicalProjection() {
  const createdAt = new Date(now.getTime() - 20_000)
  const outcome = projectDurableSubagentWait({ id: "wait-1", targetTaskIds: ["target-1"], deadlineAt: new Date(createdAt.getTime() + 10_000) },
    [{ id: "target-1", status: "completed", role: "writer", result: { finalText: "done" }, failureReason: null }], "ready", ["target-1"])
  return { request: { targetTaskIds: ["target-1"], mode: "any", timeoutMs: 10_000 }, outcome }
}

describe("expired wait projection repair", () => {
  it("repairs only request/outcome from the exact call, canonical row, and current targets", async () => {
    const fake = fixture()
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({ status: "repaired" })
    const update = fake.calls.find(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))
    expect(update?.values?.slice(1, 11)).toEqual(["wait-1", lease.userId, lease.sessionId, lease.turnId, lease.id, "step-1",
      "wait-key-1", JSON.stringify(["target-1"]), JSON.stringify(["target-1"]), "any"])
    const persisted = JSON.parse(String(update?.values?.[0])) as Record<string, unknown>
    expect(Object.keys(persisted).sort()).toEqual(["outcome", "request"])
    expect(persisted.request).toEqual({ targetTaskIds: ["target-1"], mode: "any", timeoutMs: 10_000 })
    expect(persisted.outcome).toEqual({ waitId: "wait-1", status: "ready", taskIds: ["target-1"],
      deadlineAt: "2026-10-06T09:59:50.000Z", matchedTaskIds: ["target-1"],
      tasks: [{ taskId: "target-1", status: "completed", role: "writer", result: { finalText: "done" }, failureReason: null }] })
    const waitQuery = fake.calls[0]?.sql ?? ""
    expect(waitQuery).toContain('task."leaseOwner" = $6 AND task."attemptCount" = $7 AND task."leaseExpiresAt" = $8')
    expect(waitQuery).toContain('step."status" = \'waiting_for_tool\'')
    expect(waitQuery).toContain('current."attempt" = task."attemptCount"))))\n  AND wait."id" =')
    const callQuery = fake.calls.find(call => call.sql.includes('FROM "agent_items" AS call'))?.sql ?? ""
    expect(callQuery).toContain('call."stepId" = $4')
    expect(callQuery).toContain('started."type" = \'tool_call.started\'')
    expect(callQuery).toContain('settled."type" IN (\'tool_call.completed\', \'tool_call.failed\', \'tool_call.interrupted\')')
    expect(callQuery).toContain('result."type" = \'tool_result\'')
  })

  it("repairs a phone-like UUID waitId through safe whole-result serialization", async () => {
    const waitId = "00000000-0000-4000-8000-000000000000"
    const fake = fixture({ wait: { id: waitId } })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({ status: "repaired" })
    const update = fake.calls.find(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))
    const persisted = JSON.parse(String(update?.values?.[0])) as { outcome?: { waitId?: unknown } }
    expect(persisted.outcome?.waitId).toBe(waitId)
  })

  it("keeps the resolution-time matches when another any-wait target becomes terminal later", async () => {
    const secondTarget = { id: "target-2", parentTaskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
      turnId: lease.turnId, userId: lease.userId, status: "failed", role: "reviewer", result: null, failureReason: "failed later" }
    const fake = fixture({
      wait: { targetTaskIds: ["target-1", "target-2"] },
      call: { content: { toolCallId: "call-1", toolName: "wait_subagents", toolVersion: "1",
        input: { idempotencyKey: "wait-key-1", mode: "any", taskIds: ["target-1", "target-2"], timeoutMs: 10_000 } } },
      targets: [
        { id: "target-1", parentTaskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
          turnId: lease.turnId, userId: lease.userId, status: "completed", role: "writer", result: { finalText: "done" }, failureReason: null },
        secondTarget,
      ],
    })

    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({ status: "repaired" })
    const update = fake.calls.find(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))
    const persisted = JSON.parse(String(update?.values?.[0])) as Record<string, unknown>
    expect(persisted.outcome).toMatchObject({
      status: "ready",
      taskIds: ["target-1", "target-2"],
      matchedTaskIds: ["target-1"],
      tasks: [
        { taskId: "target-1", status: "completed" },
        { taskId: "target-2", status: "failed", failureReason: "failed later" },
      ],
    })
  })

  it.each([
    { label: "a persisted match that is no longer terminal", stage: "target_match_validation", wait: { targetTaskIds: ["target-1", "target-2"] }, targets: [
      { id: "target-1", parentTaskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
        turnId: lease.turnId, userId: lease.userId, status: "running", role: "writer", result: null, failureReason: null },
      { id: "target-2", parentTaskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
        turnId: lease.turnId, userId: lease.userId, status: "failed", role: "reviewer", result: null, failureReason: null },
    ] },
    { label: "ready all wait without every persisted match", stage: "target_match_validation", wait: { targetTaskIds: ["target-1", "target-2"], mode: "all" }, targets: [
      { id: "target-1", parentTaskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
        turnId: lease.turnId, userId: lease.userId, status: "completed", role: "writer", result: { finalText: "done" }, failureReason: null },
      { id: "target-2", parentTaskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
        turnId: lease.turnId, userId: lease.userId, status: "running", role: "reviewer", result: null, failureReason: null },
    ] },
    { label: "duplicate persisted match IDs", stage: "wait_validation", wait: { matchedTaskIds: ["target-1", "target-1"] } },
    { label: "persisted match outside the target scope", stage: "wait_validation", wait: { matchedTaskIds: ["other-target"] } },
  ])("fails closed for $label", async options => {
    const fake = fixture(options)
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toMatchObject({
      status: "rejected", stage: options.stage,
    })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("leaves a matching projection alone without requiring a pending started call", async () => {
    const valid = fixture({ noCall: true, wait: { result: canonicalProjection() } })
    await expect(repairStaleWaitProjection(valid.client as never, lease, now)).resolves.toEqual({ status: "already_current" })
    expect(valid.calls.some(call => call.sql.includes('FROM "agent_items" AS call'))).toBe(true)
    expect(valid.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("reports when WAIT_SQL finds no canonical wait row", async () => {
    const fake = fixture({ missingWait: true })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({
      status: "rejected", stage: "wait_row_count",
    })
    expect(fake.calls).toHaveLength(1)
  })

  it("rejects invalid helper input before issuing SQL", async () => {
    const fake = fixture()
    await expect(repairStaleWaitProjection(fake.client as never, { ...lease, attemptCount: 0 } as never, now)).resolves.toEqual({
      status: "rejected", stage: "invalid_input",
    })
    expect(fake.calls).toHaveLength(0)
  })

  it.each([
    { label: "a different lease expiry", stage: "lease_fence_validation", wait: { repairLeaseExpiresAt: new Date(now.getTime() - 2_000) } },
    { label: "an invalid wait timestamp", stage: "wait_timestamp_validation", wait: { createdAt: "invalid-date" } },
    { label: "an invalid timeout", stage: "timeout_validation", wait: { deadlineAt: new Date(now.getTime() - 20_000) } },
  ])("reports $label as a finite rejection stage", async options => {
    const fake = fixture({ wait: options.wait })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toMatchObject({
      status: "rejected", stage: options.stage,
    })
    expect(fake.calls.some(call => call.sql.includes('FROM "sub_agent_tasks" AS child'))).toBe(false)
  })

  it("accepts a canonical unconsumed wait with its latest streaming continuation", async () => {
    const fake = fixture({ noCall: true, wait: { result: canonicalProjection(), repairLatestOrdinal: 5,
      repairNextStatus: "streaming", repairNextOrdinal: 5 } })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({ status: "already_current" })
    const waitQuery = fake.calls[0]?.sql ?? ""
    expect(waitQuery).toContain(`step."status" IN ('waiting_for_tool', 'completed') AND EXISTS`)
    expect(waitQuery).toContain(`continuation."status" = 'streaming'`)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it.each([
    { label: "owner", wait: { repairLeaseOwner: "other-owner" } },
    { label: "attempt", wait: { repairTaskAttempt: 2, repairAttempt: 2 } },
  ])("rejects a canonical streaming continuation with a mismatched $label", async options => {
    const fake = fixture({ noCall: true, wait: { result: canonicalProjection(), repairLatestOrdinal: 5,
      repairNextStatus: "streaming", repairNextOrdinal: 5, ...options.wait } })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toMatchObject({
      status: "rejected", stage: "wait_validation",
    })
    expect(fake.calls.some(call => call.sql.includes('FROM "sub_agent_tasks" AS child'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("rejects duplicate exact unresolved wait calls even when the projection matches", async () => {
    const fake = fixture({ duplicateCalls: true, wait: { result: canonicalProjection() } })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({
      status: "rejected", stage: "call_result_validation",
    })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it.each([
    { label: "wrong idempotency key", call: { content: { toolCallId: "call-1", toolName: "wait_subagents", toolVersion: "1",
      input: { idempotencyKey: "other-key", mode: "any", taskIds: ["target-1"], timeoutMs: 10_000 } } } },
    { label: "malformed call input", call: { content: { toolCallId: "call-1", toolName: "wait_subagents", toolVersion: "1",
      input: { idempotencyKey: "wait-key-1", mode: "any", taskIds: ["target-1"], timeoutMs: 10_000, extra: true } } } },
    { label: "streaming status", call: { status: "streaming" } },
    { label: "wrong event correlation", call: { eventCorrelationId: "other-call" } },
    { label: "missing started event", call: { eventId: null } },
  ])("rejects a matching projection with $label", async options => {
    const fake = fixture({ wait: { result: canonicalProjection() }, call: options.call })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toMatchObject({
      status: "rejected", stage: "call_contract_validation",
    })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("accepts a canonical projection with the downstream completed call state", async () => {
    const fake = fixture({ wait: { result: canonicalProjection() }, call: { status: "completed" } })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({ status: "already_current" })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("reports a future started event timestamp without changing the wait", async () => {
    const fake = fixture({ call: { eventCreatedAt: new Date(now.getTime() + 1_000) } })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({
      status: "rejected", stage: "call_timestamp_validation",
    })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("fails closed when no pending call exists for a stale projection", async () => {
    const fake = fixture({ noCall: true })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({
      status: "rejected", stage: "call_result_validation",
    })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it.each(["suspendedAt", "resolvedAt"] as const)("accepts future app-clock %s only with exact canonical evidence", async field => {
    const future = new Date(now.getTime() + 1_000)
    const eligible = fixture({ wait: { [field]: future } })
    await expect(repairStaleWaitProjection(eligible.client as never, lease, now)).resolves.toEqual({ status: "repaired" })
    expect(eligible.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(true)

    const mismatched = fixture({ wait: { [field]: future }, call: { eventCorrelationId: "wrong-call" } })
    await expect(repairStaleWaitProjection(mismatched.client as never, lease, now)).resolves.toMatchObject({
      status: "rejected", stage: "call_contract_validation",
    })
    expect(mismatched.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("accepts a persisted timed_out status when the worker-clock deadline is ahead of recovery now", async () => {
    const createdAt = new Date(now.getTime() + 500)
    const deadlineAt = new Date(createdAt.getTime() + 10_000)
    const fake = fixture({ wait: { status: "timed_out", createdAt, deadlineAt, matchedTaskIds: [],
      suspendedAt: deadlineAt, resolvedAt: new Date(deadlineAt.getTime() + 1) },
    targets: [{ id: "target-1", parentTaskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
      turnId: lease.turnId, userId: lease.userId, status: "running", role: "writer", result: null, failureReason: null }] })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({ status: "repaired" })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(true)
  })

  it("does not write if the safe whole-result projection would truncate", async () => {
    const fake = fixture()
    projectionMocks.forceTruncation = true
    try { await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toMatchObject({
      status: "rejected", stage: "safe_serialization_validation",
    }) }
    finally { projectionMocks.forceTruncation = false }
    expect(projectionMocks.limits).toContain(16_384)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("reports an optimistic UPDATE that no longer matches its owner and projection fences", async () => {
    const fake = fixture({ updateRowCount: 0 })
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toEqual({
      status: "rejected", stage: "optimistic_update_missed",
    })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(true)
  })

  it.each([
    { label: "wrong owner", stage: "wait_validation", wait: { repairLeaseOwner: "other-owner" } },
    { label: "wrong attempt", stage: "wait_validation", wait: { repairTaskAttempt: 2, repairAttempt: 2 } },
    { label: "wrong step", stage: "wait_validation", wait: { repairStepStatus: "streaming" } },
    { label: "wrong call step", stage: "call_contract_validation", wait: { stepId: "other-step" } },
    { label: "consumed wait", stage: "wait_validation", wait: { consumedAt: now } },
    { label: "unresolved wait timestamp", stage: "wait_validation", wait: { resolvedAt: null } },
    { label: "wrong call identity", stage: "call_contract_validation", call: { content: { toolCallId: "call-1", toolName: "wait_subagents", toolVersion: "1",
      input: { idempotencyKey: "other-key", mode: "any", taskIds: ["target-1"], timeoutMs: 10_000 } } } },
    { label: "wrong event identity", stage: "call_contract_validation", call: { eventCorrelationId: "other-call" } },
    { label: "wrong target owner", stage: "target_validation", targets: [{ id: "target-1", parentTaskId: "other-parent", rootTaskId: lease.rootTaskId,
      sessionId: lease.sessionId, turnId: lease.turnId, userId: lease.userId, status: "completed", role: "writer", result: null, failureReason: null }] },
    { label: "incomplete targets", stage: "target_validation", targets: [] },
  ])("fails closed for $label", async options => {
    const fake = fixture(options)
    await expect(repairStaleWaitProjection(fake.client as never, lease, now)).resolves.toMatchObject({
      status: "rejected", stage: options.stage,
    })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_wait_conditions"'))).toBe(false)
  })
})
