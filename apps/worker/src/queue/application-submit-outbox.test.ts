import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Pool } from "pg"
import { drainApplicationSubmitOutbox, APPLICATION_SUBMIT_OUTBOX_TOPIC } from "./application-submit-outbox.js"
import type { ApplyTaskSubmitPayload } from "@jobcopilot/shared"

const mockReconcileClaimedSubmissionUncertain = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock("../db/submission-guard.js", () => ({ reconcileClaimedSubmissionUncertain: mockReconcileClaimedSubmissionUncertain }))

const identity = {
  applicationTaskId: "application-1", userId: "user-1", jobId: "job-1", sessionId: "session-1",
  fillTurnId: "turn-1", receiptId: "approval-1", constraintHash: "a".repeat(64),
}
const digest = createHash("sha256").update(JSON.stringify([identity.applicationTaskId, identity.fillTurnId, identity.receiptId])).digest("hex")
const workerTaskId = `apply-submit-${digest}`
const payload: ApplyTaskSubmitPayload = {
  ...identity, operation: "submit", applyUrl: "https://jobs.example/apply", personaId: "server-side", resumePath: "",
}
const intent = { ...identity, workerTaskId, submitPayload: payload }
const topic = APPLICATION_SUBMIT_OUTBOX_TOPIC
const makeOutbox = () => ({
  id: `application-submit-outbox-${digest}`, topic, aggregateId: identity.sessionId,
  idempotencyKey: `application-submit:${digest}`, payload: intent,
  attemptCount: 0, publishedAt: null as Date | null, lastError: null as string | null,
})
type FixtureOptions = { turnId?: string; checkpoint?: string; taskStatus?: string; jobWorkflow?: string; failAckOnce?: boolean; jobState?: string; paused?: boolean; lock?: string | null; approvalExpired?: boolean; approvalProblem?: "missing" | "revoked" | "mismatched"; accountStatus?: string; terminalOnRollback?: boolean; attemptsMade?: number; attempts?: number }

