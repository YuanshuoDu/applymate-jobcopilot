import { describe, expect, it, vi } from "vitest"
import { redactSensitiveText } from "@jobcopilot/shared"
import { buildChildResumeObservationsWithDelegateReceipts } from "./child-resume-delegate-receipts.js"
import { scoutDelegateSpawnKey } from "./scout-delegate-spawn-key.js"
import { spawnKey } from "./pg-store-persistence.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
const CHILD_ID = "subagent-00000000-0000-4000-8000-000000000101"
const OTHER_ID = "subagent-00000000-0000-4000-8000-000000000102"
const PHONE_ID = "00000000-0000-4000-8000-000000000000"

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return { id: "subagent-00000000-0000-4000-8000-000000000001", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
    rootTaskId: "subagent-00000000-0000-4000-8000-000000000002", parentTaskId: "subagent-00000000-0000-4000-8000-000000000002",
    path: "/root/child", depth: 1, role: "scout", taskType: "job_discovery", status: "running", goal: "Find jobs", constraints: [],
    successCriteria: [], allowedActions: ["scout.delegate"], context: {}, expectedOutputSchema: {}, modelProfileSnapshot: {}, result: null,
    failureReason: null, attemptCount: 3, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00Z"),
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal, ...overrides }
}

function delegateItems(child: SubagentLease, attempt: number, toolCallId: string, claimedId = CHILD_ID, extraOutput: Row = {}, errorCode: unknown = null): Row[] {
  const stepId = `step-${attempt}-${toolCallId}`
  const base = { sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId, stepId, attempt, ordinal: 0 }
  return [
    { ...base, id: `call-${toolCallId}`, revision: 0, type: "tool_call", status: "completed",
      content: { toolCallId, toolName: "scout.delegate", input: { goal: "Inspect roles" } } },
    { ...base, id: `result-${toolCallId}`, revision: 1, type: "tool_result", status: "completed",
      content: { toolCallId, output: { taskId: claimedId, status: "queued", ...extraOutput }, errorCode } },
  ]
}

function key(child: SubagentLease, attempt: number, callId: string): string {
  return spawnKey(child.sessionId, scoutDelegateSpawnKey(child.id, attempt, callId))
}

function proofRow(child: SubagentLease, attempt: number, callId: string, overrides: Row = {}): Row {
  return { idempotencyKey: key(child, attempt, callId), spawnId: `spawn-${callId}`, spawnPayload: { taskId: CHILD_ID }, childTaskId: CHILD_ID,
    childSessionId: child.sessionId, childTurnId: child.turnId, childRootTaskId: child.rootTaskId, childParentTaskId: child.id,
    childDepth: 2, childRole: "scout", childTaskType: "job_discovery", sessionUserId: child.userId, turnId: child.turnId,
    turnSessionId: child.sessionId, turnUserId: child.userId, ...overrides }
}

function db(respond: (keys: string[]) => Row[]) {
  const query = vi.fn(async (_sql: string, values: readonly unknown[] = []) => {
    const keys = Array.isArray(values[0]) ? values[0] as string[] : []
    const rows = respond(keys)
    return { rows, rowCount: rows.length }
  })
  return { query }
}

describe("child resume scout delegate receipts", () => {
  it("restores prior and current results from their exact parent-attempt spawn keys", async () => {
    const child = lease(), rows = [...delegateItems(child, 1, "old-call", redactSensitiveText(CHILD_ID)), ...delegateItems(child, 3, "current-call")]
    const database = db(keys => keys.map((_, index) => proofRow(child, index === 0 ? 1 : 3, index === 0 ? "old-call" : "current-call")))
    const restored = await buildChildResumeObservationsWithDelegateReceipts(database as never, rows, child, 0)
    expect(restored.observations.map(block => (block.content as Row).output)).toEqual([
      { taskId: CHILD_ID, status: "queued" }, { taskId: CHILD_ID, status: "queued" },
    ])
    expect(database.query).toHaveBeenCalledTimes(1)
    expect(database.query.mock.calls[0]?.[1]?.[0]).toEqual([key(child, 1, "old-call"), key(child, 3, "current-call")])
  })

  it("rejects missing, duplicate, foreign-owner, malformed and conflicting proofs", async () => {
    const child = lease(), rows = delegateItems(child, 1, "call-1", redactSensitiveText(CHILD_ID))
    const cases: Array<(keys: string[]) => Row[]> = [
      () => [],
      () => [proofRow(child, 1, "call-1"), proofRow(child, 1, "call-1")],
      () => [proofRow(child, 1, "call-1", { sessionUserId: "foreign" })],
      () => [proofRow(child, 1, "call-1", { spawnPayload: { taskId: CHILD_ID, extra: true } })],
      () => [proofRow(child, 1, "call-1", { idempotencyKey: "wrong-key" })],
    ]
    for (const respond of cases) await expect(buildChildResumeObservationsWithDelegateReceipts(db(respond) as never, rows, child))
      .rejects.toThrow("child_resume_delegate_receipt_unavailable")
    await expect(buildChildResumeObservationsWithDelegateReceipts(db(() => [proofRow(child, 1, "call-1")]) as never,
      delegateItems(child, 1, "call-1", OTHER_ID), child)).rejects.toThrow("child_resume_delegate_receipt_unavailable")
    await expect(buildChildResumeObservationsWithDelegateReceipts(db(() => [proofRow(child, 1, "call-1")]) as never,
      delegateItems(child, 1, "call-1", CHILD_ID, { extra: "not closed" }), child)).rejects.toThrow("child_resume_delegate_receipt_unavailable")
  })

  it("keeps failed calls and non-delegate output on the generic redaction path", async () => {
    const child = lease(), failed = delegateItems(child, 1, "failed-call", PHONE_ID, {}, "delegate_failed")
    const database = db(() => { throw new Error("unexpected proof query") })
    const restored = await buildChildResumeObservationsWithDelegateReceipts(database as never, failed, child)
    expect(database.query).not.toHaveBeenCalled()
    expect((restored.observations[0]?.content as Row).output).toEqual({ taskId: "[REDACTED_PHONE]", status: "queued" })
  })
})
