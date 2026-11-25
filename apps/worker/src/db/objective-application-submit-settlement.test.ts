import type { PoolClient } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ readResult: vi.fn(), resultEventId: vi.fn(() => "objective-submit-result-1") }))
vi.mock("./objective-application-submit-result.js", () => ({
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA: "agent-harness.v2.objective-application-submit-result.v1",
  objectiveApplicationSubmitResultEventId: mocks.resultEventId,
  readObjectiveApplicationSubmitResultWithClient: mocks.readResult,
}))

import { readObjectiveApplicationSubmitSettlement } from "./objective-application-submit-settlement.js"

const scopeBase = {
  sessionId: "session-1", fillTurnId: "fill-turn-1", applicationTaskId: "application-1", userId: "user-1", jobId: "job-1",
  approvalId: "application-fill:application-1:fill-turn-1", workerTaskId: "worker-task-1", executionId: "execution-1",
  constraintHash: "a".repeat(64),
} as const
const eventData = {
  executionId: scopeBase.executionId, workerTaskId: scopeBase.workerTaskId, applicationTaskId: scopeBase.applicationTaskId,
  userId: scopeBase.userId, jobId: scopeBase.jobId, sessionId: scopeBase.sessionId, fillTurnId: scopeBase.fillTurnId,
  approvalId: scopeBase.approvalId, constraintHash: scopeBase.constraintHash,
}
const startedAt = new Date("2026-11-24T10:00:00.000Z")
const linkedAt = new Date("2026-11-24T10:00:00.500Z")
const settledAt = new Date("2026-11-24T10:00:01.000Z")

async function fixture(overrides: {
  task?: Record<string, unknown>; turn?: Record<string, unknown>; events?: Array<Record<string, unknown>>; job?: Record<string, unknown>
} = {}) {
  const scope = scopeBase
  const data = eventData
  const rows = {
    task: { id: scope.applicationTaskId, userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId,
      fillTurnId: scope.fillTurnId, fillTurnSessionId: scope.sessionId, fillTurnUserId: scope.userId,
      workerTaskId: scope.workerTaskId, status: "submitted", checkpoint: "submission_verified", completedAt: settledAt,
      ...overrides.task },
    turn: { id: scope.fillTurnId, status: "waiting_for_approval", executionMode: "canonical_task_graph",
      input: { reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
        approvalId: `objective-review:objective-review-${"a".repeat(40)}:1`, reviewTurnId: "review-turn-1", materialProofHash: "f".repeat(64) } },
      ...overrides.turn },
    events: overrides.events ?? [
      { id: `evt_${scope.executionId}`, type: "submission_execution_started", actor: "worker", body: "Submit execution started", data, createdAt: startedAt },
      { id: "settled-event-1", type: "submission_execution_settled", actor: "worker", body: "Submit execution settled", data, createdAt: settledAt },
    ],
    job: { id: scope.jobId, userId: scope.userId, status: "applied", workflowState: "submitted", appliedAt: settledAt, ...overrides.job },
  }
  const linked = { schemaVersion: "agent-harness.v2.objective-application-submit-result.v1", applicationTaskId: scope.applicationTaskId,
    userId: scope.userId, jobId: scope.jobId, sessionId: scope.sessionId, fillTurnId: scope.fillTurnId, approvalId: scope.approvalId,
    constraintHash: scope.constraintHash, workerTaskId: scope.workerTaskId, executionId: scope.executionId,
    attemptId: "attempt-1", applyResultId: 17, eventId: "objective-submit-result-1", eventCreatedAt: linkedAt }
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM "application_tasks"')) {
      const matches = rows.task.id === values?.[0] && rows.task.userId === values?.[1] && rows.task.jobId === values?.[2]
        && rows.task.sessionId === values?.[3] && rows.task.fillTurnId === values?.[4]
        && rows.task.fillTurnSessionId === values?.[3] && rows.task.fillTurnUserId === values?.[1]
      return { rows: matches ? [rows.task] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_turns"')) {
      const matches = rows.turn.id === values?.[0] && scope.sessionId === values?.[1] && scope.userId === values?.[2]
      return { rows: matches ? [rows.turn] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.includes('FROM "application_task_events"')) {
      const relevant = rows.events.filter(event => {
        const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {}
        return data.approvalId === scope.approvalId || data.workerTaskId === scope.workerTaskId
          || data.executionId === scope.executionId || event.id === `evt_${scope.executionId}`
      })
      const ordered = relevant.sort((left, right) => new Date(String(left.createdAt)).getTime() - new Date(String(right.createdAt)).getTime()
        || String(left.id).localeCompare(String(right.id)))
      return { rows: ordered, rowCount: ordered.length }
    }
    if (sql.includes('FROM "Job"')) {
      const matches = rows.job.id === values?.[0] && rows.job.userId === values?.[1]
      return { rows: matches ? [rows.job] : [], rowCount: matches ? 1 : 0 }
    }
    throw new Error("unexpected query")
  })
  const client = { query } as unknown as Pick<PoolClient, "query">
  mocks.readResult.mockResolvedValue(linked)
  return { client, query, rows, scope, linked }
}

