import { describe, expect, it } from "vitest"

import { commitDurableSubagentWaitResume, loadDurableSubagentWaitResume } from "./durable-subagent-wait-resume.js"

const now = new Date("2026-10-22T10:00:00.000Z")
const lease = {
  id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  ownerId: "worker-1", attemptCount: 3, leaseExpiresAt: new Date(now.getTime() + 60_000),
}
function fixture(options: { consumed?: boolean; nextStep?: boolean; laterOrdinals?: number[]; sourceOrdinal?: number; ownerId?: string; receiptWaitId?: string; missingResult?: boolean; callStatus?: string; callIdempotencyKey?: string; lateTerminal?: boolean; waitStatus?: "ready" | "timed_out"; mode?: string } = {}) {
  const calls: { sql: string; params: unknown[] }[] = []
  const state = { consumedAt: options.consumed ? now : null, acknowledgements: 0 }
  const waitStatus = options.waitStatus ?? "ready"
  const mode = options.mode ?? "any"
  const targetTaskIds = options.lateTerminal ? ["child-1", "child-2"] : ["child-1"]
  const deadlineAt = new Date(now.getTime() + (waitStatus === "timed_out" ? -5_000 : 5_000))
  const matchedTaskIds = ["child-1"]
  const snapshotTasks = [
    { taskId: "child-1", status: "completed", role: "writer", result: { answer: 42 }, failureReason: null },
    ...(options.lateTerminal ? [{ taskId: "child-2", status: "running", role: "analyst", result: null, failureReason: null }] : []),
  ]
  const outcome = { waitId: "wait-1", status: waitStatus, taskIds: targetTaskIds, deadlineAt: deadlineAt.toISOString(), matchedTaskIds,
    tasks: snapshotTasks }
  const wait = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1", stepId: "step-1",
    idempotencyKey: "wait-key", targetTaskIds, mode: "any", status: waitStatus, deadlineAt, matchedTaskIds,
    result: { request: { targetTaskIds, mode, timeoutMs: 5_000 }, outcome }, suspendedAt: now, consumedAt: state.consumedAt }
  wait.mode = mode
  const currentTargets = [
    { id: "child-1", parentTaskId: "parent-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", status: "completed", role: "writer", result: { answer: 42 }, failureReason: null },
    ...(options.lateTerminal ? [{ id: "child-2", parentTaskId: "parent-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", status: "completed", role: "analyst", result: { answer: 7 }, failureReason: null }] : []),
  ]
  const callContent = { toolCallId: "call-1", toolName: "wait_subagents", input: { idempotencyKey: options.callIdempotencyKey ?? "wait-key", taskIds: targetTaskIds, mode, timeoutMs: 5_000 } }
  const resultContent = { toolCallId: "call-1", output: { ...outcome, status: "waiting", waitId: options.receiptWaitId ?? "wait-1", matchedTaskIds: [] }, errorCode: null }
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.startsWith('SELECT "id", "userId", "status" FROM "agent_sessions" AS session')) return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && !sql.includes("ANY($1::text[])")) return { rows: [{
        id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        status: "running", attemptCount: 3, leaseOwner: options.ownerId ?? "worker-1", leaseExpiresAt: lease.leaseExpiresAt,
        interruptRequestedAt: null, turnStatus: "in_progress", rootStatus: "running",
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"') && sql.includes('ORDER BY step."ordinal" DESC')) return { rows: [{ id: "step-1", taskId: "parent-1", attempt: 3, ordinal: options.sourceOrdinal ?? 4, status: "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"') && sql.includes('"ordinal" > $5')) {
        const ordinals = options.nextStep === false ? [] : options.laterOrdinals ?? [5]
        return { rows: ordinals.slice(0, 2).map((ordinal, index) => ({ id: `step-next-${index}`, ordinal, attempt: 3, status: "streaming" })), rowCount: Math.min(ordinals.length, 2) }
      }
      if (sql.includes('FROM "agent_steps"') && sql.includes('WHERE "id" = $1') && params[0] === "step-1") return { rows: [{ id: "step-1", ordinal: 4, attempt: 3, status: "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('WHERE "id" IN')) return { rows: [wait], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('WHERE "id" = $1')) return { rows: [wait], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("ANY($1::text[])")) return { rows: currentTargets, rowCount: currentTargets.length }
      if (sql.includes('SELECT "id" AS "callItemId"') || sql.includes('FROM "agent_items" AS call JOIN')) return { rows: [{
        callItemId: "item-call-1", callContent, callStatus: options.callStatus ?? "completed",
      }], rowCount: 1 }
      if (sql.includes('SELECT "id", "content", "status" FROM "agent_items"')) return options.missingResult
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "item-result-1", content: resultContent, status: "completed" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) { state.consumedAt = now; wait.consumedAt = now; state.acknowledgements += 1; return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { pool: { connect: async () => client }, calls, state, wait }
}

describe("durable child wait resume", () => {
  it("loads the exact resolved outcome and original result item without consuming it", async () => {
    const fake = fixture()
    await expect(loadDurableSubagentWaitResume(fake.pool as never, lease, now)).resolves.toMatchObject({
      waitId: "wait-1", stepId: "step-1", attempt: 3, ordinal: 4, toolCallId: "call-1", sourceItemId: "item-result-1",
      output: { status: "ready", taskIds: ["child-1"] },
    })
    expect(fake.state.consumedAt).toBeNull()
    expect(fake.calls.some(call => call.sql.includes('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it.each(["ready", "timed_out"] as const)("keeps the persisted %s snapshot when another target becomes terminal later", async waitStatus => {
    const fake = fixture({ lateTerminal: true, waitStatus })
    const resumed = await loadDurableSubagentWaitResume(fake.pool as never, lease, now)

    expect(resumed?.output).toMatchObject({
      status: waitStatus, taskIds: ["child-1", "child-2"], matchedTaskIds: ["child-1"],
      tasks: [{ taskId: "child-1", status: "completed" }, { taskId: "child-2", status: "running" }],
    })
    await expect(commitDurableSubagentWaitResume(fake.pool as never, lease,
      { waitId: "wait-1", stepId: "step-1", nextStepOrdinal: 5, now })).resolves.toBe(true)
    expect(fake.state.acknowledgements).toBe(1)
  })

  it("rejects an invalid persisted mode during acknowledgement", async () => {
    const fake = fixture({ mode: "neither" })
    await expect(commitDurableSubagentWaitResume(fake.pool as never, lease,
      { waitId: "wait-1", stepId: "step-1", nextStepOrdinal: 5, now })).rejects.toMatchObject({ code: "wait_scope_error" })
  })

  it("replays a resolved unconsumed wait and recovers only its exact missing receipt", async () => {
    const fake = fixture({ missingResult: true, callStatus: "started" })
    const resumed = await loadDurableSubagentWaitResume(fake.pool as never, lease, now)

    expect(resumed).toMatchObject({ waitId: "wait-1", stepId: "step-1", attempt: 3, ordinal: 4,
      toolCallId: "call-1", sourceItemId: "recovered-wait-result:wait-1", input: { idempotencyKey: "wait-key", taskIds: ["child-1"] },
      output: { waitId: "wait-1", status: "ready", taskIds: ["child-1"] } })
    expect(fake.wait.consumedAt).toBeNull()
    expect(fake.calls.some(call => call.sql.includes('JOIN "agent_wait_conditions" AS wait') && call.sql.includes('wait."consumedAt" IS NULL'))).toBe(true)
    expect(fake.calls.some(call => call.sql.includes('FROM "agent_items"') && call.sql.includes('tool_result'))).toBe(true)
    expect(fake.calls.some(call => call.sql.includes('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it("leaves consumed-wait replay to the child continuation loader", async () => {
    const fake = fixture({ consumed: true })
    await expect(loadDurableSubagentWaitResume(fake.pool as never, lease, now)).resolves.toBeUndefined()
    expect(fake.state.consumedAt).toEqual(now)
  })

  it("rejects ambiguous pending continuations instead of selecting one by row order", async () => {
    const fake = fixture({ laterOrdinals: [8, 9] })
    await expect(loadDurableSubagentWaitResume(fake.pool as never, lease, now)).rejects.toMatchObject({ code: "wait_conflict" })
  })

  it("fails closed for a stale lease and a tool result receipt for another wait", async () => {
    const stale = fixture({ ownerId: "other-worker" })
    await expect(loadDurableSubagentWaitResume(stale.pool as never, lease, now)).rejects.toMatchObject({ code: "wait_scope_error" })
    const foreignReceipt = fixture({ receiptWaitId: "wait-other" })
    await expect(loadDurableSubagentWaitResume(foreignReceipt.pool as never, lease, now)).rejects.toMatchObject({ code: "wait_scope_error" })
    const arbitraryRecovery = fixture({ missingResult: true, callStatus: "started", callIdempotencyKey: "other-wait-key" })
    await expect(loadDurableSubagentWaitResume(arbitraryRecovery.pool as never, lease, now)).rejects.toMatchObject({ code: "wait_scope_error" })
  })

  it("acknowledges only after the same-attempt next step and immutable waiting receipt exist", async () => {
    const missingStep = fixture({ nextStep: false })
    await expect(commitDurableSubagentWaitResume(missingStep.pool as never, lease, { waitId: "wait-1", stepId: "step-1", nextStepOrdinal: 5, now }))
      .resolves.toBe(false)
    expect(missingStep.state.consumedAt).toBeNull()

    const fake = fixture()
    await expect(commitDurableSubagentWaitResume(fake.pool as never, lease, { waitId: "wait-1", stepId: "step-1", nextStepOrdinal: 5, now })).resolves.toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT "id", "userId", "status" FROM "agent_sessions" AS session')
      && call.sql.includes(`session."status" NOT IN ('aborted', 'archived')`))).toBe(true)
    expect(fake.state.consumedAt).toEqual(now)
    expect(fake.state.acknowledgements).toBe(1)
    expect(fake.calls.some(call => call.sql.includes("outputMatches"))).toBe(false)
    await expect(commitDurableSubagentWaitResume(fake.pool as never, lease, { waitId: "wait-1", stepId: "step-1", nextStepOrdinal: 5, now })).resolves.toBe(true)
    expect(fake.state.acknowledgements).toBe(1)
  })

  it("acknowledges an exact recovered wait receipt after the persisted continuation is replayed", async () => {
    const fake = fixture({ missingResult: true, callStatus: "started" })
    await expect(commitDurableSubagentWaitResume(fake.pool as never, lease,
      { waitId: "wait-1", stepId: "step-1", nextStepOrdinal: 5, now })).resolves.toBe(true)
    expect(fake.state.consumedAt).toEqual(now)
    expect(fake.state.acknowledgements).toBe(1)
  })

  it("acknowledges the first later child step across a Turn-global ordinal gap", async () => {
    const fake = fixture({ laterOrdinals: [9], sourceOrdinal: 4 })
    await expect(commitDurableSubagentWaitResume(fake.pool as never, lease,
      { waitId: "wait-1", stepId: "step-1", nextStepOrdinal: 9, now })).resolves.toBe(true)
    const continuationQuery = fake.calls.find(call => call.sql.includes('"ordinal" > $5'))
    expect(continuationQuery?.params).toEqual([lease.sessionId, lease.turnId, lease.id, lease.attemptCount, 4])
    expect(fake.state.acknowledgements).toBe(1)
  })

  it("rejects multiple later rows when acknowledging an unconsumed wait", async () => {
    const fake = fixture({ laterOrdinals: [8, 9], sourceOrdinal: 4 })
    await expect(commitDurableSubagentWaitResume(fake.pool as never, lease,
      { waitId: "wait-1", stepId: "step-1", nextStepOrdinal: 8, now })).rejects.toMatchObject({ code: "wait_conflict" })
    expect(fake.state.acknowledgements).toBe(0)
  })
})
