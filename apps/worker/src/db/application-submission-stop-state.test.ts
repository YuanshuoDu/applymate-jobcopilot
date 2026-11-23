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

import { inspectApplicationSubmissionStopState, recordApplicationSubmissionStopStage } from "./application-submission-stop-state.js"
import { markSubmissionRequestStarted, type ApplicationSubmissionStartScope } from "./application-task-state.js"

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
const startData = {
  applicationTaskId: scope.applicationTaskId, approvalId: scope.approvalId, constraintHash: scope.constraintHash,
  executionId: scope.executionId, fillTurnId: scope.fillTurnId, jobId: scope.jobId, sessionId: scope.sessionId,
  userId: scope.userId, workerTaskId: scope.workerTaskId,
}
const startEvent = { taskId: scope.applicationTaskId, type: "submission_execution_started", actor: "worker", data: startData }
const { executionId: _executionId, ...stopEventKey } = attempt

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
  taskRows?: readonly unknown[]; attemptRows?: readonly unknown[]; approval?: unknown | null; startedRows?: readonly unknown[]; events?: readonly unknown[]
} = {}) {
  const events = [...(options.events ?? [])] as Array<Record<string, unknown>>
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.includes("FROM application_tasks")) return { rows: options.taskRows ?? [{ status: "filling", checkpoint: "submission_request_started", workerTaskId: scope.workerTaskId }], rowCount: 1 }
    if (sql.includes('FROM "submission_attempt"')) return { rows: options.attemptRows ?? [{ artifactHash: "artifact-hash", state: "reserved" }], rowCount: 1 }
    if (sql.includes('WHERE "id" = $1') && sql.includes('FROM "application_task_events"')) return { rows: options.startedRows ?? [startEvent], rowCount: 1 }
    if (sql.includes('WHERE "id" = ANY($1::text[])')) {
      const ids = values[0] as string[]
      return { rows: events.filter(row => ids.includes(String(row.id))), rowCount: events.length }
    }
    if (sql.includes('INSERT INTO "application_task_events"')) {
      events.push({ id: values[0], taskId: values[1], type: values[2], actor: "worker", body: values[3], data: JSON.parse(String(values[4])) as unknown })
      return { rows: [{ id: values[0] }], rowCount: 1 }
    }
    throw new Error(`Unexpected SQL in stop adapter test: ${sql}`)
  })
  return { pool: {} as Pool, client: { query } as unknown as PoolClient, calls, events, query }
}

beforeEach(() => {
  mocks.inspect.mockReset().mockImplementation(async () => ({ status: "consumed", consumedAt: "2026-11-21T00:00:00.000Z", scope: { resourceHash: "artifact-hash" } }))
  mocks.withFence.mockReset().mockImplementation(async (
    _client: unknown, _identity: unknown, _phase: unknown, write: () => Promise<unknown>,
  ) => ({ kind: "current", value: await write() }))
})

