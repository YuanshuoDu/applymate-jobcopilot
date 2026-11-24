import { describe, expect, it, vi } from "vitest"

import { createApplicationSubmitRepository, type SubmissionAttempt } from "./application-submit-repo.js"
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js"

const identity: ApplicationSubmitIdentity = { sessionId: "session-a", fillTurnId: "turn-a", applicationTaskId: "application-a", userId: "user-a", jobId: "job-a", approvalId: "receipt-a", constraintHash: "c".repeat(64) }
const savedAttempt: SubmissionAttempt = { id: "attempt-a", userId: identity.userId, jobId: identity.jobId, receiptId: identity.approvalId, constraintHash: identity.constraintHash, artifactHash: "a".repeat(64), state: "reserved", responseRef: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() }
const objectiveSource = { reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:2`, reviewTurnId: "review-turn-a", materialProofHash: "b".repeat(64) } }
const objectiveMaterial = { reviewedResumeContent: { basics: { name: "Candidate" } }, reviewedCoverLetter: "Approved letter",
  confirmedAnswers: { city: "Dublin" }, approvedApplyUrl: "https://boards.greenhouse.io/acme/jobs/123" }

function fixture(options: { fillTurnId?: string; attempt?: SubmissionAttempt | null; turnInputs?: unknown[]; missingInputRows?: boolean; objectiveEvidence?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const audit: unknown[][] = []
  let attempt = options.attempt ?? null
  let inputRead = 0
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: identity.sessionId }], rowCount: 1 }
      if (sql.startsWith('SELECT "input" FROM "agent_turns"')) {
        const index = inputRead++
        return options.missingInputRows ? { rows: [], rowCount: 0 }
          : { rows: [{ input: options.turnInputs?.[index] ?? {} }], rowCount: 1 }
      }
      if (sql.includes('FROM "application_task_events" AS event') && sql.includes('JOIN "application_tasks" AS task')) {
        return { rows: options.objectiveEvidence ? [{ id: "objective-manifest" }] : [], rowCount: options.objectiveEvidence ? 1 : 0 }
      }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: identity.fillTurnId }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "filler-a" }], rowCount: 1 }
      if (sql.includes('INSERT INTO "application_task_events"')) { audit.push(values ?? []); return { rows: [], rowCount: 1 } }
      if (sql.includes('FROM "application_tasks"')) return { rows: [{ sessionId: identity.sessionId, fillTurnId: options.fillTurnId ?? identity.fillTurnId, fillTurnSessionId: options.fillTurnId === undefined ? identity.sessionId : "session-a", fillTurnUserId: identity.userId }], rowCount: 1 }
      if (sql.includes('FROM "Job"')) return { rows: [{ id: identity.jobId }], rowCount: 1 }
      if (sql === "SELECT set_config($1, $2, true)" || ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 1 }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ transaction_id: "4" }], rowCount: 1 }
      if (sql === "SELECT pg_current_xact_id()::text AS transaction_id") return { rows: [{ transaction_id: "4" }], rowCount: 1 }
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

  it("takes the shared source fence before row locks for a marked Turn and passes the selection to authorization", async () => {
    const marker = { reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn" } }
    const test = fixture({ turnInputs: [marker, marker] })
    const authorize = vi.fn(async () => ({ kind: "authorized" as const, artifactHash: savedAttempt.artifactHash }))
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toMatchObject({ kind: "reserved" })
    const fenceIndex = test.calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock"))
    const sessionLockIndex = test.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"') && call.sql.includes("FOR UPDATE"))
    expect(fenceIndex).toBeGreaterThan(-1)
    expect(fenceIndex).toBeLessThan(sessionLockIndex)
    expect(authorize).toHaveBeenCalledWith(test.client, "new", { kind: "selected", sourceTurnId: "source-turn" })
  })

  it("reads and binds the Objective marker under the source fence and returns only a reserved transient packet", async () => {
    const test = fixture({ turnInputs: [objectiveSource, objectiveSource] })
    const authorize = vi.fn(async (_client, _mode, source) => source.kind === "objective"
      ? { kind: "authorized" as const, artifactHash: savedAttempt.artifactHash, objectiveMaterial }
      : { kind: "fenced" as const })
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toMatchObject({
      kind: "reserved", objectiveMaterial, artifactHash: savedAttempt.artifactHash,
    })
    const fence = test.calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock"))
    const firstRowLock = test.calls.findIndex(call => call.sql.includes("FOR UPDATE"))
    expect(fence).toBeGreaterThan(-1)
    expect(fence).toBeLessThan(firstRowLock)
    expect(authorize).toHaveBeenCalledWith(test.client, "new", expect.objectContaining({ kind: "objective", source: objectiveSource.reviewedApplicationMaterialSource }))
  })

  it("rejects a changed Objective proof marker between the initial hint and locked reread", async () => {
    const changed = { reviewedApplicationMaterialSource: { ...objectiveSource.reviewedApplicationMaterialSource,
      materialProofHash: "d".repeat(64) } }
    const test = fixture({ turnInputs: [objectiveSource, changed] }), authorize = vi.fn()
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toEqual({ kind: "fenced" })
    expect(authorize).not.toHaveBeenCalled()
  })

  it("rejects a changed Objective selector schema between the initial hint and locked reread", async () => {
    const changed = { reviewedApplicationMaterialSource: { ...objectiveSource.reviewedApplicationMaterialSource,
      schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v2" } }
    const test = fixture({ turnInputs: [objectiveSource, changed] }), authorize = vi.fn()
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toEqual({ kind: "fenced" })
    expect(authorize).not.toHaveBeenCalled()
  })

  it("does not downgrade a stripped Objective selector when the current task has a V3 manifest signal", async () => {
    const test = fixture({ turnInputs: [{}, {}], objectiveEvidence: true }), authorize = vi.fn()
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toEqual({ kind: "fenced" })
    expect(authorize).not.toHaveBeenCalled()
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "submission_attempt"'))).toBe(false)
  })

  it("returns an exact Objective terminal replay after checking the durable receipt, without rereading material", async () => {
    const existing = { ...savedAttempt, state: "submitted" as const, responseRef: "confirmed" }
    const test = fixture({ attempt: existing, turnInputs: [objectiveSource, objectiveSource] })
    const authorize = vi.fn(async () => ({ kind: "authorized" as const, artifactHash: existing.artifactHash }))
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toEqual({ kind: "replay", attempt: existing, artifactHash: existing.artifactHash })
    expect(authorize).toHaveBeenCalledWith(test.client, "replay", expect.objectContaining({ kind: "objective" }))
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "submission_attempt"'))).toBe(false)
  })

  it("keeps a stripped-selector Objective replay read-only after the exact receipt check", async () => {
    const existing = { ...savedAttempt, state: "submitted" as const, responseRef: "confirmed" }
    const test = fixture({ attempt: existing, turnInputs: [{}, {}], objectiveEvidence: true })
    const authorize = vi.fn(async () => ({ kind: "authorized" as const, artifactHash: existing.artifactHash }))
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toEqual({ kind: "replay", attempt: existing, artifactHash: existing.artifactHash })
    expect(authorize).toHaveBeenCalledWith(test.client, "replay", { kind: "absent" })
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "submission_attempt"'))).toBe(false)
  })

  it("does not authorize a changed selector or a selector whose exact owner row is missing", async () => {
    const first = { reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-a" } }
    const second = { reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-b" } }
    const changed = fixture({ turnInputs: [first, second] }), authorize = vi.fn()
    await expect(changed.repository.reserveAndConsume(identity, authorize)).resolves.toEqual({ kind: "fenced" })
    expect(authorize).not.toHaveBeenCalled()
    const missing = fixture({ missingInputRows: true })
    await expect(missing.repository.reserveAndConsume(identity, authorize)).resolves.toEqual({ kind: "fenced" })
    expect(authorize).not.toHaveBeenCalled()
  })

  it("replays a matching receipt only after inspecting its approval in the same fenced transaction", async () => {
    const existing = { ...savedAttempt, state: "submitted" as const, responseRef: "confirmation-1" }
    const test = fixture({ attempt: existing })
    const authorize = vi.fn(async () => ({ kind: "authorized" as const, artifactHash: existing.artifactHash }))
    await expect(test.repository.reserveAndConsume(identity, authorize)).resolves.toMatchObject({ kind: "replay", attempt: existing })
    expect(authorize).toHaveBeenCalledWith(test.client, "replay", { kind: "absent" })
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
