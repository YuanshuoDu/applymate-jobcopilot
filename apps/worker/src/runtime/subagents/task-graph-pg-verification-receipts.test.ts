import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import type pg from "pg"
import { TASK_GRAPH_REPLAY_CALL_PREFIX } from "./task-graph-pg-event-validation.js"
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
  const query = vi.fn(async (sql: string) => {
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

  it("reconstructs replay proofs through the scoped source queries and shared validators", async () => {
    const sourceCallId = "source-call-1", sourceResultItemId = "source-result-1", stepId = "step-2"
    const replayCallId = `${TASK_GRAPH_REPLAY_CALL_PREFIX}${createHash("sha256").update(JSON.stringify([stepId, sourceCallId])).digest("hex")}`
    const replayScope = { ...scope, attemptCount: 2 }
    const currentItems = [
      { ...rows[0], id: "replay-call-item", stepId, joinedStepId: stepId, attempt: 2,
        content: { ...callContent, toolCallId: replayCallId } },
      { ...rows[1], id: "replay-result-item", stepId, joinedStepId: stepId, attempt: 2,
        content: { toolCallId: replayCallId, output: { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null } },
    ]
    const replaySource = { toolCallId: sourceCallId, resultItemId: sourceResultItemId }
    const currentEvents = [
      { ...events[0], id: "replay-start", itemId: "replay-call-item", correlationId: replayCallId,
        payload: { ...events[0].payload, toolCallId: replayCallId, replaySource } },
      { ...events[1], id: "replay-completed", itemId: "replay-call-item", correlationId: replayCallId,
        payload: { ...events[1].payload, toolCallId: replayCallId, replaySource } },
    ]
    const sourceCallContent = { ...callContent, toolCallId: sourceCallId }
    const sourceResultContent = { toolCallId: sourceCallId, output: { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null }
    const sourceRows = [{
      sourceSessionId: scope.sessionId, sourceTurnId: scope.turnId, sourceTaskId: scope.taskId,
      sourceRootTaskId: scope.rootTaskId, sourceTurnRootTaskId: scope.rootTaskId,
      sourceParentTaskId: scope.parentTaskId, sourceUserId: scope.userId,
      sourceCallItemId: "source-call-item", sourceCallStepId: "step-1", sourceCallType: "tool_call",
      sourceCallStatus: "completed", sourceCallRevision: 1, sourceCallContent,
      sourceCallAttempt: 1, sourceCallOrdinal: 0,
      sourceResultItemId, sourceResultStepId: "step-1", sourceResultType: "tool_result",
      sourceResultStatus: "completed", sourceResultRevision: 1, sourceResultContent,
      sourceResultAttempt: 1, sourceResultOrdinal: 0,
    }]
    const sourceEvents = [
      { ...events[0], id: "source-start", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
        itemId: "source-call-item", correlationId: sourceCallId,
        payload: { ...events[0].payload, toolCallId: sourceCallId } },
      { ...events[1], id: "source-completed", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
        itemId: "source-call-item", correlationId: sourceCallId,
        payload: { ...events[1].payload, toolCallId: sourceCallId } },
    ]
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT item."id"')) return { rows: currentItems }
      if (sql.includes('SELECT event."id", event."itemId"')) return { rows: currentEvents }
      if (sql.includes('SELECT result."sessionId" AS "sourceSessionId"')) return { rows: sourceRows }
      if (sql.includes('SELECT event."id", session."userId" AS "userId"')) return { rows: sourceEvents }
      throw new Error("unexpected_verification_receipt_query")
    })

    const receipt = await loadTaskGraphVerificationReceipts({ query } as unknown as Pick<pg.PoolClient, "query">, replayScope)
    expect(receipt.replayReceipts).toEqual([{
      currentCallId: replayCallId,
      sourceCallItem: ["source-call-item", 1],
      sourceResultItem: [sourceResultItemId, 1],
    }])
    expect(query).toHaveBeenCalledTimes(4)
    expect(query.mock.calls[2]?.[0]).toContain('result."id" = ANY($7::text[])')
    expect(query.mock.calls[3]?.[0]).toContain('event."itemId" = ANY($4::text[])')
  })
})