function makeFixture(options: FixtureOptions = {}) {
  const state = {
    outbox: makeOutbox(),
    task: { status: options.taskStatus ?? "filling", checkpoint: options.checkpoint ?? "submission_authorized",
      workerTaskId, sessionId: identity.sessionId, fillTurnId: options.turnId ?? identity.fillTurnId },
    job: { status: "saved", workflowState: options.jobWorkflow ?? "queued" },
  }
  let transactionSnapshot: typeof state | null = null
  let failAckOnce = options.failAckOnce ?? false
  let jobState = options.jobState ?? "waiting"
  const jobs = new Map<string, { id: string; data: ApplyTaskSubmitPayload; attemptsMade: number; opts: { attempts: number }; getState: () => Promise<string>; retry: (state: string, opts: unknown) => Promise<void> }>()
  const makeJob = (id: string, data: ApplyTaskSubmitPayload) => ({ id, data,
    attemptsMade: options.attemptsMade ?? 3, opts: { attempts: options.attempts ?? 3 },
    getState: vi.fn(async () => jobState), retry: vi.fn(async () => { jobState = "waiting" }) })
  const client = {
    query: vi.fn(async (rawSql: string, values: unknown[] = []) => {
      const sql = rawSql.replace(/\s+/g, " ").trim()
      if (sql === "BEGIN") { transactionSnapshot = structuredClone(state); return result([]) }
      if (sql === "COMMIT") { transactionSnapshot = null; return result([]) }
      if (sql === "ROLLBACK") {
        if (transactionSnapshot) {
          Object.assign(state.outbox, transactionSnapshot.outbox); Object.assign(state.task, transactionSnapshot.task); Object.assign(state.job, transactionSnapshot.job)
        }
        transactionSnapshot = null
        if (options.terminalOnRollback) state.outbox.lastError = "terminal:concurrent_drain"
        return result([])
      }
      if (sql.startsWith("SELECT set_config(")) return result([])
      if (sql.includes('FROM "agent_outbox"') && sql.includes('WHERE "topic" = $1')) {
        const matches = values[0] === topic && (sql.includes('"publishedAt" IS NOT NULL')
          ? state.outbox.publishedAt !== null && !state.outbox.lastError?.startsWith("terminal:")
          : state.outbox.publishedAt === null && !state.outbox.lastError?.startsWith("terminal:"))
          && (values[2] === null || state.outbox.id > String(values[2]))
        return result(matches ? [{ id: state.outbox.id, topic, aggregateId: state.outbox.aggregateId,
          idempotencyKey: state.outbox.idempotencyKey, payload: state.outbox.payload }] : [])
      }
      if (sql.includes('FROM "agent_outbox"') && sql.includes('WHERE "id" = $1')) {
        const matches = values[0] === state.outbox.id && values[1] === topic && (sql.includes('"publishedAt" IS NOT NULL')
          ? state.outbox.publishedAt !== null
          : state.outbox.publishedAt === null && !state.outbox.lastError?.startsWith("terminal:"))
        return result(matches ? [{ id: state.outbox.id, topic, aggregateId: state.outbox.aggregateId,
          idempotencyKey: state.outbox.idempotencyKey, payload: state.outbox.payload }] : [])
      }
      if (sql.includes('FROM "agent_sessions"')) return result([{ id: identity.sessionId }])
      if (sql.includes('FROM "agent_turns"')) return result([{ id: identity.fillTurnId }])
      if (sql.includes('FROM "sub_agent_tasks" AS filler')) return result([{ id: "filler-1" }])
      if (sql.includes('SELECT "sessionId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId" FROM "application_tasks"')) {
        return result([{ sessionId: identity.sessionId, fillTurnId: state.task.fillTurnId,
          fillTurnSessionId: identity.sessionId, fillTurnUserId: identity.userId }])
      }
      if (sql.includes('FROM "Job"') && sql.includes('SELECT "id"')) return result([{ id: identity.jobId }])
      if (sql.includes('SELECT "status", "checkpoint", "workerTaskId" FROM "application_tasks"')) {
        const exact = values[0] === identity.applicationTaskId && values[1] === identity.userId && values[2] === identity.jobId
          && values[3] === state.task.sessionId && values[4] === state.task.fillTurnId
        return result(exact ? [{ ...state.task }] : [])
      }
      if (sql.includes('SELECT "status", "workflowState" FROM "Job"')) return result([{ ...state.job }])
      if (sql.includes('SELECT "accountStatus" FROM "User"')) return result([{ accountStatus: options.accountStatus ?? "active" }])
      if (sql.includes('FROM "agent_approvals"')) return options.approvalProblem ? result([], 0) : result([{ expired: options.approvalExpired ?? false }], 1)
      if (sql.includes('FROM "application_task_events"')) return result([{ id: "queued-event" }])
      if (sql.startsWith("UPDATE application_tasks SET status = 'waiting_for_authorization'")) {
        state.task.status = "waiting_for_authorization"; state.task.checkpoint = "form_filled"; return result([], 1)
      }
      if (sql.startsWith('UPDATE "Job" SET "workflowState" = \'ready_to_apply\'')) {
        state.job.workflowState = "ready_to_apply"; return result([], 1)
      }
      if (sql.startsWith("INSERT INTO application_task_events")) return result([], 1)
      if (sql.startsWith('UPDATE "agent_outbox"') && sql.includes('"publishedAt" = CURRENT_TIMESTAMP')) {
        if (failAckOnce) { failAckOnce = false; throw new Error("injected acknowledgement failure") }
        state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
        state.outbox.attemptCount += 1; state.outbox.lastError = null
        return result([], 1)
      }
      if (sql.startsWith('UPDATE "agent_outbox"')) {
        if (sql.includes("NOT LIKE 'terminal:%'") && state.outbox.lastError?.startsWith("terminal:")) return result([], 0)
        state.outbox.attemptCount += 1; state.outbox.lastError = String(values[3])
        return result([], 1)
      }
      throw new Error(`Unhandled test SQL: ${sql}`)
    }),
    release: vi.fn(),
  }
  const queue = {
    getJob: vi.fn(async (jobId: string) => jobs.get(jobId)),
    add: vi.fn(async (_name: string, data: ApplyTaskSubmitPayload, opts: { jobId: string }) => {
      jobState = "waiting"
      const job = makeJob(opts.jobId, data); jobs.set(opts.jobId, job); return job
    }),
    isPaused: vi.fn(async () => options.paused ?? false),
    toKey: vi.fn((key: string) => `bull:apply:${key}`),
    client: Promise.resolve({ get: vi.fn(async () => options.lock ?? null) }),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return { state, pool, client, queue, jobs, makeJob, setJobState: (value: string) => { jobState = value } }
}
function result<Row>(rows: unknown[], rowCount = rows.length) { return { rows: rows as Row[], rowCount } }

describe("application submit outbox publisher", () => {
  beforeEach(() => mockReconcileClaimedSubmissionUncertain.mockReset().mockResolvedValue(true))

  it("recovers Redis-accepted delivery after the database acknowledgement fails", async () => {
    const fixture = makeFixture({ failAckOnce: true })
    fixture.queue.add.mockImplementationOnce(async (_name, data, options) => {
      const sql = fixture.client.query.mock.calls.map(([statement]) => statement.replace(/\s+/g, " ").trim())
      const attemptSql = sql.slice(sql.lastIndexOf("BEGIN") + 1)
      expect(attemptSql.some(statement => statement.includes('FROM "agent_sessions"') && statement.includes("FOR UPDATE"))).toBe(true)
      expect(attemptSql.some(statement => statement.includes('FROM "agent_turns"') && statement.includes("FOR UPDATE"))).toBe(true)
      expect(attemptSql.some(statement => statement.includes('FROM "sub_agent_tasks" AS filler') && statement.includes("FOR UPDATE OF filler"))).toBe(true)
      expect(attemptSql.some(statement => statement.includes('FROM "application_tasks"') && statement.includes("FOR UPDATE"))).toBe(true)
      expect(attemptSql.some(statement => statement.includes('FROM "Job"') && statement.includes("FOR UPDATE"))).toBe(true)
      expect(attemptSql).not.toContain("COMMIT")
      const job = fixture.makeJob(options.jobId, data)
      fixture.jobs.set(options.jobId, job)
      return job
    })
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("injected acknowledgement failure")
    expect(fixture.state.outbox.publishedAt).toBeNull()
    expect(fixture.jobs.has(workerTaskId)).toBe(true)

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(1)
    expect(fixture.queue.add).toHaveBeenCalledTimes(1)
    expect(fixture.queue.getJob).toHaveBeenCalledTimes(3)
    expect(fixture.state.outbox.publishedAt).toBeInstanceOf(Date)
  })

  it("recovers an ack-failed exact claim after terminal delivery without requeueing it", async () => {
    const fixture = makeFixture({ failAckOnce: true })
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("injected acknowledgement failure")
    expect(fixture.state.outbox.publishedAt).toBeNull()
    expect(fixture.jobs.has(workerTaskId)).toBe(true)

    fixture.state.task.status = "filling"
    fixture.state.task.checkpoint = "browser_active"
    fixture.state.job.workflowState = "submitting"
    fixture.setJobState("completed")
    mockReconcileClaimedSubmissionUncertain.mockImplementationOnce(async () => {
      fixture.state.task.status = "waiting_for_user"
      fixture.state.task.checkpoint = "submission_uncertain"
      return true
    })

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(mockReconcileClaimedSubmissionUncertain).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({
        applicationTaskId: identity.applicationTaskId,
        userId: identity.userId,
        jobId: identity.jobId,
        sessionId: identity.sessionId,
        fillTurnId: identity.fillTurnId,
        approvalId: identity.receiptId,
        constraintHash: identity.constraintHash,
      }), workerTaskId,
    )
    expect(fixture.state.task).toMatchObject({ status: "waiting_for_user", checkpoint: "submission_uncertain" })
    expect(fixture.state.job.workflowState).toBe("submitting")
    expect(fixture.queue.add).toHaveBeenCalledTimes(1)
    expect(fixture.jobs.get(workerTaskId)?.retry).not.toHaveBeenCalled()
    expect(fixture.state.outbox.publishedAt).toBeNull()
    expect(fixture.state.outbox.lastError).toBe("terminal:terminal_submit_reconciled")
  })

  it("terminalizes an intent after its fill Turn is superseded without publishing it", async () => {
    const fixture = makeFixture({ turnId: "successor-turn" })
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.state.outbox.publishedAt).toBeNull()
    expect(fixture.state.outbox.lastError).toBe("terminal:attempt_superseded")
  })

  it("never re-adds an intent once its exact Worker claim advanced the task", async () => {
    const fixture = makeFixture({ checkpoint: "browser_active", jobWorkflow: "submitting" })
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.state.outbox.publishedAt).toBeNull()
    expect(fixture.state.outbox.lastError).toBe("terminal:claimed_delivery_missing")
  })

  it("re-adds an evicted published intent with the same stable ID while its exact attempt is still pre-claim", async () => {
    const fixture = makeFixture()
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(1)
    expect(fixture.queue.add).toHaveBeenCalledWith("apply", payload, expect.objectContaining({ jobId: workerTaskId }))
    expect(fixture.jobs.has(workerTaskId)).toBe(true)
    expect(fixture.state.outbox.publishedAt).toBeInstanceOf(Date)
  })

  it.each(["completed", "failed"]) ("requeues the exact retained %s job in place after confirming its lock is absent", async state => {
    const fixture = makeFixture({ jobState: state })
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    const job = fixture.makeJob(workerTaskId, payload)
    fixture.jobs.set(workerTaskId, job)
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(1)
    expect(job.retry).toHaveBeenCalledWith(state, { resetAttemptsMade: true, resetAttemptsStarted: true })
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.queue.toKey).toHaveBeenCalledWith(`${workerTaskId}:lock`)
    expect(fixture.state.outbox.publishedAt).toBeInstanceOf(Date)
  })

  it.each([
    { taskStatus: "submitting", checkpoint: "browser_active", jobWorkflow: "submitting" },
    { taskStatus: "submission_uncertain", checkpoint: "submission_request_started", jobWorkflow: "submission_uncertain" },
    { taskStatus: "filling", checkpoint: "submission_request_started", jobWorkflow: "submitting" },
    { taskStatus: "completed", checkpoint: "submitted", jobWorkflow: "applied" },
    { turnId: "successor-turn" },
  ])("does not redispatch after claim or uncertainty ($taskStatus/$checkpoint)", async options => {
    const fixture = makeFixture(options)
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.state.outbox.lastError).toMatch(/^terminal:/)
    expect(fixture.state.outbox.publishedAt).toBeInstanceOf(Date)
    const lookups = fixture.queue.getJob.mock.calls.length
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.getJob).toHaveBeenCalledTimes(lookups)
  })

  it("skips terminal-job recovery while its exact BullMQ lock still exists", async () => {
    const fixture = makeFixture({ jobState: "failed", lock: "active-token" })
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    const job = fixture.makeJob(workerTaskId, payload)
    fixture.jobs.set(workerTaskId, job)
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(job.retry).not.toHaveBeenCalled()
    expect(fixture.queue.add).not.toHaveBeenCalled()
  })

  it("keeps a claimed published intent scan-eligible while its exact job is active", async () => {
    const fixture = makeFixture({ taskStatus: "submitting", checkpoint: "browser_active", jobWorkflow: "submitting", jobState: "active", lock: "active-token" })
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    const job = fixture.makeJob(workerTaskId, payload)
    fixture.jobs.set(workerTaskId, job)
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.state.outbox.lastError).toBeNull()
    expect(fixture.state.outbox.publishedAt).toBeInstanceOf(Date)
  })

  it("does not scan or publish while the queue is paused", async () => {
    const fixture = makeFixture({ paused: true })
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.getJob).not.toHaveBeenCalled()
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.state.outbox.publishedAt).toBeNull()
  })

  it("does not recover a same-ID job whose submit identity differs", async () => {
    const fixture = makeFixture()
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    const job = fixture.makeJob(workerTaskId, { ...payload, applyUrl: "https://other.example/apply" })
    fixture.jobs.set(workerTaskId, job)
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(job.retry).not.toHaveBeenCalled()
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.state.outbox.lastError).toBe("terminal:queue_job_identity_mismatch")
    expect(fixture.state.outbox.publishedAt).toBeInstanceOf(Date)
    const lookups = fixture.queue.getJob.mock.calls.length
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.getJob).toHaveBeenCalledTimes(lookups)
  })

  it("returns an exact expired preclaim attempt for fresh authorization", async () => {
    const fixture = makeFixture({ approvalExpired: true })

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(fixture.state.task).toMatchObject({ status: "waiting_for_authorization", checkpoint: "form_filled" })
    expect(fixture.state.job).toEqual({ status: "saved", workflowState: "ready_to_apply" })
    expect(fixture.state.outbox.lastError).toBe("terminal:approval_expired")
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO application_task_events"))).toBe(true)
  })

  it("terminalizes an inactive account's completed published delivery without retrying it", async () => {
    const fixture = makeFixture({ accountStatus: "suspended", jobState: "completed" })
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    const job = fixture.makeJob(workerTaskId, payload)
    fixture.jobs.set(workerTaskId, job)

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(fixture.state.outbox.lastError).toBe("terminal:application_account_inactive")
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(job.retry).not.toHaveBeenCalled()

    const lookups = fixture.queue.getJob.mock.calls.length
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.getJob).toHaveBeenCalledTimes(lookups)
  })

  it.each(["missing", "revoked", "mismatched"] as const)("does not reset an exact task when approval is %s", async approvalProblem => {
    const fixture = makeFixture({ approvalProblem })

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(fixture.state.task).toMatchObject({ status: "filling", checkpoint: "submission_authorized" })
    expect(fixture.state.job).toEqual({ status: "saved", workflowState: "queued" })
    expect(fixture.state.outbox.lastError).toBe("terminal:approval_scope_mismatch")
  })

  it.each([
    { name: "a runnable job", options: { approvalExpired: true, jobState: "waiting" } },
    { name: "an active job", options: { approvalExpired: true, jobState: "active" } },
    { name: "a live lock", options: { approvalExpired: true, jobState: "completed", lock: "active-token" } },
    { name: "a paused queue", options: { approvalExpired: true, paused: true } },
    { name: "a retryable failure", options: { approvalExpired: true, jobState: "failed", attemptsMade: 1, attempts: 3 } },
  ])("defers expiry reset while $name may still run", async ({ options }) => {
    const fixture = makeFixture(options)
    if (options.jobState) fixture.jobs.set(workerTaskId, fixture.makeJob(workerTaskId, payload))

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(fixture.state.task).toMatchObject({ status: "filling", checkpoint: "submission_authorized" })
    expect(fixture.state.job).toEqual({ status: "saved", workflowState: "queued" })
    expect(fixture.state.outbox.lastError).toBeNull()
    expect(fixture.queue.add).not.toHaveBeenCalled()
  })

  it("repairs a claimed published delivery before terminalizing its intent", async () => {
    const fixture = makeFixture({ checkpoint: "submission_request_started", jobWorkflow: "submitting", jobState: "completed" })
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    fixture.jobs.set(workerTaskId, fixture.makeJob(workerTaskId, payload))
    mockReconcileClaimedSubmissionUncertain.mockImplementationOnce(async (...args: unknown[]) => {
      expect(args[1]).toMatchObject({ applicationTaskId: identity.applicationTaskId, approvalId: identity.receiptId })
      expect(args[2]).toBe(workerTaskId)
      fixture.state.task.status = "waiting_for_user"
      fixture.state.task.checkpoint = "submission_uncertain"
      return true
    })

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(fixture.state.task).toMatchObject({ status: "waiting_for_user", checkpoint: "submission_uncertain" })
    expect(fixture.state.job).toEqual({ status: "saved", workflowState: "submitting" })
    expect(fixture.state.outbox.lastError).toBe("terminal:terminal_submit_reconciled")
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.jobs.get(workerTaskId)?.retry).not.toHaveBeenCalled()
  })

  it("leaves a published claim eligible when terminal reconciliation fails", async () => {
    const fixture = makeFixture({ checkpoint: "browser_active", jobWorkflow: "submitting", jobState: "failed" })
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    fixture.jobs.set(workerTaskId, fixture.makeJob(workerTaskId, payload))
    mockReconcileClaimedSubmissionUncertain.mockRejectedValueOnce(new Error("transient recovery write failure"))

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("transient recovery write failure")

    expect(fixture.state.outbox.lastError).toBeNull()
    expect(fixture.state.outbox.publishedAt).toBeInstanceOf(Date)
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.jobs.get(workerTaskId)?.retry).not.toHaveBeenCalled()

    mockReconcileClaimedSubmissionUncertain.mockResolvedValueOnce(true)
    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.state.outbox.lastError).toBe("terminal:terminal_submit_reconciled")
  })

  it("does not reconcile or requeue a claimed delivery whose job is missing", async () => {
    const fixture = makeFixture({ checkpoint: "browser_active", jobWorkflow: "submitting" })
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled()
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.state.outbox.lastError).toBe("terminal:claimed_delivery_missing")
  })

  it("keeps a claimed intent eligible after a retryable failed delivery", async () => {
    const fixture = makeFixture({ checkpoint: "submission_request_started", jobWorkflow: "submitting", jobState: "failed", attemptsMade: 1, attempts: 3 })
    fixture.state.outbox.publishedAt = new Date("2026-10-16T12:00:00.000Z")
    fixture.jobs.set(workerTaskId, fixture.makeJob(workerTaskId, payload))

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(mockReconcileClaimedSubmissionUncertain).not.toHaveBeenCalled()
    expect(fixture.state.outbox.lastError).toBeNull()
    expect(fixture.queue.add).not.toHaveBeenCalled()
  })

  it("does not overwrite a concurrent terminal marker when the first dispatch fails", async () => {
    const fixture = makeFixture({ terminalOnRollback: true })
    fixture.queue.add.mockImplementationOnce(async () => { throw new Error("injected queue failure") })

    await expect(drainApplicationSubmitOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("injected queue failure")

    expect(fixture.state.outbox.lastError).toBe("terminal:concurrent_drain")
  })
})
