import { beforeEach, describe, expect, it, vi } from "vitest"
import { OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA, OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE,
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY, objectiveApplicationSubmitResultEventId } from "../db/objective-application-submit-result.js"

const mocks = vi.hoisted(() => ({ sourceWrite: vi.fn(), readResult: vi.fn(), settle: vi.fn() }))
vi.mock("../db/submission-guard.js", () => ({ withExactSubmissionSourceWrite: mocks.sourceWrite }))
vi.mock("../db/objective-application-submit-result.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../db/objective-application-submit-result.js")>()
  return { ...actual, readObjectiveApplicationSubmitResultWithClient: mocks.readResult }
})
vi.mock("./application-submit-fence.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./application-submit-fence.js")>()
  return { ...actual, recordSubmissionExecutionSettledWithClient: mocks.settle }
})

import { OBJECTIVE_SUBMIT_RECOVERY_EVENT_SCHEMA, OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE, hasObjectiveSubmitResultCandidate,
  hasExactObjectiveSubmitResult,
  recoverObjectiveSubmitAfterTerminal } from "./objective-application-submit-terminal-recovery.js"

const intent = { applicationTaskId: "task-1", userId: "user-1", jobId: "job-1", sessionId: "session-1",
  fillTurnId: "fill-1", approvalId: "approval-1", constraintHash: "a".repeat(64), workerTaskId: "bull-1" }
const execution = { ...intent, executionId: "execution-1" }
const stored = { schemaVersion: OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA, ...execution,
  attemptId: "attempt-1", applyResultId: 9 }
const resultEventId = objectiveApplicationSubmitResultEventId({ applicationTaskId: intent.applicationTaskId,
  fillTurnId: intent.fillTurnId, approvalId: intent.approvalId })
const resultReceipt = { ...stored, eventId: resultEventId, eventCreatedAt: new Date("2026-11-20T12:00:00Z") }

function setup(options: { candidate?: boolean; task?: Record<string, unknown>; job?: Record<string, unknown>; settled?: unknown[];
  audit?: "valid" | "invalid"; candidateEvent?: Record<string, unknown>; candidateDuplicate?: boolean } = {}) {
  const resultEvent = { id: resultEventId, taskId: intent.applicationTaskId, type: OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE,
    actor: "worker", body: OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY, data: stored, createdAt: new Date() }
  const sourceClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("INSERT INTO \"Job\"")) return { rowCount: 1, rows: [{ id: intent.jobId }] }
    if (sql.includes("UPDATE \"application_tasks\"")) return { rowCount: 1, rows: [{ id: intent.applicationTaskId }] }
    if (sql.includes("INSERT INTO \"application_task_events\"")) return { rowCount: 1, rows: [{ id: values?.[0] }] }
    if (sql.includes("FROM \"application_task_events\"") && values?.[2] === OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE) return { rows: [resultEvent] }
    if (sql.includes("FROM \"application_task_events\"") && values?.[2] === OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE) {
      if (!options.audit) return { rows: [] }
      const eventData = { schemaVersion: OBJECTIVE_SUBMIT_RECOVERY_EVENT_SCHEMA, ...execution,
        attemptId: stored.attemptId, resultLinkEventId: resultEventId, applyResultId: stored.applyResultId,
        terminalObservationKind: options.audit === "valid" ? "queue_terminal" : "unknown" }
      return { rows: [{ id: values[1], taskId: intent.applicationTaskId, type: OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE,
        actor: "worker", body: "Objective browser-confirmed result recovered.", data: eventData }] }
    }
    if (sql.includes("FROM \"application_task_events\"") && sql.includes("submission_execution_settled")) return { rows: options.settled ?? [] }
    if (sql.includes("FROM \"application_tasks\"")) return { rows: [options.task ?? {
      id: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId, sessionId: intent.sessionId,
      fillTurnId: intent.fillTurnId, fillTurnSessionId: intent.sessionId, fillTurnUserId: intent.userId,
      workerTaskId: intent.workerTaskId, status: "filling", checkpoint: "submission_request_started", completedAt: null,
    }] }
    if (sql.includes("FROM \"Job\"")) return { rows: [options.job ?? {
      id: intent.jobId, userId: intent.userId, status: "saved", workflowState: "submitting", appliedAt: null,
    }] }
    return { rows: [], rowCount: 1 }
  }) }
  mocks.sourceWrite.mockImplementation(async (_pool: unknown, _identity: unknown, _phase: string, work: (client: unknown) => Promise<unknown>) => ({
    kind: "current", value: await work(sourceClient),
  }))
  mocks.readResult.mockResolvedValue(resultReceipt)
  mocks.settle.mockResolvedValue(true)
  const probeClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM "application_task_events"') && values?.[2] === OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE) {
      if (options.candidate === false) return { rows: [] }
      const event = options.candidateEvent ?? resultEvent
      return { rows: options.candidateDuplicate ? [event, event] : [event] }
    }
    return { rows: [] }
  }), release: vi.fn() }
  const pool = { connect: vi.fn(async () => probeClient) }
  return { pool, probeClient, sourceClient }
}

