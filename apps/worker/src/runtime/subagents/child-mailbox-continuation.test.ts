import { describe, expect, it, vi } from "vitest"

import { loadChildSameAttemptContinuation, prioritizeMailboxMessages, projectChildFinalText } from "./child-mailbox-continuation.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
const now = new Date("2099-09-14T11:00:00.000Z")
const future = new Date("2099-09-14T12:00:00.000Z")

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return {
    id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1,
    role: "scout", taskType: "research", status: "running", goal: "Find jobs", constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {},
    modelProfileSnapshot: {}, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: future,
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal, ...overrides,
  }
}

function currentRow(child: SubagentLease, overrides: Row = {}): Row {
  return { id: child.id, userId: child.userId, sessionId: child.sessionId, turnId: child.turnId, rootTaskId: child.rootTaskId,
    status: "running", leaseOwner: child.ownerId, attemptCount: child.attemptCount, leaseExpiresAt: child.leaseExpiresAt, interruptRequestedAt: null,
    turnStatus: "in_progress", rootStatus: "running", ...overrides }
}

function step(child: SubagentLease, overrides: Row = {}): Row {
  return { id: "step-1", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId,
    ordinal: 0, attempt: child.attemptCount, status: "completed", inputThroughSequence: "4", consumedInputIds: ["input-1"],
    inputTokens: 10, outputTokens: 5, estimatedCostUsd: "0.25", ...overrides }
}

function item(child: SubagentLease, overrides: Row = {}): Row {
  return { id: "final-1", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId,
    stepId: "step-1", type: "agent_message", status: "completed", phase: "final_answer", content: { text: "Found a role" },
    createdAt: new Date("2099-09-14T10:59:00.000Z"), ordinal: 0, attempt: child.attemptCount, ...overrides }
}

function consumedWait(child: SubagentLease, waitId: string, stepId: string, ordinal: number, continuationStepId: string, continuationOrdinal: number): Row {
  const deadlineAt = new Date("2099-09-14T11:30:00.000Z"), targetTaskIds = ["leaf-1"]
  const waitResult = { request: { targetTaskIds, mode: "all", timeoutMs: 30_000 },
    outcome: { waitId, status: "ready", taskIds: targetTaskIds, deadlineAt: deadlineAt.toISOString(), matchedTaskIds: targetTaskIds,
      tasks: [{ taskId: "leaf-1", status: "completed", role: "analyst", result: { summary: "Evidence ready" }, failureReason: null }] } }
  return { waitId, stepId, targetTaskIds, idempotencyKey: `key-${waitId}`, mode: "all", status: "ready", deadlineAt, matchedTaskIds: targetTaskIds,
    waitResult, attempt: child.attemptCount, ordinal, continuationStepId, continuationOrdinal, continuationLatestOrdinal: 2,
    callContent: { toolCallId: `call-${waitId}`, toolName: "wait_subagents", input: { taskIds: targetTaskIds, idempotencyKey: `key-${waitId}`, mode: "all", timeoutMs: 30_000 } },
    callStatus: "streaming", sourceItemId: null, resultContent: null, resultStatus: null }
}

function waitCallItem(child: SubagentLease, wait: Row): Row {
  const callContent = wait.callContent as Row
  return item(child, { id: `item-${String(wait.waitId)}`, stepId: wait.stepId, ordinal: wait.ordinal, type: "tool_call", phase: null,
    status: "streaming", content: callContent })
}

