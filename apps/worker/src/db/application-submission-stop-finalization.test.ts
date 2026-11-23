import type { Pool, PoolClient } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
  applicationSubmissionStopEventId,
  type ApplicationSubmissionStopAttempt,
  type ApplicationSubmissionStopStage,
} from "@jobcopilot/shared/application-submission-stop-protocol"

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), withFence: vi.fn() }))
vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: vi.fn(() => ({ inspectSubmissionInTransaction: mocks.inspect })),
}))
vi.mock("./submission-guard.js", () => ({ withExactSubmissionClientWrite: mocks.withFence }))

import { finalizeStoppedApplicationSubmission } from "./application-submission-stop-finalization.js"
import type { ApplicationSubmissionStartScope } from "./application-task-state.js"

const scope: ApplicationSubmissionStartScope = {
  sessionId: "session-1", fillTurnId: "turn-1", turnId: "turn-1", applicationTaskId: "application-1",
  userId: "user-1", jobId: "job-1", approvalId: "approval-1", constraintHash: "a".repeat(64),
  workerTaskId: "worker-1", executionId: "execution-1",
}
const attempt: ApplicationSubmissionStopAttempt = {
  sessionId: scope.sessionId, fillTurnId: scope.fillTurnId, applicationTaskId: scope.applicationTaskId,
  userId: scope.userId, jobId: scope.jobId, approvalId: scope.approvalId, receiptId: scope.approvalId,
  constraintHash: scope.constraintHash, workerTaskId: scope.workerTaskId, executionId: scope.executionId,
}
const startEvent = {
  taskId: scope.applicationTaskId, type: "submission_execution_started", actor: "worker",
  data: {
    applicationTaskId: scope.applicationTaskId, approvalId: scope.approvalId, constraintHash: scope.constraintHash,
    executionId: scope.executionId, fillTurnId: scope.fillTurnId, jobId: scope.jobId, sessionId: scope.sessionId,
    userId: scope.userId, workerTaskId: scope.workerTaskId,
  },
}

function stageRow(stage: ApplicationSubmissionStopStage, overrides: Record<string, unknown> = {}) {
  const { executionId: _executionId, ...key } = attempt
  return {
    id: applicationSubmissionStopEventId(key, stage), taskId: scope.applicationTaskId,
    type: "submission_stop_protocol", actor: stage === "stop_requested" ? "user" : "worker",
    body: "Application submission Stop protocol state recorded.",
    data: { ...attempt, schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage }, ...overrides,
  }
}

