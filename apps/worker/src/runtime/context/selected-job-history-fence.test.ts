import type pg from "pg"
import { describe, expect, it } from "vitest"
import { readSelectedJobHistoryFence, type SelectedJobHistoryFenceInput } from "./selected-job-history-fence.js"

type Options = Readonly<{ currentJobId?: string; stepAttempt?: number; startSequences?: readonly string[] }>

function fixture(options: Options = {}) {
  const queries: string[] = []
  const client = {
    async query(sql: string) {
      queries.push(sql)
      if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-current" }] }
      if (sql.includes("FOR UPDATE OF task")) return { rows: [{
        id: "root-current", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current", parentTaskId: null,
        role: "orchestrator", taskType: "root", status: "running", leaseOwner: "worker", attemptCount: 2,
        interruptRequestedAt: null,
      }] }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-current" }] }
      if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
      if (sql.includes('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"')) return { rows: [{
        id: "step-current", sessionId: "session-1", turnId: "turn-current", taskId: "root-current",
        attempt: options.stepAttempt ?? 1, status: "streaming",
      }] }
      if (sql.includes('SELECT "id", "sessionId", "userId", "rootTaskId", "status", "input"')) return { rows: [{
        id: "turn-current", sessionId: "session-1", userId: "user-1", rootTaskId: "root-current", status: "in_progress",
        input: { selectedJobPreparation: { jobId: options.currentJobId ?? "job-1" } },
      }] }
      if (sql.includes("event.\"type\" = 'turn.started'")) {
        return { rows: (options.startSequences ?? ["20"]).map(sequence => ({ sequence })) }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  const input: SelectedJobHistoryFenceInput = {
    lease: { turnId: "turn-current", sessionId: "session-1", ownerId: "worker", userId: "user-1", leaseVersion: 3,
      leaseStartedAt: new Date(1), leaseExpiresAt: new Date(10_000) },
    rootTaskId: "root-current", rootAttemptCount: 2, stepId: "step-current", jobId: "job-1", now: new Date(2_000),
  }
  return { client: client as unknown as pg.PoolClient, input, queries }
}

describe("selected-job history current fence", () => {
  it("retains the live Root attempt fence, canonical Step attempt 1, server job selection, and durable start sequence", async () => {
    const test = fixture()

    await expect(readSelectedJobHistoryFence(test.client, test.input)).resolves.toEqual({ currentStartSequence: 20n })
    const index = (part: string) => test.queries.findIndex(sql => sql.includes(part))
    expect(index('SELECT "id" FROM "agent_sessions"')).toBeLessThan(index('SELECT "id" FROM "agent_turns"'))
    expect(index('SELECT "id" FROM "agent_turns"')).toBeLessThan(index("FOR UPDATE OF task"))
    expect(index("FOR UPDATE OF task")).toBeLessThan(index('SELECT "id" FROM "agent_steps"'))
    expect(index('SELECT "id" FROM "agent_steps"')).toBeLessThan(index('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"'))
    expect(index('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"')).toBeLessThan(index('SELECT "id", "sessionId", "userId", "rootTaskId", "status", "input"'))
    expect(test.queries[test.queries.length - 1]).toContain("turn.started")
  })

  it("skips start-event lookup when the locked server selection changed or the owned start is absent or ambiguous", async () => {
    const otherJob = fixture({ currentJobId: "job-2" })
    await expect(readSelectedJobHistoryFence(otherJob.client, otherJob.input)).resolves.toBeUndefined()
    expect(otherJob.queries.some(sql => sql.includes("turn.started"))).toBe(false)

    for (const startSequences of [[], ["20", "21"]]) {
      const missing = fixture({ startSequences })
      await expect(readSelectedJobHistoryFence(missing.client, missing.input)).resolves.toBeUndefined()
    }
  })

  it("rejects a Root Step other than the current streaming attempt 1", async () => {
    const test = fixture({ stepAttempt: 2 })

    await expect(readSelectedJobHistoryFence(test.client, test.input)).rejects.toThrow("selected_job_history_current_step_fenced")
    expect(test.queries.some(sql => sql.includes('SELECT "id", "sessionId", "userId", "rootTaskId", "status", "input"'))).toBe(false)
  })
})