function fakePool(child: SubagentLease, steps: Row[], items: Row[] = [], current = currentRow(child), priorSteps: Row[] = [], priorItems: Row[] = [], filterTaskScope = false,
  consumedWaitRows: Row[] = [], waitTargetRows: Row[] = [], canonicalWaitRows: Row[] = consumedWaitRows) {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (query: string, values: readonly unknown[] = []) => {
      queries.push({ sql: query, values })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query) || query.includes("set_config")) return { rows: [], rowCount: 0 }
      if (query.startsWith('SELECT wait."id" AS "id"')) {
        const rows = consumedWaitRows.map(row => ({ id: row.waitId ?? row.id }))
        return { rows, rowCount: rows.length }
      }
      if (query.includes('FROM "agent_wait_conditions" AS wait')) {
        const waitId = values[6]
        const rows = canonicalWaitRows.filter(row => waitId === undefined || row.waitId === waitId || row.id === waitId)
        return { rows, rowCount: rows.length }
      }
      if (query.includes('WHERE task."id" = ANY($1::text[])')) {
        const ids = Array.isArray(values[0]) ? values[0] as string[] : []
        const rows = waitTargetRows.filter(row => ids.includes(String(row.id)))
        return { rows, rowCount: rows.length }
      }
      if (query.includes('FROM "agent_sessions"') && query.includes("FOR SHARE")) return { rows: [{ id: child.sessionId }], rowCount: 1 }
      if (query.includes('FROM "sub_agent_tasks" AS task') && query.includes('SELECT task."id"')) return { rows: [current], rowCount: 1 }
      if (query.includes('FROM "agent_steps" AS step')) {
        const currentAttempt = query.includes('step."attempt" = $6')
        const rows = currentAttempt ? steps : priorSteps
        const scoped = filterTaskScope ? rows.filter(row => row.taskId === child.id) : rows
        return { rows: scoped, rowCount: scoped.length }
      }
      if (query.includes('FROM "agent_items" AS item')) {
        const currentAttempt = query.includes('step."attempt" = $6')
        const rows = currentAttempt ? items : priorItems
        const scoped = filterTaskScope ? rows.filter(row => row.taskId === child.id) : rows
        return { rows: scoped, rowCount: scoped.length }
      }
      throw new Error(`unexpected query: ${query}`)
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) }, client, queries }
}