function harness(options: {
  task?: Record<string, unknown>; attempt?: Record<string, unknown>; stages?: readonly Record<string, unknown>[]
  evidence?: readonly Record<string, unknown>[]; failTaskWrite?: boolean
} = {}) {
  const task: Record<string, unknown> = { status: "filling", checkpoint: "submission_request_started", workerTaskId: scope.workerTaskId,
    completedAt: null, fillTurnSessionId: scope.sessionId, fillTurnUserId: scope.userId, ...options.task }
  const submissionAttempt: Record<string, unknown> = { artifactHash: "artifact-hash", state: "reserved", responseRef: null, errorCode: null, ...options.attempt }
  const events = [...(options.stages ?? [stageRow("armed"), stageRow("stop_requested")]), ...(options.evidence ?? [])]
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const transactionSnapshot: { current?: { task: Record<string, unknown>; attempt: Record<string, unknown>; events: Record<string, unknown>[] } } = {}
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    if (sql === "BEGIN") {
      transactionSnapshot.current = { task: { ...task }, attempt: { ...submissionAttempt }, events: [...events] }
      return { rows: [], rowCount: 0 }
    }
    if (sql === "ROLLBACK") {
      const snapshot = transactionSnapshot.current
      if (snapshot) {
        Object.assign(task, snapshot.task)
        Object.assign(submissionAttempt, snapshot.attempt)
        events.splice(0, events.length, ...snapshot.events)
      }
      return { rows: [], rowCount: 0 }
    }
    if (sql === "COMMIT" || sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 }
    if (sql.startsWith('UPDATE "submission_attempt"')) {
      if (submissionAttempt.state !== "reserved" || submissionAttempt.responseRef !== null || submissionAttempt.artifactHash !== values[5]) return { rows: [], rowCount: 0 }
      submissionAttempt.state = "failed"
      submissionAttempt.errorCode = values[0]
      return { rows: [{ id: "attempt-1" }], rowCount: 1 }
    }
    if (sql.startsWith("UPDATE application_tasks")) {
      if (options.failTaskWrite || task.status !== "filling" || task.checkpoint !== "submission_request_started"
        || submissionAttempt.state !== "failed" || submissionAttempt.responseRef !== null) return { rows: [], rowCount: 0 }
      task.status = "failed"
      task.checkpoint = "turn_stopped_before_submit"
      task.error = values[6]
      task.completedAt = new Date()
      return { rows: [{ id: scope.applicationTaskId }], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO "application_task_events"')) {
      events.push({ id: values[0], taskId: values[1], type: "failed", actor: "worker", body: values[2] })
      return { rows: [{ id: values[0] }], rowCount: 1 }
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM application_tasks")) return { rows: [{ ...task }], rowCount: 1 }
    if (sql.startsWith("SELECT") && sql.includes('FROM "submission_attempt"')) return { rows: [{ ...submissionAttempt }], rowCount: 1 }
    if (sql.startsWith("SELECT") && sql.includes('WHERE "id" = $1') && sql.includes('FROM "application_task_events"')) {
      return { rows: [startEvent], rowCount: 1 }
    }
    if (sql.startsWith("SELECT") && sql.includes('WHERE "id" = ANY($1::text[])')) {
      const ids = values[0] as string[]
      return { rows: events.filter(row => ids.includes(String(row.id))), rowCount: 0 }
    }
    if (sql.startsWith("SELECT") && sql.includes("submission_evidence_recorded")) return { rows: events.filter(row => {
      const data = row.data as Record<string, unknown> | undefined
      return row.type === "submission_evidence_recorded" && (data?.approvalId === values[1]
        || data?.workerTaskId === values[2] || data?.executionId === values[3])
    }), rowCount: 0 }
    throw new Error(`Unexpected SQL in stopped submission finalization test: ${sql}`)
  })
  const client = { query, release: vi.fn() } as unknown as PoolClient
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return { pool, client, task, attempt: submissionAttempt, events, calls, query }
}

beforeEach(() => {
  mocks.inspect.mockReset().mockImplementation(async () => ({ status: "consumed", consumedAt: new Date(), scope: { resourceHash: "artifact-hash" } }))
  mocks.withFence.mockReset().mockImplementation(async (
    _client: unknown, _identity: unknown, _phase: unknown, write: () => Promise<unknown>,
  ) => ({ kind: "current", value: await write() }))
})

