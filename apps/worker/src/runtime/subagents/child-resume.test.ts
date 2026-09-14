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

function fakePool(child: SubagentLease, steps: Row[], items: Row[] = []) {
  const calls: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT task."id"')) return { rows: [currentRow(child)], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: steps, rowCount: steps.length }
      if (sql.includes('FROM "agent_items"')) {
        const visible = items.filter(row => Number(row.attempt) < child.attemptCount)
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
    expect(db.calls.find(call => call.sql.includes('FROM "agent_steps"'))?.values).toEqual([child.id, child.sessionId, child.turnId, child.userId, child.rootTaskId, child.attemptCount])
    expect(db.calls.find(call => call.sql.includes('FROM "agent_items"'))?.sql).toContain('step."attempt" < $6')
    expect(db.client.query.mock.calls.map(([sql]) => sql)).toContain("SELECT set_config($1, $2, true)")
  })

  it("keeps first attempt behavior without opening a database connection", async () => {
    const connect = vi.fn()
    await expect(loadChildAttemptResume({ connect } as never, lease({ attemptCount: 1 }))).resolves.toBeUndefined()
    expect(connect).not.toHaveBeenCalled()
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
