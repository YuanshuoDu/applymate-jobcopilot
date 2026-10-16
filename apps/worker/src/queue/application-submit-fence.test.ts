import { describe, expect, it, vi } from "vitest"
import type { Pool, PoolClient } from "pg"

import { appendFencedSubmitAudit, lockApplicationSubmitFence, recordSubmissionExecutionSettled, type ApplicationSubmitIdentity } from "./application-submit-fence.js"

const identity: ApplicationSubmitIdentity = { sessionId: "session-a", fillTurnId: "turn-a", applicationTaskId: "application-a", userId: "user-a", jobId: "job-a", approvalId: "receipt-a", constraintHash: "c".repeat(64) }
function client(fillTurnId = identity.fillTurnId, filler: "ready" | "active" | "missing" | "ambiguous" = "ready", jobExists = true) {
  const calls: string[] = []
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    calls.push(sql)
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: identity.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: identity.fillTurnId }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: filler === "ready" ? [{ id: "filler-a" }] : filler === "ambiguous" ? [{ id: "filler-a" }, { id: "filler-b" }] : [], rowCount: filler === "ready" ? 1 : filler === "ambiguous" ? 2 : 0 }
    if (sql.includes('FROM "application_tasks"')) return { rows: [{ sessionId: identity.sessionId, fillTurnId, fillTurnSessionId: identity.sessionId, fillTurnUserId: identity.userId }], rowCount: 1 }
    if (sql.includes('FROM "Job"')) return { rows: jobExists ? [{ id: identity.jobId }] : [], rowCount: jobExists ? 1 : 0 }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as unknown as PoolClient, calls, query }
}

describe("application submit fence", () => {
  it("locks session, exact Turn, canonical filler, application task, then exact owned Job", async () => {
    const test = client()
    await expect(lockApplicationSubmitFence(test.client, identity)).resolves.toBe("current")
    expect(test.calls.map(sql => sql.match(/FROM "[^"]+"/)?.[0])).toEqual(['FROM "agent_sessions"', 'FROM "agent_turns"', 'FROM "sub_agent_tasks"', 'FROM "application_tasks"', 'FROM "Job"'])
    expect(test.calls.every(sql => sql.includes("FOR UPDATE"))).toBe(true)
  })

  it("fails closed when the exact Job is missing or belongs to another user", async () => {
    const test = client(identity.fillTurnId, "ready", false)
    await expect(lockApplicationSubmitFence(test.client, identity)).rejects.toMatchObject({ code: "submission_scope_mismatch" })
    expect(test.calls.at(-1)).toContain('FROM "Job"')
  })

  it("marks an old Turn superseded after its task binds a successor", async () => {
    const test = client("successor-turn")
    await expect(lockApplicationSubmitFence(test.client, identity)).resolves.toBe("superseded")
  })

  it("rejects incomplete immutable identity before any query", async () => {
    const test = client()
    await expect(lockApplicationSubmitFence(test.client, { ...identity, constraintHash: "wrong" })).rejects.toMatchObject({ code: "submission_scope_mismatch" })
    expect(test.query).not.toHaveBeenCalled()
  })

  it.each(["active", "missing", "ambiguous"] as const)("fails closed for a %s exact filler lease", async filler => {
    const test = client(identity.fillTurnId, filler)
    await expect(lockApplicationSubmitFence(test.client, identity)).rejects.toMatchObject({ code: "submission_scope_mismatch" })
    expect(test.calls.at(-1)).toContain('FROM "sub_agent_tasks"')
    expect(test.calls.at(-1)).toContain('"status" = \'completed\'')
    expect(test.calls.at(-1)).toContain('"interruptRequestedAt" IS NULL')
    expect(test.calls.some(sql => sql.includes('FROM "application_tasks"'))).toBe(false)
  })

  it("appends a task event with the old attempt identity without changing task or job state", async () => {
    const test = client("successor-turn")
    await appendFencedSubmitAudit(test.client, identity, "success")
    const audit = test.query.mock.calls[0]
    expect(audit?.[0]).toContain('INSERT INTO "application_task_events"')
    expect(audit?.[0]).not.toContain("UPDATE")
    expect(String(audit?.[1]?.[2])).toContain(identity.applicationTaskId)
    expect(String(audit?.[1]?.[2])).toContain(identity.fillTurnId)
    expect(String(audit?.[1]?.[2])).toContain(identity.approvalId)
  })

  it("writes settled proof only for the execution id that owns the unique start event", async () => {
    const test = client()
    const transactionCalls: string[] = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      transactionCalls.push(sql)
      if (sql.includes("submission_execution_settled")) {
        expect(sql).toContain("(SELECT COUNT(*) FROM starts) = 1")
        expect(sql).toContain("data\"->>'executionId' = $3")
        expect(sql).toContain("NOT EXISTS")
        return { rows: [], rowCount: values?.[2] === "execution-a" ? 1 : 0 }
      }
      return test.query(sql, values)
    })
    const release = vi.fn()
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool
    const scope = { ...identity, workerTaskId: "bull-a", executionId: "execution-a" }

    await expect(recordSubmissionExecutionSettled(pool, scope)).resolves.toBe(true)
    await expect(recordSubmissionExecutionSettled(pool, { ...scope, executionId: "execution-redelivery" })).resolves.toBe(false)
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("submission_execution_settled"))).toHaveLength(2)
    expect(transactionCalls.filter(sql => sql === "COMMIT")).toHaveLength(2)
    expect(release).toHaveBeenCalledTimes(2)
  })
})
