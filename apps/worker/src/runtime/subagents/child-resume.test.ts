import { describe, expect, it, vi } from "vitest"

import { loadChildAttemptResume } from "./child-resume.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>

const future = new Date("2099-09-14T12:00:00.000Z")

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return {
    id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1,
    role: "scout", taskType: "research", status: "running", goal: "Find jobs", constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {},
    modelProfileSnapshot: {}, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: future,
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal, ...overrides,
  }
}

function currentRow(child: SubagentLease): Row {
  return { id: child.id, userId: child.userId, sessionId: child.sessionId, turnId: child.turnId, rootTaskId: child.rootTaskId,
    status: "running", leaseOwner: child.ownerId, attemptCount: child.attemptCount, leaseExpiresAt: future, interruptRequestedAt: null,
    turnStatus: "in_progress", rootStatus: "running" }
}

function step(child: SubagentLease, overrides: Row = {}): Row {
  return { id: "step-1", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId, ordinal: 0, attempt: 1, status: "completed",
    inputThroughSequence: "4", consumedInputIds: ["input-1"], inputTokens: 10, outputTokens: 5, estimatedCostUsd: "0.25", ...overrides }
}

function item(child: SubagentLease, overrides: Row = {}): Row {
  return { id: "item-call", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId, stepId: "step-1", type: "tool_call", status: "completed",
    content: { toolCallId: "call-1", toolName: "jobs.search", input: { query: "Dublin" } }, attempt: 1, ordinal: 0, ...overrides }
}

function consumedWait(child: SubagentLease): Row {
  const output = { waitId: "wait-1", status: "ready", taskIds: ["grandchild-1"], deadlineAt: "2099-09-14T11:30:00.000Z",
    matchedTaskIds: ["grandchild-1"], tasks: [{ taskId: "grandchild-1", status: "completed", role: "scout", result: { jobs: [] }, failureReason: null }] }
  const input = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
  return { waitId: "wait-1", stepId: "step-1", targetTaskIds: ["grandchild-1"], idempotencyKey: "wait-key", mode: "all", status: "ready",
    deadlineAt: output.deadlineAt, matchedTaskIds: ["grandchild-1"], waitResult: { request: { targetTaskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }, outcome: output }, attempt: child.attemptCount,
    ordinal: 0, continuationStepId: "step-2", continuationOrdinal: 1, continuationLatestOrdinal: 1,
    callContent: { toolCallId: "wait-call", toolName: "wait_subagents", input }, callStatus: "completed",
    resultContent: { toolCallId: "wait-call", output: { ...output, status: "waiting", matchedTaskIds: [] }, errorCode: null }, resultStatus: "completed",
    sourceItemId: "wait-result-id", consumedAt: future, suspendedAt: future }
}

function fakePool(child: SubagentLease, steps: Row[], items: Row[] = [], consumedWait?: Row, targets: Row[] = []) {
  const calls: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('WHERE task."id" = $1 AND task."sessionId"')) return { rows: [currentRow(child)], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions" AS wait')) return { rows: consumedWait ? [consumedWait] : [], rowCount: consumedWait ? 1 : 0 }
      if (sql.includes('WHERE task."id" = ANY($1::text[])')) return { rows: targets, rowCount: targets.length }
      if (sql.includes('FROM "agent_steps"')) {
        const visible = sql.includes('step."ordinal" <= $7')
          ? steps.filter(row => Number(row.attempt) === Number(values[5]) && Number(row.ordinal) <= Number(values[6]))
          : sql.includes('step."attempt" < $6') ? steps.filter(row => Number(row.attempt) < Number(values[5])) : steps
        return { rows: visible, rowCount: visible.length }
      }
      if (sql.includes('FROM "agent_items"')) {
        const visible = sql.includes('step."attempt" < $6 OR')
          ? items.filter(row => Number(row.attempt) < Number(values[5]) || Number(row.attempt) === Number(values[5]) && Number(row.ordinal) <= Number(values[6]))
          : items.filter(row => Number(row.attempt) < child.attemptCount)
        return { rows: visible, rowCount: visible.length }
      }
      throw new Error(`unexpected query: ${sql}`)
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) }
  return { pool, client, calls }
}

