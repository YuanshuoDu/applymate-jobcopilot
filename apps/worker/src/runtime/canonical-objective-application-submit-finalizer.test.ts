import { beforeEach, describe, expect, it, vi } from "vitest"
import { OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA } from "@jobcopilot/shared"

const mocks = vi.hoisted(() => ({ readFinalization: vi.fn(), hasEvidence: vi.fn() }))
vi.mock("./turns/recovery-scanner-objective-submit.js", () => ({
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA: "agent-harness.v2.objective-application-submit-finalization-queued.v1",
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY: "Objective submit finalization queued.",
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE: "objective_application_submit_finalization_queued",
  objectiveApplicationSubmitFinalizationEventId: () => "finalization-event-1",
  parseObjectiveApplicationSubmitFinalizationReceipt: (value: unknown) => value,
  readObjectiveApplicationSubmitFinalizationWithClient: mocks.readFinalization,
  hasObjectiveApplicationSubmitFinalizationEvidenceWithClient: mocks.hasEvidence,
}))

import { OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE,
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA } from "./turns/recovery-scanner-objective-submit.js"
import { finalizeCanonicalObjectiveApplicationSubmit } from "./canonical-objective-application-submit-finalizer.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"

const receipt = {
  schemaVersion: OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA, userId: "user-1", sessionId: "session-1",
  jobId: "job-1", applicationTaskId: "application-task-1", fillTurnId: "turn-1",
  approvalId: "approval-1", constraintHash: "a".repeat(64), workerTaskId: "worker-1", executionId: "execution-1",
  attemptId: "attempt-1", resultLinkEventId: "result-link-1", applyResultId: 1,
}
const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  approvalId: "objective-review:objective-review-" + "a".repeat(40) + ":2", reviewTurnId: "review-turn-1", materialProofHash: "b".repeat(64) }
const lease = { turnId: "turn-1", sessionId: "session-1", userId: "user-1", ownerId: "owner-1", leaseVersion: 2,
  leaseStartedAt: new Date(0), leaseExpiresAt: new Date("2030-01-01T00:00:00Z") }
const resume = { nextOrdinal: 4, stepCount: 3, toolCallCount: 1, inputThroughSequence: 5n, consumedInputIds: [],
  usage: { inputTokens: 2, outputTokens: 3, estimatedCostUsd: 0 } }

function client(query: (sql: string, values?: readonly unknown[]) => Promise<unknown>) {
  return { query: vi.fn((sql: string, values?: readonly unknown[]) => query(String(sql), values)), release: vi.fn() }
}
function poolFor(task: unknown[] = [{ id: "application-task-1", jobId: "job-1", status: "submitted",
  checkpoint: "submission_verified", workerTaskId: "worker-1" }], event: unknown[] = [{ id: "finalization-event-1",
  taskId: "application-task-1", type: OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE,
  actor: "worker", body: OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY, data: receipt }]) {
  const connections: ReturnType<typeof client>[] = []
  return { connections, pool: { connect: vi.fn(async () => {
    const current = client(async sql => {
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ source: "user", executionMode: "canonical_task_graph", status: "in_progress" }] }
      if (sql.includes('FROM "application_tasks"')) return { rows: task }
      if (sql.includes('FROM "application_task_events"')) return { rows: event }
      if (sql.includes('FROM "agent_steps"')) return { rows: [] }
      if (sql.includes("SELECT set_config")) return { rows: [] }
      return { rows: [] }
    })
    connections.push(current)
    return current
  }) } }
}
function input(pool: unknown, turnInput: unknown, overrides: Record<string, unknown> = {}) {
  const finalization = { ...receipt, eventId: "finalization-event-1", eventCreatedAt: new Date("2026-01-01T00:00:00Z") }
  mocks.readFinalization.mockResolvedValue(finalization)
  mocks.hasEvidence.mockResolvedValue(false)
  const rootTasks = { ensure: vi.fn().mockResolvedValue({ id: "root-1" }), finish: vi.fn() }
  const executionProjection = { start: vi.fn(), finish: vi.fn() }, sessionProjection = { start: vi.fn(), finish: vi.fn() }
  const terminalClient = client(async () => ({ rows: [] }))
  const factory = (_pool: unknown, guard?: TurnEngineTerminalGuard) => ({
    startStep: vi.fn(async value => ({ id: value.stepId, ordinal: value.ordinal })),
    appendEvent: vi.fn(async value => ({ id: value.id })),
    updateStep: vi.fn(),
    recordFinalResponse: vi.fn(async value => {
      const terminal = value.terminal!
      const verified = await guard?.(terminalClient as never, { ...terminal, owner: value.owner,
        response: value.response, now: value.now } as never)
      return verified?.ok ? { status: "completed" as const, finalItemId: terminal.finalItemId, events: [] } : undefined
    }),
  }) as unknown as TurnEngineStore
  return { value: {
    pool, lease, state: { source: "user", automationRunMode: "manual", rootTaskId: "root-1", goal: "Apply",
      turnInput, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, resume, ...overrides },
    signal: new AbortController().signal, rootTasks, executionProjection, sessionProjection,
    now: () => new Date("2026-11-24T12:00:00Z"), storeFactory: factory,
  }, rootTasks, executionProjection, sessionProjection, terminalClient }
}