describe("same-attempt mailbox continuation", () => {
  it("restores current checkpoint plus cumulative same-task accounting without sibling ordinals or tool replay", async () => {
    const child = lease()
    const db = fakePool(child, [
      step(child, { ordinal: 0 }),
      step(child, { id: "step-2", ordinal: 2, inputThroughSequence: "8", consumedInputIds: ["input-1", "input-2"], inputTokens: 3, outputTokens: 2, estimatedCostUsd: "0.5" }),
      step(child, { id: "sibling-step", taskId: "sibling-task", ordinal: 1 }),
    ], [
      item(child, { id: "final-1", stepId: "step-1", ordinal: 0, content: { text: "Found one role." } }),
      item(child, { ordinal: 2, stepId: "step-2", id: "call-1", type: "tool_call", phase: null,
        content: { toolCallId: "call-a", toolName: "jobs.search", input: { query: "Dublin" } } }),
      item(child, { ordinal: 2, stepId: "step-2", id: "result-1", type: "tool_result", phase: null,
        content: { toolCallId: "call-a", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }),
      item(child, { ordinal: 2, stepId: "step-2", id: "final-2", content: { text: "Found two roles." } }),
    ], currentRow(child), [
      step(child, { id: "prior-step", attempt: 1, ordinal: 0, inputThroughSequence: "3", consumedInputIds: ["input-old"], inputTokens: 7, outputTokens: 4, estimatedCostUsd: "0.25" }),
    ], [
      item(child, { id: "prior-call", attempt: 1, stepId: "prior-step", type: "tool_call", phase: null,
        content: { toolCallId: "prior-call-id", toolName: "jobs.search", input: { query: "Galway" } } }),
      item(child, { id: "prior-result", attempt: 1, stepId: "prior-step", type: "tool_result", phase: null,
        content: { toolCallId: "prior-call-id", output: { jobs: [] }, errorCode: null } }),
    ], true)

    await expect(loadChildSameAttemptContinuation(db.pool as never, child, now)).resolves.toEqual({
      resume: { nextOrdinal: 3, stepCount: 3, toolCallCount: 2, inputThroughSequence: 8n, consumedInputIds: ["input-old", "input-1", "input-2"],
        usage: { inputTokens: 20, outputTokens: 11, estimatedCostUsd: 1 } },
      observations: [
        { id: "child-resume:prior-result", content: { toolCallId: "prior-call-id", toolName: "jobs.search", input: { query: "Galway" }, status: "completed", output: { jobs: [] }, errorCode: null } },
        { id: "child-resume:result-1", content: { toolCallId: "call-a", toolName: "jobs.search", input: { query: "Dublin" }, status: "completed", output: { jobs: [{ id: "job-1" }] }, errorCode: null } },
      ],
      previousFinalText: "Found two roles.", leaseExpiresAt: future,
    })
    expect(db.queries.find(query => query.sql.includes('FROM "agent_sessions"'))?.sql).toContain("FOR SHARE")
    expect(db.queries.filter(query => query.sql.includes('FROM "agent_steps"')).map(query => query.values)).toEqual([
      [child.id, child.sessionId, child.turnId, child.userId, child.rootTaskId, child.attemptCount],
      [child.id, child.sessionId, child.turnId, child.userId, child.rootTaskId, child.attemptCount],
    ])
    expect(db.queries.find(query => query.sql.includes('FROM "agent_steps"'))?.sql).toContain('step."taskId" = $1')
    expect(db.queries.filter(query => query.sql.includes('FROM "agent_items" AS item')).map(query => query.values)).toEqual([
      [child.id, child.sessionId, child.turnId, child.userId, child.rootTaskId, child.attemptCount],
      [child.id, child.sessionId, child.turnId, child.userId, child.rootTaskId, child.attemptCount],
    ])
    expect(db.queries.map(query => query.sql)).toContain("COMMIT")
  })

  it("uses the latest completed final after continuation while preserving sparse ordinals", async () => {
    const child = lease()
    const db = fakePool(child, [
      step(child, { ordinal: 0 }),
      step(child, { id: "step-2", ordinal: 2 }),
    ], [
      item(child, { id: "final-1", stepId: "step-1", ordinal: 0, content: { text: "Older final." } }),
      item(child, { id: "final-2", stepId: "step-2", ordinal: 2, content: { text: "Latest final." } }),
    ])

    await expect(loadChildSameAttemptContinuation(db.pool as never, child, now)).resolves.toMatchObject({
      resume: { nextOrdinal: 3, stepCount: 2 }, previousFinalText: "Latest final.",
    })
  })

  it("restores a consumed same-attempt wait before a later final without replaying tools", async () => {
    const child = lease()
    const deadlineAt = new Date("2099-09-14T11:30:00.000Z")
    const waitResult = {
      request: { targetTaskIds: ["leaf-1"], mode: "all", timeoutMs: 30_000 },
      outcome: { waitId: "wait-1", status: "ready", taskIds: ["leaf-1"], deadlineAt: deadlineAt.toISOString(), matchedTaskIds: ["leaf-1"],
        tasks: [{ taskId: "leaf-1", status: "completed", role: "analyst", result: { summary: "Evidence ready" }, failureReason: null }] },
    }
    const waitCall = { toolCallId: "wait-call", toolName: "wait_subagents", input: { taskIds: ["leaf-1"], idempotencyKey: "wait-key", mode: "all", timeoutMs: 30_000 } }
    const db = fakePool(child, [
      step(child, { id: "wait-step", ordinal: 0, status: "waiting_for_tool", inputThroughSequence: "5", inputTokens: 4, outputTokens: 2, estimatedCostUsd: "0.1" }),
      step(child, { id: "final-step", ordinal: 2, inputThroughSequence: "8", consumedInputIds: ["input-1", "input-2"], inputTokens: 3, outputTokens: 2, estimatedCostUsd: "0.5" }),
    ], [
      item(child, { id: "wait-call-item", stepId: "wait-step", ordinal: 0, type: "tool_call", phase: null, status: "streaming", content: waitCall }),
      item(child, { id: "search-call-item", stepId: "wait-step", ordinal: 0, type: "tool_call", phase: null,
        content: { toolCallId: "search-call", toolName: "jobs.search", input: { query: "Dublin" } } }),
      item(child, { id: "search-result-item", stepId: "wait-step", ordinal: 0, type: "tool_result", phase: null,
        content: { toolCallId: "search-call", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }),
      item(child, { id: "final-after-wait", stepId: "final-step", ordinal: 2, content: { text: "Found a role after wait" } }),
    ], currentRow(child), [], [], false, [{
      waitId: "wait-1", stepId: "wait-step", targetTaskIds: ["leaf-1"], idempotencyKey: "wait-key", mode: "all", status: "ready", deadlineAt,
      matchedTaskIds: ["leaf-1"], waitResult, attempt: child.attemptCount, ordinal: 0, continuationStepId: "final-step", continuationOrdinal: 2,
      continuationLatestOrdinal: 2, callContent: waitCall, callStatus: "streaming", sourceItemId: null, resultContent: null, resultStatus: null,
    }], [{ id: "leaf-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    await expect(loadChildSameAttemptContinuation(db.pool as never, child, now)).resolves.toMatchObject({
      resume: { nextOrdinal: 3, stepCount: 2, toolCallCount: 2, inputThroughSequence: 8n,
        usage: { inputTokens: 7, outputTokens: 4, estimatedCostUsd: 0.6 } },
      previousFinalText: "Found a role after wait",
      observations: [
        { id: "child-resume:search-result-item", content: { toolCallId: "search-call", toolName: "jobs.search", status: "completed" } },
        { id: "child-resume:recovered-wait-result:wait-1", content: { toolCallId: "wait-call", toolName: "wait_subagents", status: "completed" } },
      ],
    })
    expect(db.queries.some(query => query.sql.includes('FROM "agent_wait_conditions" AS wait'))).toBe(true)
    expect(db.queries.some(query => query.sql.includes('FROM "agent_items" AS item') && query.values.includes(child.attemptCount))).toBe(true)
  })

  it("restores multiple consumed waits before the latest same-attempt final", async () => {
    const child = lease()
    const firstWait = consumedWait(child, "wait-1", "step-wait-1", 0, "step-wait-2", 1)
    const secondWait = consumedWait(child, "wait-2", "step-wait-2", 1, "step-final", 2)
    const db = fakePool(child, [
      step(child, { id: "step-wait-1", ordinal: 0, status: "waiting_for_tool", inputThroughSequence: "2", inputTokens: 2, outputTokens: 1, estimatedCostUsd: "0.1" }),
      step(child, { id: "step-wait-2", ordinal: 1, status: "waiting_for_tool", inputThroughSequence: "4", inputTokens: 3, outputTokens: 1, estimatedCostUsd: "0.2" }),
      step(child, { id: "step-final", ordinal: 2, inputThroughSequence: "8", consumedInputIds: ["input-1", "input-2"], inputTokens: 4, outputTokens: 2, estimatedCostUsd: "0.3" }),
    ], [
      waitCallItem(child, firstWait), waitCallItem(child, secondWait),
      item(child, { id: "final-after-two-waits", stepId: "step-final", ordinal: 2, content: { text: "Final after both waits" } }),
    ], currentRow(child), [], [], false, [firstWait, secondWait], [
      { id: "leaf-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId },
    ])

    const restored = await loadChildSameAttemptContinuation(db.pool as never, child, now)
    expect(restored).toMatchObject({
      resume: { nextOrdinal: 3, stepCount: 3, toolCallCount: 2, inputThroughSequence: 8n, consumedInputIds: ["input-1", "input-2"],
        usage: { inputTokens: 9, outputTokens: 4 } },
      previousFinalText: "Final after both waits",
      observations: [
        { id: "child-resume:recovered-wait-result:wait-1", content: { toolCallId: "call-wait-1", toolName: "wait_subagents", status: "completed" } },
        { id: "child-resume:recovered-wait-result:wait-2", content: { toolCallId: "call-wait-2", toolName: "wait_subagents", status: "completed" } },
      ],
    })
    expect(restored?.resume.usage.estimatedCostUsd).toBeCloseTo(0.6)
    const exactWaitQueries = db.queries.filter(query => query.sql.includes('FROM "agent_wait_conditions" AS wait') && query.values.length === 7)
    expect(exactWaitQueries.map(query => query.values[6])).toEqual(["wait-1", "wait-2"])
    expect(exactWaitQueries.every(query => query.sql.includes('wait."id" = $7'))).toBe(true)
  })

  it("fails closed when an observed consumed wait id has no exact canonical checkpoint", async () => {
    const child = lease()
    const malformedCandidate = consumedWait(child, "misbound-wait", "wait-step", 0, "final-step", 1)
    const db = fakePool(child, [
      step(child, { id: "wait-step", ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: "final-step", ordinal: 1 }),
    ], [waitCallItem(child, malformedCandidate), item(child, { id: "latest-final", stepId: "final-step", ordinal: 1 })], currentRow(child), [], [], false,
    [malformedCandidate], [], [])

    await expect(loadChildSameAttemptContinuation(db.pool as never, child, now)).resolves.toBeNull()
    expect(db.queries.some(query => query.sql.includes('wait."id" = $7') && query.values[6] === "misbound-wait")).toBe(true)
    expect(db.queries.some(query => query.sql.includes('FROM "agent_steps" AS step') && query.values.includes(child.attemptCount))).toBe(false)
  })

  it("does not fall back to an older final when the latest completed step has none", async () => {
    const child = lease()
    const db = fakePool(child, [
      step(child, { ordinal: 0 }),
      step(child, { id: "step-2", ordinal: 2 }),
    ], [item(child, { id: "final-1", stepId: "step-1", ordinal: 0, content: { text: "Older final." } })])

    await expect(loadChildSameAttemptContinuation(db.pool as never, child, now)).resolves.toBeNull()
  })

  it("uses the live database lease when the in-memory expiry snapshot is stale", async () => {
    const stale = lease({ leaseExpiresAt: new Date("2099-09-14T10:00:00.000Z") })
    const renewed = fakePool(stale, [step(stale)], [item(stale)], currentRow(stale, { leaseExpiresAt: future }))
    await expect(loadChildSameAttemptContinuation(renewed.pool as never, stale, now)).resolves.toMatchObject({
      previousFinalText: "Found a role", leaseExpiresAt: future,
    })
    expect(renewed.queries.find(query => query.sql.includes('FROM "sub_agent_tasks" AS task'))?.sql).toContain('task."leaseExpiresAt" > clock_timestamp()')

    const expiredInDatabase = fakePool(stale, [step(stale)], [item(stale)], currentRow(stale, { leaseExpiresAt: new Date("2099-09-14T10:59:00.000Z") }))
    await expect(loadChildSameAttemptContinuation(expiredInDatabase.pool as never, stale, now)).resolves.toBeNull()
    expect(expiredInDatabase.queries.some(query => query.sql.includes('FROM "agent_steps"'))).toBe(false)
  })

  it.each([
    ["owner", { leaseOwner: "other-worker" }],
    ["attempt", { attemptCount: 1 }],
  ] as const)("returns no continuation for an exact current-row %s mismatch", async (_label, mismatch) => {
    const child = lease()
    const db = fakePool(child, [step(child)], [item(child)], currentRow(child, mismatch))
    await expect(loadChildSameAttemptContinuation(db.pool as never, child, now)).resolves.toBeNull()
    expect(db.queries.some(query => query.sql.includes('FROM "agent_steps"'))).toBe(false)
    expect(db.queries.map(query => query.sql)).toContain("ROLLBACK")
  })

  it("fails closed for non-increasing ordinals, incomplete steps, missing final text, or unsettled tool calls", async () => {
    const child = lease()
    const duplicateOrdinal = fakePool(child, [step(child), step(child, { id: "step-2", ordinal: 0 })], [item(child)])
    await expect(loadChildSameAttemptContinuation(duplicateOrdinal.pool as never, child, now)).resolves.toBeNull()

    const incomplete = fakePool(child, [step(child, { status: "streaming" })], [item(child)])
    await expect(loadChildSameAttemptContinuation(incomplete.pool as never, child, now)).resolves.toBeNull()

    const missingFinal = fakePool(child, [step(child)], [])
    await expect(loadChildSameAttemptContinuation(missingFinal.pool as never, child, now)).resolves.toBeNull()

    const unsettled = fakePool(child, [step(child)], [
      item(child, { type: "tool_call", phase: null, content: { toolCallId: "call-pending", toolName: "jobs.search", input: {} } }),
      item(child),
    ])
    await expect(loadChildSameAttemptContinuation(unsettled.pool as never, child, now)).resolves.toBeNull()
  })

  it("rejects malformed persisted task, attempt, or final-step bindings", async () => {
    const child = lease()
    const wrongTask = fakePool(child, [step(child, { taskId: "other-task" })], [item(child)])
    await expect(loadChildSameAttemptContinuation(wrongTask.pool as never, child, now)).resolves.toBeNull()

    const wrongAttempt = fakePool(child, [step(child, { attempt: 1 })], [item(child)])
    await expect(loadChildSameAttemptContinuation(wrongAttempt.pool as never, child, now)).resolves.toBeNull()

    const wrongFinalStep = fakePool(child, [step(child), step(child, { id: "step-2", ordinal: 1 })], [item(child)])
    await expect(loadChildSameAttemptContinuation(wrongFinalStep.pool as never, child, now)).resolves.toBeNull()

    const wrongItemTask = fakePool(child, [step(child)], [item(child, { taskId: "other-task" })])
    await expect(loadChildSameAttemptContinuation(wrongItemTask.pool as never, child, now)).resolves.toBeNull()

    const wrongItemAttempt = fakePool(child, [step(child)], [item(child, { attempt: 1 })])
    await expect(loadChildSameAttemptContinuation(wrongItemAttempt.pool as never, child, now)).resolves.toBeNull()
  })

  it("prioritizes required mailbox messages while preserving remaining order", () => {
    const messages = [{ id: "ordinary-1" }, { id: "priority-2" }, { id: "ordinary-2" }, { id: "priority-1" }]
    expect(prioritizeMailboxMessages(messages, ["priority-1", "missing", "priority-2", "priority-1"]))
      .toEqual([messages[3], messages[1], messages[0], messages[2]])
  })

  it("redacts secrets and bounds projected final text by UTF-8 bytes", () => {
    expect(projectChildFinalText("password=super-secret")).toBe("password=[REDACTED]")
    const projected = projectChildFinalText("日".repeat(3_000))
    expect(new TextEncoder().encode(projected).byteLength).toBeLessThanOrEqual(8 * 1024)
    expect(projected.endsWith("...[TRUNCATED]")).toBe(true)
  })
})