describe("child attempt durable resume", () => {
  it("aggregates prior attempt cursors, usage, ordinals and trusted tool results", async () => {
    const child = lease()
    const db = fakePool(child, [
      step(child),
      step(child, { id: "step-2", ordinal: 1, inputThroughSequence: "7", consumedInputIds: ["input-1", "input-2"], inputTokens: 3, outputTokens: 2, estimatedCostUsd: "0.5" }),
    ], [
      item(child),
      item(child, { id: "item-call-2", stepId: "step-2", content: { toolCallId: "call-2", toolName: "jobs.get", input: { id: "job-1" } } }),
      item(child, { id: "item-result", type: "tool_result", content: { toolCallId: "call-1", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }),
    ])

    const restored = await loadChildAttemptResume(db.pool as never, child)
    expect(restored).toEqual({
      resume: { nextOrdinal: 2, stepCount: 2, toolCallCount: 2, inputThroughSequence: 7n, consumedInputIds: ["input-1", "input-2"], usage: { inputTokens: 13, outputTokens: 7, estimatedCostUsd: 0.75 } },
      observations: [{ id: "child-resume:item-result", content: { toolCallId: "call-1", toolName: "jobs.search", input: { query: "Dublin" }, status: "completed", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }],
    })
    expect(db.calls.find(call => call.sql.includes('step."attempt" < $6'))?.values).toEqual([child.id, child.sessionId, child.turnId, child.userId, child.rootTaskId, child.attemptCount])
    expect(db.calls.find(call => call.sql.includes('FROM "agent_items"'))?.sql).toContain('step."attempt" < $6')
    expect(db.client.query.mock.calls.map(([sql]) => sql)).toContain("SELECT set_config($1, $2, true)")
  })

  it("checks first attempts for an acknowledged durable wait before returning no resume", async () => {
    const child = lease({ attemptCount: 1 }); const db = fakePool(child, [])
    await expect(loadChildAttemptResume(db.pool as never, child)).resolves.toBeUndefined()
    expect(db.pool.connect).toHaveBeenCalledOnce()
    expect(db.calls.some(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('FROM "agent_items"'))).toBe(false)
  })

  it("rehydrates a consumed wait projection from the wait row without advancing the attempt", async () => {
    const child = lease({ attemptCount: 1 })
    const wait = consumedWait(child)
    const waitInput = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
    const db = fakePool(child, [
      step(child, { id: "step-1", attempt: 1, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: "step-2", attempt: 1, ordinal: 1, status: "queued" }),
    ], [
      item(child, { id: "wait-call-item", stepId: "step-1", type: "tool_call", content: { toolCallId: "wait-call", toolName: "wait_subagents", input: waitInput } }),
      item(child, { id: "wait-result-id", stepId: "step-1", type: "tool_result", content: { toolCallId: "wait-call", output: { waitId: "wait-1", status: "waiting", taskIds: ["grandchild-1"], tasks: [] }, errorCode: null } }),
    ], wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    const restored = await loadChildAttemptResume(db.pool as never, child)

    expect(restored).toMatchObject({
      resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1 },
      durableWait: { waitId: "wait-1", stepId: "step-1", attempt: 1, ordinal: 0, toolCallId: "wait-call", sourceItemId: "wait-result-id" },
      observations: [{ id: "child-resume:wait-result-id", content: { toolCallId: "wait-call", toolName: "wait_subagents", status: "completed", output: { waitId: "wait-1", status: "ready" } } }],
    })
    expect(db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql).toContain('wait."consumedAt" IS NOT NULL')
    expect(db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql).toContain('next."ordinal" = (SELECT MIN(later."ordinal")')
    expect(db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql).toContain('next."ordinal" = (SELECT MAX(latest."ordinal")')
    expect(db.calls.find(call => call.sql.includes('WHERE task."id" = ANY($1::text[])'))?.values).toEqual([[
      "grandchild-1",
    ], child.sessionId, child.turnId, child.rootTaskId, child.id, child.userId])
  })

  it("reconstructs a missing exact receipt from the consumed wait at max attempt and reuses its persisted continuation", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const wait = consumedWait(child)
    wait.sourceItemId = null
    wait.callStatus = "started"
    wait.resultContent = null
    wait.resultStatus = null
    const waitInput = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
    const db = fakePool(child, [
      step(child, { id: "step-1", attempt: 3, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: "step-2", attempt: 3, ordinal: 1, status: "queued" }),
    ], [item(child, { id: "wait-call-item", attempt: 3, stepId: "step-1", type: "tool_call", content: { toolCallId: "wait-call", toolName: "wait_subagents", input: waitInput } })],
    wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    const restored = await loadChildAttemptResume(db.pool as never, child)

    expect(restored).toMatchObject({
      resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1 },
      durableWait: { waitId: "wait-1", attempt: 3, ordinal: 0, toolCallId: "wait-call", sourceItemId: "recovered-wait-result:wait-1" },
      observations: [{ id: "child-resume:recovered-wait-result:wait-1", content: { toolCallId: "wait-call", toolName: "wait_subagents", status: "completed", output: { waitId: "wait-1", status: "ready" } } }],
    })
    expect(restored?.resume.nextOrdinal).toBe(1)
    expect(db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql).toContain('LEFT JOIN "agent_items" AS result')
  })

  it("uses the first later task ordinal while keeping the deterministic logical resume ordinal", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const wait = { ...consumedWait(child), continuationOrdinal: 9, continuationLatestOrdinal: 9 }
    const db = fakePool(child, [
      step(child, { id: "step-1", attempt: 3, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: "step-2", attempt: 3, ordinal: 9, status: "streaming" }),
    ], [], wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    await expect(loadChildAttemptResume(db.pool as never, child)).resolves.toMatchObject({
      resume: { nextOrdinal: 1 },
      durableWait: { ordinal: 0, attempt: 3 },
    })
    const lineage = db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql ?? ""
    expect(lineage).toContain('later."ordinal" > candidateStep."ordinal"')
    expect(lineage).toContain('next."ordinal" = (SELECT MAX(latest."ordinal")')
  })

  it("fails closed when a same-attempt consumed wait has no exact latest continuation", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const wait = { ...consumedWait(child), continuationOrdinal: 2, continuationLatestOrdinal: 3 }
    const db = fakePool(child, [
      step(child, { id: "step-1", attempt: 3, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: "step-2", attempt: 3, ordinal: 1, status: "queued" }),
    ], [], wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    await expect(loadChildAttemptResume(db.pool as never, child)).rejects.toThrow("child_resume_wait_lineage")
  })

  it("replays the exact consumed wait observation after an ordinary attempt rollover", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const wait = consumedWait(child)
    wait.attempt = 2
    wait.sourceItemId = null
    wait.callStatus = "started"
    wait.resultContent = null
    wait.resultStatus = null
    const waitInput = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
    const db = fakePool(child, [
      step(child, { id: "wait-step-attempt-2", attempt: 2, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: "continuation-attempt-2", attempt: 2, ordinal: 1, status: "queued" }),
    ], [item(child, { id: "wait-call-item", attempt: 2, stepId: "wait-step-attempt-2", type: "tool_call",
      content: { toolCallId: "wait-call", toolName: "wait_subagents", input: waitInput } })],
    { ...wait, stepId: "wait-step-attempt-2" },
    [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    const restored = await loadChildAttemptResume(db.pool as never, child)

    expect(restored).toMatchObject({
      resume: { nextOrdinal: 1, stepCount: 2, toolCallCount: 1 },
      observations: [{ id: "child-resume:recovered-wait-result:wait-1", content: {
        toolCallId: "wait-call", toolName: "wait_subagents", status: "completed", output: { waitId: "wait-1", status: "ready" },
      } }],
    })
    expect(restored).not.toHaveProperty("durableWait")
    expect(db.calls.some(call => call.sql.includes('step."ordinal" <= $7'))).toBe(false)
    expect(db.calls.find(call => call.sql.includes('step."attempt" < $6'))?.values[5]).toBe(3)
  })

  it("returns no resume when recovery has no prior attempt evidence", async () => {
    const child = lease()
    const db = fakePool(child, [])
    await expect(loadChildAttemptResume(db.pool as never, child)).resolves.toBeUndefined()
    expect(db.client.query.mock.calls.map(([sql]) => sql)).not.toContain(expect.stringContaining('FROM "agent_items"'))
  })

  it("fails closed for a mismatched running lease or cross-lineage persisted row", async () => {
    const child = lease()
    const mismatch = fakePool(child, [step(child, { taskId: "other-task" })])
    mismatch.client.query.mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
      mismatch.calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT task."id"')) return { rows: [{ ...currentRow(child), leaseOwner: "other-worker" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [step(child, { taskId: "other-task" })], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    await expect(loadChildAttemptResume(mismatch.pool as never, child)).rejects.toThrow("child_resume_owner_mismatch")
    expect(mismatch.client.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK")

    const crossItem = fakePool(child, [step(child)], [item(child, { sessionId: "other-session" })])
    await expect(loadChildAttemptResume(crossItem.pool as never, child)).rejects.toThrow("child_resume_item_lineage")
  })

  it("does not restore an item from the current attempt or an unbound result", async () => {
    const child = lease()
    const db = fakePool(child, [step(child)], [
      item(child, { id: "current-call", attempt: child.attemptCount }),
      item(child, { id: "orphan-result", type: "tool_result", content: { toolCallId: "missing", output: { secret: false }, errorCode: null } }),
    ])
    const restored = await loadChildAttemptResume(db.pool as never, child)
    expect(restored?.resume.toolCallCount).toBe(0)
    expect(restored?.observations).toEqual([])
  })

  it("redacts sensitive fields and bounds restored tool output", async () => {
    const child = lease()
    const db = fakePool(child, [step(child)], [
      item(child),
      item(child, { id: "large-result", type: "tool_result", content: { toolCallId: "call-1", output: { apiKey: "secret", text: "x".repeat(20_000) }, errorCode: null } }),
    ])
    const restored = await loadChildAttemptResume(db.pool as never, child, new Date("2099-09-14T11:00:00.000Z"))
    const observation = restored?.observations[0]?.content as { readonly output?: unknown }
    expect(observation.output).toMatchObject({ truncated: true })
    expect(JSON.stringify(observation.output)).not.toContain("apiKey")
    expect(new TextEncoder().encode(JSON.stringify(observation.output)).length).toBeLessThanOrEqual(6 * 1024)
  })

  it.each([
    ["failed", 1], ["streaming", 1], ["interrupted", 1], ["completed", 2], ["waiting_for_tool", 2], ["waiting_for_approval", 2], ["waiting_for_user", 2],
  ] as const)("%s final prior step %s its logical ordinal", async (status, expectedNextOrdinal) => {
    const child = lease()
    const db = fakePool(child, [step(child, { status, ordinal: 1 })])
    await expect(loadChildAttemptResume(db.pool as never, child)).resolves.toMatchObject({ resume: { nextOrdinal: expectedNextOrdinal } })
  })

  it("fails closed when bounded prior history exceeds the step or item limit", async () => {
    const child = lease()
    const tooManySteps = fakePool(child, Array.from({ length: 257 }, (_, index) => step(child, { id: `step-${index}`, ordinal: index, consumedInputIds: [] })))
    await expect(loadChildAttemptResume(tooManySteps.pool as never, child)).rejects.toThrow("child_resume_step_limit")
    const tooManyItems = fakePool(child, [step(child)], Array.from({ length: 1_025 }, (_, index) => item(child, { id: `item-${index}`, content: { toolCallId: `call-${index}`, toolName: "jobs.search" } })))
    await expect(loadChildAttemptResume(tooManyItems.pool as never, child)).rejects.toThrow("child_resume_item_limit")
  })

  it("fails closed when a tool call id crosses steps", async () => {
    const child = lease()
    const db = fakePool(child, [step(child), step(child, { id: "step-2", ordinal: 1 })], [
      item(child), item(child, { id: "item-call-2", stepId: "step-2" }),
    ])
    await expect(loadChildAttemptResume(db.pool as never, child)).rejects.toThrow("child_resume_tool_call_conflict")
  })
})