describe("Objective submit terminal recovery", () => {
  beforeEach(() => vi.clearAllMocks())

  it("repairs the exact positive result under the source fence and settles in the same client", async () => {
    const test = setup()
    expect(await hasObjectiveSubmitResultCandidate(test.pool as never, intent)).toBe(true)
    await expect(recoverObjectiveSubmitAfterTerminal(test.pool as never, intent, async () => "queue_terminal"))
      .resolves.toBe("recovered")
    const sql = test.sourceClient.query.mock.calls.map(([query]) => String(query))
    const jobUpdate = sql.findIndex(query => query.includes("UPDATE \"Job\""))
    const taskUpdate = sql.findIndex(query => query.includes("UPDATE \"application_tasks\""))
    const audit = test.sourceClient.query.mock.calls.find(([query, values]) => String(query).includes("INSERT INTO \"application_task_events\"")
      && values?.[2] === OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE)
    expect(jobUpdate).toBeGreaterThan(-1)
    expect(taskUpdate).toBeGreaterThan(jobUpdate)
    const auditPayload = JSON.parse(String(audit?.[1]?.[4])) as Record<string, unknown>
    expect(auditPayload).toMatchObject({ schemaVersion: "agent-harness.v2.objective-application-submit-recovery.v1",
      terminalObservationKind: "queue_terminal", resultLinkEventId: resultEventId })
    expect(Object.keys(auditPayload)).not.toContain("resumeContent")
    expect(mocks.settle).toHaveBeenCalledWith(test.sourceClient, execution)
  })

  it("repairs missing projections when the exact normal settlement already exists", async () => {
    const test = setup({ settled: [{ id: `evt_${execution.executionId}`, actor: "worker", body: "Submit execution settled", data: execution,
      createdAt: new Date("2026-11-20T12:00:00Z") }] })
    await expect(recoverObjectiveSubmitAfterTerminal(test.pool as never, intent, async () => "queue_terminal"))
      .resolves.toBe("recovered")
    const calls = test.sourceClient.query.mock.calls
    expect(calls.some(([query]) => String(query).includes('UPDATE "Job"'))).toBe(true)
    expect(calls.some(([query]) => String(query).includes('UPDATE "application_tasks"'))).toBe(true)
    expect(calls.some(([query, values]) => String(query).includes('INSERT INTO "application_task_events"')
      && values?.[2] === OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE)).toBe(true)
    expect(mocks.settle).not.toHaveBeenCalled()
  })

  it("does not enter the repair path when the private result link is absent", async () => {
    const test = setup({ candidate: false })
    expect(await hasObjectiveSubmitResultCandidate(test.pool as never, intent)).toBe(false)
    expect(mocks.sourceWrite).not.toHaveBeenCalled()
  })

  it("short-circuits only for the exact owner-scoped result and canonical linked receipt", async () => {
    const test = setup()
    await expect(hasExactObjectiveSubmitResult(test.pool as never, intent)).resolves.toBe(true)
    expect(test.probeClient.query).toHaveBeenCalledWith("BEGIN")
    expect(test.probeClient.query).toHaveBeenCalledWith("SELECT set_config($1, $2, true)", ["app.user_id", intent.userId])
    expect(test.probeClient.query).toHaveBeenCalledWith(expect.stringContaining("\"data\"->>'fillTurnId'=$4"),
      [intent.applicationTaskId, resultEventId, OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, intent.fillTurnId])
    expect(mocks.readResult).toHaveBeenCalledWith(test.probeClient, execution)
    expect(test.probeClient.query).toHaveBeenCalledWith("COMMIT")
  })

  it("does not short-circuit malformed, mismatched, duplicate, or unreadable result evidence", async () => {
    const malformed = setup({ candidateEvent: { id: resultEventId, taskId: intent.applicationTaskId,
      type: OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, actor: "worker", body: OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY,
      data: { ...stored, extra: true } } })
    await expect(hasExactObjectiveSubmitResult(malformed.pool as never, intent)).resolves.toBe(false)
    expect(mocks.readResult).not.toHaveBeenCalled()

    const mismatched = setup({ candidateEvent: { id: resultEventId, taskId: intent.applicationTaskId,
      type: OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, actor: "worker", body: OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY,
      data: { ...stored, workerTaskId: "superseded-worker" } } })
    await expect(hasExactObjectiveSubmitResult(mismatched.pool as never, intent)).resolves.toBe(false)
    expect(mocks.readResult).not.toHaveBeenCalled()

    const duplicate = setup({ candidateDuplicate: true })
    await expect(hasExactObjectiveSubmitResult(duplicate.pool as never, intent)).resolves.toBe(false)
    expect(mocks.readResult).not.toHaveBeenCalled()

    const unreadable = setup()
    mocks.readResult.mockResolvedValueOnce(null)
    await expect(hasExactObjectiveSubmitResult(unreadable.pool as never, intent)).resolves.toBe(false)
  })

  it("propagates database errors so replay cannot proceed to browser work", async () => {
    const test = setup()
    test.pool.connect.mockRejectedValueOnce(new Error("database unavailable"))
    await expect(hasExactObjectiveSubmitResult(test.pool as never, intent)).rejects.toThrow("database unavailable")
  })

  it("requires terminal evidence again inside the fenced transaction", async () => {
    const test = setup()
    await expect(recoverObjectiveSubmitAfterTerminal(test.pool as never, intent, async () => null)).resolves.toBe("not_recovered")
    expect(mocks.readResult).not.toHaveBeenCalled()
    expect(test.sourceClient.query.mock.calls.some(([query]) => String(query).startsWith("UPDATE "))).toBe(false)
  })

  it("rejects the historical result if its exact readback is unavailable", async () => {
    const test = setup()
    mocks.readResult.mockResolvedValueOnce(null)
    await expect(recoverObjectiveSubmitAfterTerminal(test.pool as never, intent, async () => "terminal_callback"))
      .resolves.toBe("not_recovered")
    expect(test.sourceClient.query.mock.calls.some(([query]) => String(query).startsWith("UPDATE "))).toBe(false)
    expect(mocks.settle).not.toHaveBeenCalled()
  })

  it("does not overwrite a foreign current Task or Job state", async () => {
    const test = setup({ task: { id: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId,
      sessionId: intent.sessionId, fillTurnId: intent.fillTurnId, fillTurnSessionId: intent.sessionId,
      fillTurnUserId: intent.userId, workerTaskId: "other-worker", status: "filling",
      checkpoint: "submission_request_started", completedAt: null } })
    await expect(recoverObjectiveSubmitAfterTerminal(test.pool as never, intent, async () => "queue_terminal"))
      .resolves.toBe("not_recovered")
    expect(test.sourceClient.query.mock.calls.some(([query]) => String(query).startsWith("UPDATE "))).toBe(false)
  })

  it("replays only an exact existing recovery audit for an already-settled attempt", async () => {
    const test = setup({ task: { id: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId, sessionId: intent.sessionId,
      fillTurnId: intent.fillTurnId, fillTurnSessionId: intent.sessionId, fillTurnUserId: intent.userId, workerTaskId: intent.workerTaskId,
      status: "submitted", checkpoint: "submission_verified", completedAt: new Date() },
      job: { id: intent.jobId, userId: intent.userId, status: "applied", workflowState: "submitted", appliedAt: new Date() },
      settled: [{ id: `evt_${execution.executionId}`, actor: "worker", body: "Submit execution settled", data: execution,
        createdAt: new Date("2026-11-20T12:00:00Z") }], audit: "valid" })

    await expect(recoverObjectiveSubmitAfterTerminal(test.pool as never, intent, async () => "persisted_terminal_proof"))
      .resolves.toBe("already_settled")
    expect(test.sourceClient.query.mock.calls.some(([query]) => String(query).startsWith("UPDATE "))).toBe(false)
    expect(mocks.settle).not.toHaveBeenCalled()
  })

  it("rejects a tampered private recovery audit on terminal replay", async () => {
    const test = setup({ task: { id: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId, sessionId: intent.sessionId,
      fillTurnId: intent.fillTurnId, fillTurnSessionId: intent.sessionId, fillTurnUserId: intent.userId, workerTaskId: intent.workerTaskId,
      status: "submitted", checkpoint: "submission_verified", completedAt: new Date() },
      job: { id: intent.jobId, userId: intent.userId, status: "applied", workflowState: "submitted", appliedAt: new Date() },
      settled: [{ id: `evt_${execution.executionId}`, actor: "worker", body: "Submit execution settled", data: execution,
        createdAt: new Date("2026-11-20T12:00:00Z") }], audit: "invalid" })

    await expect(recoverObjectiveSubmitAfterTerminal(test.pool as never, intent, async () => "persisted_terminal_proof"))
      .resolves.toBe("not_recovered")
    expect(test.sourceClient.query.mock.calls.some(([query]) => String(query).startsWith("UPDATE "))).toBe(false)
  })

  it("rejects a settlement that predates the immutable positive result link", async () => {
    const test = setup({ task: { id: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId, sessionId: intent.sessionId,
      fillTurnId: intent.fillTurnId, fillTurnSessionId: intent.sessionId, fillTurnUserId: intent.userId, workerTaskId: intent.workerTaskId,
      status: "submitted", checkpoint: "submission_verified", completedAt: new Date() },
      job: { id: intent.jobId, userId: intent.userId, status: "applied", workflowState: "submitted", appliedAt: new Date() },
      settled: [{ id: `evt_${execution.executionId}`, actor: "worker", body: "Submit execution settled", data: execution,
        createdAt: new Date("2026-11-20T11:59:59Z") }] })

    await expect(recoverObjectiveSubmitAfterTerminal(test.pool as never, intent, async () => "persisted_terminal_proof"))
      .resolves.toBe("not_recovered")
    expect(test.sourceClient.query.mock.calls.some(([query]) => String(query).startsWith("UPDATE "))).toBe(false)
  })
})
