import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { scheduledPipelineRecoveryStepMarker, withScheduledPipelineRecoveryStepProfile } from "./subagents/scheduled-pipeline-recovery-step.js"
import { isScheduledRecoveryOperationalWait, readScheduledRecoveryWaitRows } from "./canonical-turn-scheduled-recovery-wait.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const source = { owner: scope, sourceEventId: "candidate-event", sourceStepId: "candidate-step", sourceStepOrdinal: 3,
  rootAttemptCount: 2, inputThroughSequence: "8", consumedInputIds: [] as string[] }
const marker = scheduledPipelineRecoveryStepMarker({ owner: source.owner, source, recoveryStepId: "recovery-step", recoveryCursor: 1,
  inputThroughSequence: "8" })
const step = { id: marker.recoveryStepId, taskId: scope.rootTaskId, ordinal: 4, attempt: 1, status: "waiting_for_tool",
  errorCode: null, inputThroughSequence: "8", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
  modelProfileSnapshot: withScheduledPipelineRecoveryStepProfile({ provider: "fixture" }, marker) }
const started = { id: "start-event", type: "step.started", actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId,
  turnId: scope.turnId, taskId: scope.rootTaskId, itemId: null, correlationId: step.id,
  idempotencyKey: `turn:${scope.turnId}:event:step-started:${step.id}`, sequence: "1",
  payload: { stepId: step.id, ordinal: step.ordinal, taskId: scope.rootTaskId, scheduledPipelineRecoveryStep: marker } }
const completed = { id: "completed-event", type: "step.completed", actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId,
  turnId: scope.turnId, taskId: scope.rootTaskId, itemId: null, correlationId: step.id,
  idempotencyKey: `turn:${scope.turnId}:event:step-completed:${step.id}`, sequence: "2",
  payload: { stepId: step.id, status: "waiting_for_dependency", taskId: scope.rootTaskId, waitId: "wait-1" } }
const wait = { id: "wait-1", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, parentTaskId: scope.rootTaskId,
  stepId: step.id, status: "ready", targetTaskIds: ["prepare-1"], matchedTaskIds: ["prepare-1"], mode: "all",
  suspendedAt: new Date("2026-10-01T00:00:00.000Z"), consumedAt: new Date("2026-10-01T00:01:00.000Z") }
const validInput = { step, items: [] as Record<string, unknown>[], events: [started, completed], waits: [wait], scope }

function reader(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows, rowCount: rows.length }))
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
}

describe("scheduled recovery wait accounting evidence", () => {
  it("accepts a zero-activity recovery Step only with its exact consumed durable wait", () => {
    expect(isScheduledRecoveryOperationalWait(validInput)).toBe(true)
  })

  it("does not classify a regular model Step as an operational recovery wait", () => {
    expect(isScheduledRecoveryOperationalWait({ ...validInput, step: { ...step, modelProfileSnapshot: { provider: "fixture" } } })).toBe(false)
  })

  it.each([
    ["foreign owner", { ...validInput, step: { ...step, modelProfileSnapshot: withScheduledPipelineRecoveryStepProfile({}, {
      ...marker, owner: { ...marker.owner, userId: "other-user" },
    }) } }],
    ["nonzero usage", { ...validInput, step: { ...step, inputTokens: 1 } }],
    ["model event", { ...validInput, events: [...validInput.events, { ...started, id: "model-start", type: "model.started" }] }],
    ["tool item", { ...validInput, items: [{ id: "tool-item", stepId: step.id, type: "tool_call" }] }],
    ["missing step start", { ...validInput, events: [completed] }],
    ["wait bound to another Step", { ...validInput, waits: [{ ...wait, stepId: "other-step" }] }],
    ["wait is not consumed", { ...validInput, waits: [{ ...wait, consumedAt: null }] }],
    ["wait is not ready", { ...validInput, waits: [{ ...wait, status: "timed_out" }] }],
    ["ambiguous wait", { ...validInput, waits: [wait, { ...wait }] }],
  ] as const)("fails closed for %s evidence", (_name, input) => {
    expect(() => isScheduledRecoveryOperationalWait(input)).toThrow("archived_wait_accounting_invalid")
  })

  it("loads only owner-bound wait rows referenced by marked recovery Steps", async () => {
    const f = reader([wait])
    await expect(readScheduledRecoveryWaitRows(f.client, { scope, steps: [step], events: [completed] })).resolves.toEqual([wait])
    expect(f.query.mock.calls[0]?.[1]).toEqual([["wait-1"], scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId])
  })

  it("does not query waits when no scheduled recovery marker exists", async () => {
    const f = reader([])
    await expect(readScheduledRecoveryWaitRows(f.client, { scope, steps: [{ ...step, modelProfileSnapshot: { provider: "fixture" } }], events: [] }))
      .resolves.toEqual([])
    expect(f.query).not.toHaveBeenCalled()
  })
})