describe("finalizeCanonicalObjectiveApplicationSubmit", () => {
  beforeEach(() => vi.clearAllMocks())

  it("leaves a valid first-time Objective Fill on the ordinary execution path", async () => {
    const db = poolFor([]), fixture = input(db.pool, { clientMessageId: "agent-objective-reviewed-fill:approval",
      reviewedApplicationMaterialSource: source })
    await expect(finalizeCanonicalObjectiveApplicationSubmit(fixture.value as never)).resolves.toBeUndefined()
    expect(db.pool.connect).toHaveBeenCalledTimes(1)
    expect(fixture.rootTasks.ensure).not.toHaveBeenCalled()
  })

  it("model-free finalizes only the exact settled Objective receipt", async () => {
    const db = poolFor(), fixture = input(db.pool, { clientMessageId: "agent-objective-reviewed-fill:approval",
      reviewedApplicationMaterialSource: source })
    const result = await finalizeCanonicalObjectiveApplicationSubmit(fixture.value as never)
    expect(result).toMatchObject({ status: "completed" })
    expect(mocks.readFinalization).toHaveBeenCalledTimes(2)
    expect(fixture.rootTasks.ensure).toHaveBeenCalledOnce()
    expect(fixture.executionProjection.start).toHaveBeenCalledOnce()
    expect(fixture.sessionProjection.start).toHaveBeenCalledOnce()
    expect(fixture.rootTasks.finish).toHaveBeenCalledOnce()
    expect(fixture.executionProjection.finish).toHaveBeenCalledOnce()
    expect(fixture.sessionProjection.finish).toHaveBeenCalledOnce()
    expect(fixture.terminalClient.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "agent_sessions" AS session SET'),
      ["session-1", "user-1", "turn-1"])
  })

  it("quarantines a malformed reserved marker without invoking model setup", async () => {
    const db = poolFor([]), fixture = input(db.pool, { clientMessageId: "agent-objective-reviewed-fill:approval",
      reviewedApplicationMaterialSource: { ...source, extra: true } })
    const result = await finalizeCanonicalObjectiveApplicationSubmit(fixture.value as never)
    expect(result).toMatchObject({ status: "waiting_for_user", summary: "objective_submit_finalization_unavailable" })
    expect(fixture.rootTasks.finish).toHaveBeenCalledOnce()
    expect(fixture.rootTasks.finish).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ errorCode: "objective_submit_finalization_unavailable" }),
    }))
    expect(fixture.executionProjection.start).toHaveBeenCalledOnce()
  })

  it("passes a valid selected-job source marker to ordinary Fill setup", async () => {
    const db = poolFor([]), fixture = input(db.pool, { clientMessageId: "application-fill:task:turn",
      reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn-1" } })
    await expect(finalizeCanonicalObjectiveApplicationSubmit(fixture.value as never)).resolves.toBeUndefined()
    expect(db.pool.connect).not.toHaveBeenCalled()
    expect(fixture.rootTasks.ensure).not.toHaveBeenCalled()
  })

  it("fails closed on whitespace or accessor-backed selected-job source fields", async () => {
    const malformed = Object.defineProperty({ schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1" },
      "sourceTurnId", { enumerable: true, get: () => "source-turn-1" })
    for (const selectedSource of [
      { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: " source-turn-1 " },
      malformed,
    ]) {
      const db = poolFor([]), fixture = input(db.pool, { clientMessageId: "application-fill:task:turn",
        reviewedApplicationMaterialSource: selectedSource })
      await expect(finalizeCanonicalObjectiveApplicationSubmit(fixture.value as never)).resolves.toMatchObject({
        status: "waiting_for_user", summary: "objective_submit_finalization_unavailable",
      })
      expect(fixture.rootTasks.finish).toHaveBeenCalledOnce()
    }
  })

  it("fails closed when a reserved Objective key carries a selected-job marker", async () => {
    const db = poolFor([]), fixture = input(db.pool, { clientMessageId: "agent-objective-reviewed-fill:approval",
      reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-turn-1" } })
    await expect(finalizeCanonicalObjectiveApplicationSubmit(fixture.value as never)).resolves.toMatchObject({
      status: "waiting_for_user", summary: "objective_submit_finalization_unavailable",
    })
    expect(fixture.rootTasks.finish).toHaveBeenCalledOnce()
  })

  it("fails closed on an unknown reserved Objective source schema", async () => {
    const db = poolFor([]), fixture = input(db.pool, { clientMessageId: "agent-objective-reviewed-fill:approval",
      reviewedApplicationMaterialSource: { ...source, schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v99" } })
    await expect(finalizeCanonicalObjectiveApplicationSubmit(fixture.value as never)).resolves.toMatchObject({
      status: "waiting_for_user", summary: "objective_submit_finalization_unavailable",
    })
    expect(fixture.rootTasks.finish).toHaveBeenCalledOnce()
  })

  it("does not reinterpret ordinary user Turns as Objective submit finalization", async () => {
    const db = poolFor(), fixture = input(db.pool, { goal: "ordinary" })
    await expect(finalizeCanonicalObjectiveApplicationSubmit(fixture.value as never)).resolves.toBeUndefined()
    expect(db.pool.connect).not.toHaveBeenCalled()
    expect(fixture.rootTasks.ensure).not.toHaveBeenCalled()
  })
})