describe("finalize stopped application submission", () => {
  it("atomically fails the reserved attempt and terminalizes only its exact marked task", async () => {
    const test = harness()
    await expect(finalizeStoppedApplicationSubmission(test.pool, scope)).resolves.toBe("finalized")
    expect(mocks.withFence).toHaveBeenCalledWith(test.client, scope, "finalize_stopped_submission", expect.any(Function))
    expect(test.attempt).toMatchObject({ state: "failed", errorCode: "submission_stopped_before_dispatch", responseRef: null })
    expect(test.task).toMatchObject({ status: "failed", checkpoint: "turn_stopped_before_submit", workerTaskId: scope.workerTaskId })
    expect(test.events.at(-1)).toMatchObject({ type: "failed", actor: "worker", body: "Application submission was stopped before request dispatch." })
    expect(test.calls.some(call => call.sql.startsWith('UPDATE "Job"') || call.sql.includes("agent_approvals"))).toBe(false)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(true)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(false)
  })

  it("preserves an attempt the typed tool has already marked failed", async () => {
    const test = harness({ attempt: { state: "failed", errorCode: "provider_error" } })
    await expect(finalizeStoppedApplicationSubmission(test.pool, scope)).resolves.toBe("finalized")
    expect(test.attempt).toMatchObject({ state: "failed", errorCode: "provider_error" })
    expect(test.task).toMatchObject({ status: "failed", checkpoint: "turn_stopped_before_submit" })
    expect(test.calls.some(call => call.sql.startsWith('UPDATE "submission_attempt"'))).toBe(false)
  })

  it("returns idempotently for the same stopped terminal and failed attempt", async () => {
    const test = harness({
      task: { status: "failed", checkpoint: "turn_stopped_before_submit", completedAt: new Date() },
      attempt: { state: "failed", errorCode: "provider_error" },
    })
    await expect(finalizeStoppedApplicationSubmission(test.pool, scope)).resolves.toBe("already_finalized")
    expect(test.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
    expect(test.events).toHaveLength(2)
  })

  it.each([
    ["ordinary legacy attempt", { stages: [] }],
    ["grant won", { stages: [stageRow("armed"), stageRow("dispatch_granted")] }],
    ["submitted attempt", { attempt: { state: "submitted", responseRef: "response-1" } }],
    ["submitted evidence exists", { evidence: [{ id: "evidence-1", taskId: scope.applicationTaskId, type: "submission_evidence_recorded",
      data: { approvalId: scope.approvalId, workerTaskId: scope.workerTaskId, executionId: scope.executionId } }] }],
  ] as const)("fails closed for %s", async (_label, options) => {
    const test = harness(options)
    await expect(finalizeStoppedApplicationSubmission(test.pool, scope)).resolves.toBe("unavailable")
    expect(test.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
  })

  it("fails closed when the durable start event belongs to another execution", async () => {
    const test = harness()
    await expect(finalizeStoppedApplicationSubmission(test.pool, { ...scope, executionId: "execution-other" })).resolves.toBe("unavailable")
    expect(test.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
  })

  it("allows evidence belonging to a different approval and Worker execution", async () => {
    const test = harness({ evidence: [{ id: "other-evidence", taskId: scope.applicationTaskId, type: "submission_evidence_recorded",
      data: { approvalId: "approval-other", workerTaskId: "worker-other", executionId: "execution-other" } }] })
    await expect(finalizeStoppedApplicationSubmission(test.pool, scope)).resolves.toBe("finalized")
  })

  it("returns superseded when the current task has a successor Worker attempt", async () => {
    const test = harness({ task: { workerTaskId: "worker-successor" } })
    await expect(finalizeStoppedApplicationSubmission(test.pool, scope)).resolves.toBe("superseded")
    expect(test.task).toMatchObject({ status: "filling", workerTaskId: "worker-successor" })
    expect(test.attempt.state).toBe("reserved")
    expect(test.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
  })

  it("rolls back the attempt close if the exact Task compare-and-set fails", async () => {
    const test = harness({ failTaskWrite: true })
    await expect(finalizeStoppedApplicationSubmission(test.pool, scope)).resolves.toBe("unavailable")
    expect(test.attempt).toMatchObject({ state: "reserved", errorCode: null })
    expect(test.task).toMatchObject({ status: "filling", checkpoint: "submission_request_started" })
    expect(test.events).toHaveLength(2)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(false)
  })

  it("reports an exact owner-fence replacement without writing terminal state", async () => {
    const test = harness()
    mocks.withFence.mockResolvedValueOnce({ kind: "superseded" })
    await expect(finalizeStoppedApplicationSubmission(test.pool, scope)).resolves.toBe("superseded")
    expect(test.task.status).toBe("filling")
    expect(test.attempt.state).toBe("reserved")
    expect(test.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
  })
})
