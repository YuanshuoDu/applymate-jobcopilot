import { describe, expect, it, vi } from "vitest"

import { createApplicationSubmitRepository, type SubmissionAttempt } from "./application-submit-repo.js"
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js"

const identity: ApplicationSubmitIdentity = { sessionId: "session-a", fillTurnId: "turn-a", applicationTaskId: "application-a", userId: "user-a", jobId: "job-a", approvalId: "receipt-a", constraintHash: "c".repeat(64) }
const savedAttempt: SubmissionAttempt = { id: "attempt-a", userId: identity.userId, jobId: identity.jobId, receiptId: identity.approvalId, constraintHash: identity.constraintHash, artifactHash: "a".repeat(64), state: "reserved", responseRef: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() }

function fixture(options: { fillTurnId?: string; attempt?: SubmissionAttempt | null } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const audit: unknown[][] = []
  let attempt = options.attempt ?? null
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: identity.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: identity.fillTurnId }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "filler-a" }], rowCount: 1 }
      if (sql.includes('INSERT INTO "application_task_events"')) { audit.push(values ?? []); return { rows: [], rowCount: 1 } }
      if (sql.includes('FROM "application_tasks"')) return { rows: [{ sessionId: identity.sessionId, fillTurnId: options.fillTurnId ?? identity.fillTurnId, fillTurnSessionId: options.fillTurnId === undefined ? identity.sessionId : "session-a", fillTurnUserId: identity.userId }], rowCount: 1 }
      if (sql.includes('FROM "Job"')) return { rows: [{ id: identity.jobId }], rowCount: 1 }
      if (sql === "SELECT set_config($1, $2, true)" || ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "submission_attempt"')) return { rows: attempt ? [attempt] : [], rowCount: attempt ? 1 : 0 }
      if (sql.includes('INSERT INTO "submission_attempt"')) {
        attempt = { ...savedAttempt, id: String(values?.[0]), artifactHash: String(values?.[5]) }
        return { rows: [attempt], rowCount: 1 }
      }
      if (sql.includes('UPDATE "submission_attempt"')) {
        if (!attempt || attempt.state !== "reserved") return { rows: [], rowCount: 0 }
        attempt = sql.includes("'submitted'") ? { ...attempt, state: "submitted", responseRef: String(values?.[0]) } : { ...attempt, state: "failed", errorCode: String(values?.[0]) }
        return { rows: [attempt], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [{ id: identity.jobId, userId: identity.userId, company: "Acme", role: "Engineer", url: "https://jobs.example/apply", source: "greenhouse" }], rowCount: 1 })) }
  return { repository: createApplicationSubmitRepository(pool as never), pool, client, calls, audit, getAttempt: () => attempt }
}

describe("application submit pg repository", () => {
  it("looks up a target with tenant and server-owned URL predicates", async () => {
    const test = fixture()
    await expect(test.repository.findTarget(identity.userId, identity.jobId)).resolves.toMatchObject({ jobId: identity.jobId, applyUrl: "https://jobs.example/apply" })
    expect(test.pool.query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $2 AND "url" IS NOT NULL'), [identity.jobId, identity.userId])
  })

  it("locks session, Turn, filler, application task, and Job before consuming the exact approval and reserving", async () => {
    const test = fixture()
    const authorize = vi.fn(async () => ({ kind: "authorized" as const, artifactHash: savedAttempt.artifactHash }))
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toMatchObject({ kind: "reserved", attempt: { receiptId: identity.approvalId } })
    const locks = test.calls.filter(call => call.sql.includes("FOR UPDATE")).map(call => call.sql)
    expect(locks.findIndex(sql => sql.includes('FROM "agent_sessions"'))).toBeLessThan(locks.findIndex(sql => sql.includes('FROM "agent_turns"')))
    expect(locks.findIndex(sql => sql.includes('FROM "agent_turns"'))).toBeLessThan(locks.findIndex(sql => sql.includes('FROM "sub_agent_tasks"')))
    expect(locks.findIndex(sql => sql.includes('FROM "sub_agent_tasks"'))).toBeLessThan(locks.findIndex(sql => sql.includes('FROM "application_tasks"')))
    expect(locks.findIndex(sql => sql.includes('FROM "application_tasks"'))).toBeLessThan(locks.findIndex(sql => sql.includes('FROM "Job"')))
    expect(authorize).toHaveBeenCalledOnce()
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "submission_attempt"'))).toBe(true)
    expect(test.calls.map(call => call.sql)).toContain("COMMIT")
  })

  it("replays a matching receipt only after inspecting its approval in the same fenced transaction", async () => {
    const existing = { ...savedAttempt, state: "submitted" as const, responseRef: "confirmation-1" }
    const test = fixture({ attempt: existing })
    const authorize = vi.fn(async () => ({ kind: "authorized" as const, artifactHash: existing.artifactHash }))
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toMatchObject({ kind: "replay", attempt: existing })
    expect(authorize).toHaveBeenCalledWith(test.client, "replay")
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "submission_attempt"'))).toBe(false)
  })

  it("makes the old claim audit-only once a successor fill Turn is bound", async () => {
    const test = fixture({ fillTurnId: "successor-turn" })
    const authorize = vi.fn()
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toEqual({ kind: "fenced" })
    expect(authorize).not.toHaveBeenCalled()
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "submission_attempt"'))).toBe(false)
    expect(test.audit).toHaveLength(1)
    expect(test.calls.map(call => call.sql)).toContain("COMMIT")
  })

  it("does not persist late success or failure callbacks after the successor binding", async () => {
    const test = fixture({ fillTurnId: "successor-turn", attempt: savedAttempt })
    await expect(test.repository.markSubmitted(identity, "late-confirmation")).resolves.toEqual({ kind: "fenced" })
    await expect(test.repository.markFailed(identity, "late-failure")).resolves.toEqual({ kind: "fenced" })
    expect(test.getAttempt()).toMatchObject({ state: "reserved", responseRef: null, errorCode: null })
    expect(test.audit).toHaveLength(2)
    expect(test.calls.some(call => call.sql.includes('UPDATE "submission_attempt"'))).toBe(false)
  })

  it("updates only the currently bound exact approval attempt", async () => {
    const test = fixture({ attempt: savedAttempt })
    await expect(test.repository.markSubmitted(identity, "confirmation-1")).resolves.toMatchObject({ kind: "updated", attempt: { state: "submitted", responseRef: "confirmation-1" } })
    const update = test.calls.find(call => call.sql.includes('UPDATE "submission_attempt"'))
    expect(update?.sql).toContain('"userId" = $2 AND "jobId" = $3 AND "receiptId" = $4 AND "constraintHash" = $5')
    expect(update?.values).toEqual(["confirmation-1", identity.userId, identity.jobId, identity.approvalId, identity.constraintHash])
  })
})
