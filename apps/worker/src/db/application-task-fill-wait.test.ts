import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import type { SubagentLease } from "../runtime/subagents/types.js"
import { writeApplicationFillWaitWithClient } from "./application-task-fill-wait.js"

const lease = {
  id: "filler-task", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a",
  role: "application_filler", taskType: "application_fill_for_review", status: "running", attemptCount: 2, maxAttempts: 3,
  leaseOwner: "worker-a", ownerId: "worker-a", leaseExpiresAt: new Date("2026-11-20T12:00:00.000Z"), interruptRequestedAt: null,
  signal: new AbortController().signal, goal: "Fill", path: "/fill", depth: 1, constraints: [], successCriteria: [], allowedActions: [],
  context: {}, expectedOutputSchema: {}, result: null, failureReason: null, budgetSnapshot: {}, toolPolicySnapshot: {},
} satisfies SubagentLease

function client(turnRowCount = 1) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values })
    return { rows: [{ id: "row" }], rowCount: sql.includes('UPDATE "agent_turns"') ? turnRowCount : 1 }
  })
  return { client: { query } as unknown as Pick<PoolClient, "query">, calls }
}

describe("same-transaction application fill wait", () => {
  it("writes only a fixed stale-review wait after the owning completion locks", async () => {
    const db = client()
    await expect(writeApplicationFillWaitWithClient(db.client, {
      lease, applicationTaskId: "application-a", turnRevision: 7, checkpoint: "form_answer_required", detail: "stale_review",
      now: new Date("2026-11-20T11:00:00.000Z"),
    })).resolves.toBe("waiting")
    const taskUpdate = db.calls.find(call => call.sql.includes('UPDATE "application_tasks"'))!
    const event = db.calls.find(call => call.sql.includes('INSERT INTO "application_task_events"'))!
    const transcript = db.calls.find(call => call.sql.includes('INSERT INTO "agent_transcript_events"'))!
    expect(taskUpdate.values[3]).toBe("form_answer_required")
    expect(event.values[2]).toBe("form_answer_required")
    expect(JSON.parse(String(event.values[4]))).toMatchObject({ reason: "stale_review", turnId: "turn-a", attemptCount: 2 })
    expect(String(event.values[3])).toContain("application changed during review")
    expect(JSON.stringify([event.values, transcript.values])).not.toContain("reviewedCoverLetterHash")
    expect(db.calls.find(call => call.sql.includes('UPDATE "agent_turns"'))?.values).toEqual(["turn-a", "session-a", 7, expect.any(Date)])
  })

  it("rolls back through the caller when the locked Turn revision changes", async () => {
    const db = client(0)
    await expect(writeApplicationFillWaitWithClient(db.client, {
      lease, applicationTaskId: "application-a", turnRevision: 7, checkpoint: "form_answer_required", detail: "stale_review",
      now: new Date("2026-11-20T11:00:00.000Z"),
    })).rejects.toThrow("application_fill_wait_turn_conflict")
  })
})
