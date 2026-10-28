import { describe, expect, it } from "vitest"

import { loadChildConsumedWaitResume } from "./child-resume-consumed-wait.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
const now = new Date("2026-10-22T10:00:00.000Z")
const phoneId = "subagent-00000000-0000-4000-8000-000000000001"
const child = { id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/parent-1", depth: 1, role: "scout", taskType: "research", status: "running", goal: "", constraints: [], successCriteria: [],
  allowedActions: ["wait_subagents"], context: {}, expectedOutputSchema: {}, modelProfileSnapshot: {}, result: null, failureReason: null,
  attemptCount: 1, maxAttempts: 1, leaseOwner: "worker-1", leaseExpiresAt: new Date(now.getTime() + 60_000), interruptRequestedAt: null,
  budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal } as SubagentLease

function fixture(options: { ids?: string[]; targetIds?: unknown; inputIds?: unknown; requestIds?: unknown; outcomeIds?: unknown;
  outcomeTaskId?: unknown; outcomeTaskIds?: string[]; receiptIds?: unknown; receiptWaitId?: unknown; receiptTaskIds?: unknown; targetParentId?: string;
  mode?: unknown; inputMode?: unknown; requestMode?: unknown; status?: unknown; outcomeStatus?: unknown;
  matchedIds?: unknown; outcomeMatchedIds?: unknown; taskStatuses?: unknown[]; inputTimeoutMs?: unknown; requestTimeoutMs?: unknown;
  deadlineAt?: string; missingReceipt?: boolean; note?: string } = {}) {
  const ids = options.ids ?? [phoneId], targetIds = options.targetIds ?? ids
  const deadlineAt = options.deadlineAt ?? "2026-10-22T10:05:00.000Z"
  const mode = options.mode ?? "any", status = options.status ?? "ready", matchedIds = options.matchedIds ?? [ids[0]]
  const taskStatuses = options.taskStatuses ?? ids.map((_, index) => index === 0 ? "completed" : "running")
  const outcomeTaskIds = options.outcomeTaskIds ?? ids
  const outcomeTasks = outcomeTaskIds.map((taskId, index) => ({ taskId: index === 0 ? options.outcomeTaskId ?? taskId : taskId,
    status: taskStatuses[ids.indexOf(taskId)], role: "writer", result: { answer: 42, ...(taskId === ids[0] && options.note ? { note: options.note } : {}) }, failureReason: null }))
  const outcome = { waitId: "wait-1", status: options.outcomeStatus ?? status, taskIds: options.outcomeIds ?? ids, deadlineAt,
    matchedTaskIds: options.outcomeMatchedIds ?? matchedIds, tasks: outcomeTasks }
  const input = { idempotencyKey: "wait-key", taskIds: options.inputIds ?? ids, mode: options.inputMode ?? mode, timeoutMs: options.inputTimeoutMs ?? 5_000 }
  const row: Row = {
    waitId: "wait-1", stepId: "step-1", targetTaskIds: targetIds, idempotencyKey: "wait-key", mode, status, deadlineAt,
    matchedTaskIds: matchedIds, waitResult: { request: { targetTaskIds: options.requestIds ?? ids, mode: options.requestMode ?? mode,
      timeoutMs: options.requestTimeoutMs ?? 5_000 }, outcome },
    attempt: 1, ordinal: 0, continuationStepId: "step-2", continuationOrdinal: 1, continuationLatestOrdinal: 1,
    callContent: { toolCallId: "call-1", toolName: "wait_subagents", input }, callStatus: options.missingReceipt ? "started" : "completed",
    sourceItemId: options.missingReceipt ? null : "item-result-1", resultContent: options.missingReceipt ? null : {
      toolCallId: "call-1", output: { waitId: options.receiptWaitId ?? "wait-1", status: "waiting", taskIds: options.receiptIds ?? ids,
        deadlineAt, matchedTaskIds: [], tasks: options.receiptTaskIds ?? [] }, errorCode: null,
    }, resultStatus: options.missingReceipt ? null : "completed",
  }
  const targets = ids.map((id, index) => ({ id, parentTaskId: index === 0 ? options.targetParentId ?? child.id : child.id,
    rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }))
  const client = { async query(sql: string) {
    if (sql.includes("WITH latest_wait AS")) return { rows: [row], rowCount: 1 }
    if (sql.includes('task."id" = ANY($1::text[])')) return { rows: targets, rowCount: targets.length }
    throw new Error(`unexpected query: ${sql}`)
  } }
  return { client, row }
}

