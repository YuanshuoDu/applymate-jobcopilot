import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"

const scope: TaskGraphVerificationScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "scout-1", attemptCount: 1 }
const callContent = { toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", input: {}, status: "completed", errorCode: null }
const rows = [
  { id: "call-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1", joinedStepId: "step-1", stepStatus: "completed", attempt: 1, ordinal: 0, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, type: "tool_call", status: "completed", revision: 1, content: callContent },
  { id: "result-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1", joinedStepId: "step-1", stepStatus: "completed", attempt: 1, ordinal: 0, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null } },
]
const events = [
  { id: "started", itemId: "call-item", taskId: scope.taskId, correlationId: "call-1", type: "tool_call.started", sequence: 1, payload: { taskId: scope.taskId, toolCallId: "call-1", toolName: "jobs.search" } },
  { id: "completed", itemId: "call-item", taskId: scope.taskId, correlationId: "call-1", type: "tool_call.completed", sequence: 2, payload: { taskId: scope.taskId, toolCallId: "call-1", toolName: "jobs.search", status: "completed", errorCode: null } },
]
function client(options: { rows?: typeof rows; events?: typeof events } = {}) {
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.includes('SELECT item."id"')) return { rows: options.rows ?? rows, rowCount: (options.rows ?? rows).length }
    if (sql.includes('SELECT event."id"')) return { rows: options.events ?? events, rowCount: (options.events ?? events).length }
    throw new Error("unexpected_verification_receipt_query")
  })
  return { query, client: { query } as unknown as Pick<pg.PoolClient, "query"> }
}

describe("loadTaskGraphVerificationReceipts", () => {
  it("reconstructs the exact current-attempt read receipt and canonical observations", async () => {
    const fake = client(), receipt = await loadTaskGraphVerificationReceipts(fake.client, scope)
    expect(receipt.items).toHaveLength(2)
    expect(receipt.evidenceObservations).toEqual([{ id: "tool-result:call-1", content: expect.objectContaining({ toolName: "jobs.search", output: { jobs: [{ id: "job-1", source: "greenhouse", observedSource: "greenhouse", location: null }] } }) }])
    expect(fake.query).toHaveBeenCalledTimes(2)
  })

  it("fails closed when receipt rows are outside the selected task attempt", async () => {
    const fake = client({ rows: rows.map(row => ({ ...row, taskId: "other-task" })) })
    await expect(loadTaskGraphVerificationReceipts(fake.client, scope)).rejects.toThrow("task_graph_verification_item_invalid")
  })

  it("rejects absent terminal tool lifecycle receipts", async () => {
    const fake = client({ events: [] })
    await expect(loadTaskGraphVerificationReceipts(fake.client, scope)).rejects.toThrow("task_graph_verification_event")
  })

  it("loads Root receipts with the persisted Root parentTaskId=null shape", async () => {
    const rootScope: TaskGraphVerificationScope = { ...scope, taskId: "root-1", rootTaskId: "root-1", parentTaskId: "root-1" }
    const rootRows = rows.map(row => ({ ...row, taskId: rootScope.taskId, rootTaskId: rootScope.rootTaskId, turnRootTaskId: rootScope.rootTaskId }))
    const rootEvents = events.map(event => ({ ...event, taskId: rootScope.taskId, payload: { ...event.payload, taskId: rootScope.taskId } }))
    const fake = client({ rows: rootRows as typeof rows, events: rootEvents as typeof events })
    const receipt = await loadTaskGraphVerificationReceipts(fake.client, rootScope)

    expect(receipt.items).toHaveLength(2)
    expect(fake.query.mock.calls[0]?.[0]).toContain('task."parentTaskId" IS NULL')
    expect(fake.query.mock.calls[0]?.[1]).toEqual([rootScope.taskId, rootScope.sessionId, rootScope.turnId,
      rootScope.rootTaskId, rootScope.parentTaskId, rootScope.userId, rootScope.attemptCount])
  })

  it("loads only completed history before the current ordinal while a current tool call is started", async () => {
    const rootScope: TaskGraphVerificationScope = { ...scope, taskId: "root-1", rootTaskId: "root-1", parentTaskId: "root-1",
      exclusiveBeforeOrdinal: 1 }
    const history = rows.map(row => ({ ...row, taskId: rootScope.taskId, rootTaskId: rootScope.rootTaskId,
      turnRootTaskId: rootScope.rootTaskId, ordinal: 0 }))
    const currentStarted = { ...history[0]!, id: "current-review-call", stepId: "current-step", joinedStepId: "current-step",
      ordinal: 1, stepStatus: "streaming", status: "started", content: { toolCallId: "current-review", toolName: "agent.review_sponsorship",
        toolVersion: "1", input: { jobId: "job-1" } } }
    const later = [
      { ...history[0]!, id: "later-call", stepId: "later-step", joinedStepId: "later-step", ordinal: 2,
        content: { ...callContent, toolCallId: "later-call-id" } },
      { ...history[1]!, id: "later-result", stepId: "later-step", joinedStepId: "later-step", ordinal: 2,
        content: { toolCallId: "later-call-id", output: { jobs: [{ id: "job-2", source: "greenhouse" }] }, errorCode: null } },
    ]
    const candidates = [...history.map(row => ({ ...row, taskId: rootScope.taskId, rootTaskId: rootScope.rootTaskId,
      turnRootTaskId: rootScope.rootTaskId })), currentStarted, ...later]
    const rootEvents = events.map(event => ({ ...event, taskId: rootScope.taskId,
      payload: { ...event.payload, taskId: rootScope.taskId } }))
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('SELECT item."id"')) {
        const bounded = sql.includes('AND step."ordinal" < $8')
          ? candidates.filter(row => Number(row.ordinal) < Number(values?.[7]))
          : candidates
        return { rows: bounded, rowCount: bounded.length }
      }
      if (sql.includes('SELECT event."id"')) return { rows: rootEvents, rowCount: rootEvents.length }
      throw new Error("unexpected_verification_receipt_query")
    })
    const receipt = await loadTaskGraphVerificationReceipts({ query } as unknown as Pick<pg.PoolClient, "query">, rootScope)

    expect(receipt.items).toHaveLength(2)
    expect(receipt.items.every(item => item.ordinal === 0)).toBe(true)
    expect(query.mock.calls[0]?.[0]).toContain('AND step."ordinal" < $8')
    expect(query.mock.calls[0]?.[1]).toEqual([rootScope.taskId, rootScope.sessionId, rootScope.turnId,
      rootScope.rootTaskId, rootScope.parentTaskId, rootScope.userId, rootScope.attemptCount, 1])
  })
})
