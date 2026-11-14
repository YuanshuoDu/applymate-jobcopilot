import { beforeEach, describe, expect, it, vi } from "vitest"

const lifecycle = vi.hoisted(() => ({ deleteGraphDispatch: vi.fn(), persistGraphTransition: vi.fn(),
  prepareGraphTransition: vi.fn(), reconcileGraphDependents: vi.fn() }))
const nested = vi.hoisted(() => ({ settle: vi.fn() }))
vi.mock("./task-graph-pg-lifecycle.js", () => lifecycle)
vi.mock("./nested-scout-deadline-terminal.js", () => ({ settleExpiredNestedScoutDescendants: nested.settle }))

import { expireTaskGraphChild, taskGraphDeadlineFailureResult } from "./pg-store-task-graph-deadline-terminal.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"

function node(disposition: "typed" | "specialized"): StoredTaskGraphNode {
  return { key: "analyst", taskId: "child", verificationDisposition: disposition,
    verification: disposition === "typed" ? { criteria: [{ id: "finding-count" }] } : undefined } as unknown as StoredTaskGraphNode
}

describe("TaskGraph deadline terminal result", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lifecycle.prepareGraphTransition.mockResolvedValue({
      snapshot: { nodes: [{ taskId: "parent-scout", verificationDisposition: "specialized" }] },
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" },
    })
    nested.settle.mockResolvedValue([])
  })

  it("replaces stale verification metadata with a canonical typed unverified report", () => {
    const result = taskGraphDeadlineFailureResult({ workerResult: { text: "partial" }, taskGraphVerificationReport: { status: "passed" } }, node("typed"))
    expect(result).toMatchObject({ workerResult: { text: "partial" }, taskGraphVerificationReport: {
      status: "unverified", reasonCode: "result_invalid", evidenceDigest: null, resultDigest: null,
      criteria: [{ criterionId: "finding-count", status: "unverified", reasonCode: "result_invalid" }],
    } })
    expect(result).not.toHaveProperty("structuredResult")
  })

  it("preserves the stored result for specialized graph nodes", () => {
    const value = { specializedReceipt: { id: "receipt" } }
    expect(taskGraphDeadlineFailureResult(value, node("specialized"))).toBe(value)
  })

  it("settles nested Scout descendants on the same transaction after canonical parent failure", async () => {
    const candidate = { id: "parent-scout", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", userId: "user-1" }
    const parentRow = { ...candidate, parentTaskId: "root-1", depth: 1, role: "scout", taskType: "job_discovery",
      status: "running", attemptCount: 1, result: null, interruptRequestedAt: null, absoluteDeadlineAt: new Date(0) }
    const refreshed = { ...parentRow, status: "failed", failureReason: "task_graph_child_deadline_exceeded" }
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql)
      if (text.startsWith('UPDATE "sub_agent_tasks"') && text.includes('RETURNING "updatedAt"')) return { rows: [{ updatedAt: new Date() }], rowCount: 1 }
      if (text.includes('FROM "sub_agent_tasks" task JOIN')) return { rows: [refreshed], rowCount: 1 }
      if (text.includes('SELECT task.*, session."userId" AS "userId"')) return { rows: [parentRow], rowCount: 1 }
      if (text.includes('SELECT "userId", "status" FROM "agent_sessions"')) return { rows: [{ userId: candidate.userId, status: "running" }], rowCount: 1 }
      if (text.includes('FROM "agent_turns"')) return { rows: [{ id: candidate.turnId }], rowCount: 1 }
      if (text.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: candidate.rootTaskId }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const client = { query } as never
    await expect(expireTaskGraphChild(client, candidate)).resolves.toMatchObject({ id: candidate.id, status: "failed" })
    const parentWrite = lifecycle.persistGraphTransition.mock.invocationCallOrder[0]
    const cascade = nested.settle.mock.invocationCallOrder[0]
    expect(parentWrite).toBeLessThan(cascade)
    expect(nested.settle).toHaveBeenCalledWith(client, { userId: candidate.userId, sessionId: candidate.sessionId,
      turnId: candidate.turnId, rootTaskId: candidate.rootTaskId, parentScoutId: candidate.id })
  })

  it("does not invoke nested Scout cleanup for non-Scout graph children", async () => {
    const candidate = { id: "analyst-child", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", userId: "user-1" }
    lifecycle.prepareGraphTransition.mockResolvedValueOnce({
      snapshot: { nodes: [{ taskId: candidate.id, verificationDisposition: "specialized" }] },
      scope: { userId: candidate.userId, sessionId: candidate.sessionId, turnId: candidate.turnId,
        rootTaskId: candidate.rootTaskId, parentTaskId: candidate.rootTaskId },
    })
    const row = { ...candidate, parentTaskId: "root-1", depth: 1, role: "analyst", taskType: "research",
      status: "running", attemptCount: 1, result: null, interruptRequestedAt: null, absoluteDeadlineAt: new Date(0) }
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql)
      if (text.startsWith('UPDATE "sub_agent_tasks"') && text.includes('RETURNING "updatedAt"')) return { rows: [{ updatedAt: new Date() }], rowCount: 1 }
      if (text.includes('FROM "sub_agent_tasks" task JOIN')) return { rows: [row], rowCount: 1 }
      if (text.includes('SELECT task.*, session."userId" AS "userId"')) return { rows: [row], rowCount: 1 }
      if (text.includes('SELECT "userId", "status" FROM "agent_sessions"')) return { rows: [{ userId: candidate.userId, status: "running" }], rowCount: 1 }
      if (text.includes('FROM "agent_turns"')) return { rows: [{ id: candidate.turnId }], rowCount: 1 }
      if (text.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: candidate.rootTaskId }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    await expireTaskGraphChild({ query } as never, candidate)
    expect(nested.settle).not.toHaveBeenCalled()
  })
})