describe("consumed child wait resume", () => {
  it("preserves validated phone-shaped IDs through the consumed loader and keeps free text redacted", async () => {
    const fake = fixture({ note: "Contact +353 87 123 4567" })
    const resumed = await loadChildConsumedWaitResume(fake.client as never, child)

    expect(resumed).toMatchObject({ input: { taskIds: [phoneId] }, output: { taskIds: [phoneId], tasks: [{ taskId: phoneId }] } })
    expect(JSON.stringify(resumed)).toContain(phoneId)
    expect(JSON.stringify(resumed)).not.toContain("+353 87 123 4567")
  })

  it("preserves allowed input and receipt reordering without changing canonical output order", async () => {
    const ids = [phoneId, "child-2"]
    const fake = fixture({ ids, inputIds: ["child-2", phoneId], requestIds: ["child-2", phoneId], receiptIds: ["child-2", phoneId],
      outcomeIds: ["child-2", phoneId], outcomeTaskIds: ["child-2", phoneId] })
    const resumed = await loadChildConsumedWaitResume(fake.client as never, child)

    expect(resumed?.input).toMatchObject({ taskIds: ["child-2", phoneId] })
    expect(resumed?.output).toMatchObject({ taskIds: ids, tasks: [{ taskId: phoneId }, { taskId: "child-2" }] })
  })

  it("recovers an exact consumed wait when its receipt is missing", async () => {
    const fake = fixture({ missingReceipt: true })
    await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({
      sourceItemId: "recovered-wait-result:wait-1", input: { taskIds: [phoneId] }, output: { taskIds: [phoneId] },
    })
  })

  it("accepts any-ready with a terminal match while another target is still running", async () => {
    const ids = [phoneId, "child-2"]
    const fake = fixture({ ids, mode: "any", matchedIds: [phoneId], taskStatuses: ["completed", "running"] })
    await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({
      output: { status: "ready", matchedTaskIds: [phoneId], tasks: [{ taskId: phoneId }, { taskId: "child-2" }] },
    })
  })

  it("accepts all-ready when failed and cancelled targets are terminal", async () => {
    const ids = [phoneId, "child-2"]
    const fake = fixture({ ids, mode: "all", matchedIds: ids, taskStatuses: ["failed", "cancelled"] })
    await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({
      output: { status: "ready", matchedTaskIds: ids },
    })
  })

  it("accepts timed-out waits with empty, partial, or full terminal matches", async () => {
    const cases = [
      { ids: [phoneId, "child-2"], mode: "any", matchedIds: [], taskStatuses: ["running", "queued"] },
      { ids: [phoneId, "child-2", "child-3"], mode: "all", matchedIds: [phoneId, "child-3"], taskStatuses: ["failed", "running", "cancelled"] },
      { ids: [phoneId, "child-2"], mode: "all", matchedIds: [phoneId, "child-2"], taskStatuses: ["completed", "failed"] },
    ]
    for (const value of cases) {
      const fake = fixture({ ...value, status: "timed_out", deadlineAt: "2000-01-01T00:00:00.000Z" })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({ output: { status: "timed_out" } })
    }
  })

  it("rejects inconsistent readiness, mode, timeout, and premature timeout snapshots", async () => {
    const anyRunning = fixture({ taskStatuses: ["running"] })
    await expect(loadChildConsumedWaitResume(anyRunning.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    const allPartial = fixture({ ids: [phoneId, "child-2"], mode: "all", matchedIds: [phoneId], taskStatuses: ["completed", "running"] })
    await expect(loadChildConsumedWaitResume(allPartial.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    const invalidMode = fixture({ mode: "either", inputMode: "either", requestMode: "either" })
    await expect(loadChildConsumedWaitResume(invalidMode.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    for (const timeout of [0, 30_001, 1.5]) {
      const invalidTimeout = fixture({ inputTimeoutMs: timeout, requestTimeoutMs: timeout })
      await expect(loadChildConsumedWaitResume(invalidTimeout.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    }
    const mismatchedTimeout = fixture({ requestTimeoutMs: 4_000 })
    await expect(loadChildConsumedWaitResume(mismatchedTimeout.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const prematureTimeout = fixture({ status: "timed_out", matchedIds: [], taskStatuses: ["running"], deadlineAt: "2099-10-22T10:05:00.000Z" })
    await expect(loadChildConsumedWaitResume(prematureTimeout.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
  })

  it("rejects malformed, duplicated, foreign, and misbound target IDs", async () => {
    for (const targetIds of [[], [phoneId, phoneId], [phoneId, 9], ["foreign-child"], JSON.stringify([phoneId])]) {
      const fake = fixture({ targetIds })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_wait_lineage")
    }
    for (const inputIds of [[], [phoneId, phoneId], [phoneId, false], ["foreign-child"]]) {
      const fake = fixture({ inputIds })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    }
    for (const outcomeIds of [[], [phoneId, phoneId], [phoneId, null], ["foreign-child"]]) {
      const fake = fixture({ outcomeIds })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    }
    const forgedTask = fixture({ outcomeTaskId: "foreign-child" })
    await expect(loadChildConsumedWaitResume(forgedTask.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    const misbound = fixture({ targetParentId: "other-parent" })
    await expect(loadChildConsumedWaitResume(misbound.client as never, child)).rejects.toThrow("child_resume_wait_lineage")
  })

  it("rejects malformed or foreign IDs in an existing receipt while allowing the empty tasks projection", async () => {
    for (const receiptIds of [[], [phoneId, phoneId], [phoneId, "foreign-child"], [phoneId, 1]]) {
      const fake = fixture({ receiptIds })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    }
    const foreignReceipt = fixture({ receiptWaitId: "wait-other" })
    await expect(loadChildConsumedWaitResume(foreignReceipt.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const forgedReceiptTask = fixture({ receiptTaskIds: [{ taskId: "foreign-child" }] })
    await expect(loadChildConsumedWaitResume(forgedReceiptTask.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const partialReceiptTasks = fixture({ ids: [phoneId, "child-2"], receiptTaskIds: [{ taskId: phoneId }] })
    await expect(loadChildConsumedWaitResume(partialReceiptTasks.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })
})