describe("readObjectiveApplicationSubmitSettlement", () => {
  beforeEach(() => mocks.readResult.mockReset())

  it("returns only bounded IDs for one exact settled Objective submission", async () => {
    const value = await fixture()
    await expect(readObjectiveApplicationSubmitSettlement(value.client, value.scope)).resolves.toEqual({
      userId: value.scope.userId, sessionId: value.scope.sessionId, applicationTaskId: value.scope.applicationTaskId,
      jobId: value.scope.jobId, fillTurnId: value.scope.fillTurnId, approvalId: value.scope.approvalId,
      workerTaskId: value.scope.workerTaskId, executionId: value.scope.executionId, attemptId: "attempt-1",
      resultLinkEventId: "objective-submit-result-1", applyResultId: 17, fillTurnStatus: "waiting_for_approval",
    })
    expect(mocks.readResult).toHaveBeenCalledWith(value.client, value.scope)
  })

  it.each([
    ["nonterminal task", { task: { status: "filling" } }],
    ["wrong checkpoint", { task: { checkpoint: "submission_uncertain" } }],
    ["foreign task", { task: { fillTurnUserId: "other-user" } }],
    ["non-Objective turn", { turn: { input: {} } }],
    ["terminal Turn", { turn: { status: "failed" } }],
    ["waiting-for-user Turn", { turn: { status: "waiting_for_user" } }],
    ["wrong Job status", { job: { status: "saved" } }],
    ["wrong Job workflow", { job: { workflowState: "submitting" } }],
  ] as const)("fails closed on %s", async (_name, overrides) => {
    const value = await fixture(overrides)
    await expect(readObjectiveApplicationSubmitSettlement(value.client, value.scope)).resolves.toBeNull()
  })

  it("rejects missing, duplicate, reversed, or mismatched execution events", async () => {
    const base = await fixture()
    const [start, settle] = base.rows.events
    const variants = [
      [], [start, settle, settle], [settle, { ...start!, createdAt: new Date("2026-11-24T10:00:02.000Z") }],
      [start, { ...settle, data: { ...(settle!.data as object), executionId: "other-execution" } }],
      [start, { ...settle, createdAt: startedAt }],
    ]
    for (const events of variants) {
      const value = await fixture({ events })
      await expect(readObjectiveApplicationSubmitSettlement(value.client, value.scope)).resolves.toBeNull()
    }
  })

  it("allows same-millisecond events by type and rejects a result link outside the start-to-settle interval", async () => {
    const value = await fixture()
    const [start, settle] = value.rows.events
    const tied = await fixture({ events: [
      { ...settle!, id: "a-settled-event", createdAt: startedAt },
      { ...start!, createdAt: startedAt },
    ] })
    tied.linked.eventCreatedAt = startedAt
    mocks.readResult.mockResolvedValueOnce(tied.linked)
    await expect(readObjectiveApplicationSubmitSettlement(tied.client, tied.scope)).resolves.toMatchObject({ applyResultId: 17 })

    for (const eventCreatedAt of [new Date(startedAt.getTime() - 1), new Date(settledAt.getTime() + 1)]) {
      const outside = await fixture()
      mocks.readResult.mockResolvedValueOnce({ ...outside.linked, eventCreatedAt })
      await expect(readObjectiveApplicationSubmitSettlement(outside.client, outside.scope)).resolves.toBeNull()
    }
  })

  it("ignores a different historical worker attempt but rejects duplicate rows for this receipt", async () => {
    const value = await fixture()
    const unrelated = [
      { id: "evt_old", type: "submission_execution_started", actor: "worker", body: "Submit execution started",
        data: { ...eventData, approvalId: "old-approval", workerTaskId: "old-worker", executionId: "old-execution" }, createdAt: startedAt },
      { id: "evt_old_settled", type: "submission_execution_settled", actor: "worker", body: "Submit execution settled",
        data: { ...eventData, approvalId: "old-approval", workerTaskId: "old-worker", executionId: "old-execution" }, createdAt: settledAt },
    ]
    const historical = await fixture({ events: [...value.rows.events, ...unrelated] })
    await expect(readObjectiveApplicationSubmitSettlement(historical.client, historical.scope)).resolves.toMatchObject({ applyResultId: 17 })
    const duplicate = await fixture({ events: [...value.rows.events, value.rows.events[1]!] })
    await expect(readObjectiveApplicationSubmitSettlement(duplicate.client, duplicate.scope)).resolves.toBeNull()
  })

  it.each(["waiting_for_approval", "queued", "in_progress", "completed"] as const)(
    "exposes the allowed canonical Fill Turn state %s", async status => {
      const value = await fixture({ turn: { status } })
      await expect(readObjectiveApplicationSubmitSettlement(value.client, value.scope)).resolves.toMatchObject({ fillTurnStatus: status })
    },
  )

  it("rejects missing or conflicting immutable ApplyResult links", async () => {
    for (const corrupt of [null, { eventId: "" }, { eventId: "different-event" }, { applyResultId: 0 }, { jobId: "other-job" },
      { schemaVersion: "other-schema" }]) {
      const value = await fixture()
      mocks.readResult.mockResolvedValueOnce(corrupt && { ...value.linked, ...corrupt })
      await expect(readObjectiveApplicationSubmitSettlement(value.client, value.scope)).resolves.toBeNull()
    }
  })

  it("projects extended callers to the exact result-reader scope", async () => {
    const value = await fixture()
    await readObjectiveApplicationSubmitSettlement(value.client, { ...value.scope, turnId: "other-turn" } as typeof value.scope)
    expect(mocks.readResult).toHaveBeenCalledWith(value.client, value.scope)
  })
})