describe("Worker application submission Stop storage", () => {
  it("records an armed marker under the exact owner fence and reserved receipt", async () => {
    const test = harness()
    await expect(recordApplicationSubmissionStopStage(test.pool, test.client, scope, "armed")).resolves.toBe("recorded")
    expect(mocks.withFence).toHaveBeenCalledOnce()
    expect(mocks.withFence.mock.calls[0]?.[1]).toMatchObject({ ...attempt })
    expect(mocks.inspect).toHaveBeenCalledWith(test.client, scope.approvalId, expect.objectContaining({
      applicationTaskId: scope.applicationTaskId, userId: scope.userId, jobId: scope.jobId,
      sessionId: scope.sessionId, fillTurnId: scope.fillTurnId, approvalId: scope.approvalId,
      constraintHash: scope.constraintHash,
    }))
    expect(test.events).toEqual([stageRow("armed")])
    expect(test.calls.find(call => call.sql.includes('WHERE "id" = ANY'))?.values[0]).toEqual([
      ...(["armed", "stop_requested", "dispatch_granted"] as const).map(stage => applicationSubmissionStopEventId(stopEventKey, stage)),
    ])
  })

  it("grants dispatch only after armed and makes exact same-stage writes idempotent", async () => {
    const test = harness()
    await expect(recordApplicationSubmissionStopStage(test.pool, test.client, scope, "armed")).resolves.toBe("recorded")
    await expect(recordApplicationSubmissionStopStage(test.pool, test.client, scope, "dispatch_granted")).resolves.toBe("recorded")
    await expect(recordApplicationSubmissionStopStage(test.pool, test.client, scope, "dispatch_granted")).resolves.toBe("duplicate")
    expect(test.events).toEqual([stageRow("armed"), stageRow("dispatch_granted")])
  })

  it("recognizes only an exact armed plus user Stop set as stopped", async () => {
    const test = harness({ events: [stageRow("armed"), stageRow("stop_requested")] })
    await expect(recordApplicationSubmissionStopStage(test.pool, test.client, scope, "dispatch_granted")).resolves.toBe("stopped")
    expect(test.events).toHaveLength(2)
  })

  it("inspects exact committed stages without creating or acknowledging a grant", async () => {
    for (const [stages, expected] of [
      [[], "missing"], [["armed"], "armed"], [["armed", "dispatch_granted"], "granted"],
      [["armed", "stop_requested"], "stopped"], [["armed", "dispatch_granted", "stop_requested"], "fenced"],
    ] as const) {
      const test = harness({ events: stages.map(stage => stageRow(stage)) })
      await expect(inspectApplicationSubmissionStopState(test.pool, test.client, scope)).resolves.toBe(expected)
      expect(test.events).toHaveLength(stages.length)
      expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(false)
    }
  })

  it("matches the start event ID and closed data keys written by application-task-state", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }))
    await expect(markSubmissionRequestStarted({ query } as unknown as PoolClient, scope)).resolves.toBe("started")
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain("SELECT 'evt_' || $6, started.\"id\", 'submission_execution_started'")
    const objectArgs = sql.split("jsonb_build_object(")[1]?.split(") FROM started")[0] ?? ""
    expect(Array.from(objectArgs.matchAll(/'([^']+)'/g), match => match[1])).toEqual([
      "executionId", "workerTaskId", "applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "constraintHash",
    ])
    expect(query.mock.calls[0]?.[1]).toEqual([
      scope.applicationTaskId, scope.userId, scope.jobId, scope.sessionId, scope.fillTurnId,
      scope.executionId, scope.workerTaskId, scope.approvalId, scope.constraintHash,
    ])
  })

  it("does not grant without armed or from a different execution", async () => {
    const withoutArmed = harness()
    await expect(recordApplicationSubmissionStopStage(withoutArmed.pool, withoutArmed.client, scope, "dispatch_granted")).resolves.toBe("fenced")
    const previousExecution = harness({ events: [stageRow("armed", { data: { ...attempt, executionId: "execution-old", schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage: "armed" } })] })
    await expect(recordApplicationSubmissionStopStage(previousExecution.pool, previousExecution.client, scope, "dispatch_granted")).resolves.toBe("fenced")
  })

  it.each([
    ["stale application task", { taskRows: [] }],
    ["missing reservation", { attemptRows: [] }],
    ["non-reserved attempt", { attemptRows: [{ artifactHash: "artifact-hash", state: "submitted" }] }],
    ["unconsumed approval", { approval: { status: "approved", scope: { resourceHash: "artifact-hash" } } }],
    ["changed approval material", { approval: { status: "consumed", consumedAt: "now", scope: { resourceHash: "other" } } }],
    ["missing start event", { startedRows: [] }],
  ] as const)("fails closed for %s", async (_label, options) => {
    const test = harness(options)
    if ("approval" in options) mocks.inspect.mockImplementation(async () => options.approval)
    await expect(recordApplicationSubmissionStopStage(test.pool, test.client, scope, "armed")).resolves.toBe("fenced")
    expect(test.events).toHaveLength(0)
  })

  it.each([
    ["actor", { actor: "user" }],
    ["body", { body: "unexpected body" }],
  ])("rejects a corrupt %s at the deterministic stage key", async (_field, change) => {
    const corrupt = stageRow("armed", change)
    const test = harness({ events: [corrupt] })
    await expect(recordApplicationSubmissionStopStage(test.pool, test.client, scope, "armed")).resolves.toBe("fenced")
    expect(test.events).toEqual([corrupt])
  })
})
