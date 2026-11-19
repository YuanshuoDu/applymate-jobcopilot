import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { scheduledPipelineRecoveryStepMarker, withScheduledPipelineRecoveryStepProfile } from "./scheduled-pipeline-recovery-step.js"
import { resolveSteeringAgendaStep } from "./scheduled-recovery-agenda-lineage.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentAttemptCount: 2 }
const source = { owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId },
  sourceEventId: "candidate-event-1", sourceStepId: "candidate-step", sourceStepOrdinal: 4, rootAttemptCount: 2,
  inputThroughSequence: "10", consumedInputIds: [] as string[] }
const marker = scheduledPipelineRecoveryStepMarker({ owner: source.owner, source, recoveryStepId: "recovery-step", recoveryCursor: 1,
  inputThroughSequence: "10" })
const recoveryStep = { id: marker.recoveryStepId, ordinal: 5, inputThroughSequence: 10n,
  modelProfileSnapshot: withScheduledPipelineRecoveryStepProfile({ provider: "fixture" }, marker) }

function candidateRow(patch: Record<string, unknown> = {}) {
  return { sourceEventId: source.sourceEventId, actor: "orchestrator", itemId: null,
    candidatePayload: { schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v3", sessionId: scope.sessionId,
      turnId: scope.turnId, rootTaskId: scope.rootTaskId, rootAttemptCount: 2, finalStepId: source.sourceStepId,
      finalStepOrdinal: source.sourceStepOrdinal, stepAttempt: 1, candidateText: "private candidate text", finishReason: "stop",
      usage: null, sourceReceipt: null }, sourceStepId: source.sourceStepId, sourceStepTaskId: scope.rootTaskId,
    sourceStepOrdinal: source.sourceStepOrdinal, sourceStepAttempt: 1, sourceStepStatus: "completed",
    sourceProfile: { provider: "fixture" }, sourceFinishReason: null, sourceInputTokens: 0, sourceOutputTokens: 0, sourceCost: 0, ...patch }
}

function fixture(row: Record<string, unknown> | null = candidateRow()) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }))
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
}

describe("scheduled recovery agenda lineage", () => {
  it("uses the source candidate Step only after exact recovery and candidate binding", async () => {
    const f = fixture()
    await expect(resolveSteeringAgendaStep(f.client, scope, recoveryStep)).resolves.toBe(source.sourceStepId)
    expect(f.query).toHaveBeenCalledTimes(1)
    expect(f.query.mock.calls[0]?.[1]).toEqual([source.sourceEventId, scope.sessionId, scope.turnId, scope.rootTaskId,
      source.sourceStepId, scope.userId, source.sourceStepOrdinal])
  })

  it("keeps ordinary model Steps bound to their own agenda", async () => {
    const f = fixture()
    await expect(resolveSteeringAgendaStep(f.client, scope, { ...recoveryStep, id: "ordinary-step", modelProfileSnapshot: { provider: "fixture" } }))
      .resolves.toBe("ordinary-step")
    expect(f.query).not.toHaveBeenCalled()
  })

  it.each([
    { name: "recovery owner", step: { ...recoveryStep, modelProfileSnapshot: withScheduledPipelineRecoveryStepProfile({}, { ...marker,
      owner: { ...marker.owner, userId: "other-user" } }) }, row: candidateRow() },
    { name: "candidate owner", step: recoveryStep, row: candidateRow({ candidatePayload: { ...candidateRow().candidatePayload as object, turnId: "other-turn" } }) },
    { name: "source event", step: recoveryStep, row: candidateRow({ sourceEventId: "other-event" }) },
    { name: "source Step profile", step: recoveryStep, row: candidateRow({ sourceProfile: withScheduledPipelineRecoveryStepProfile({}, marker) }) },
  ])("fails closed on mismatched $name evidence", async ({ step, row }) => {
    const f = fixture(row)
    await expect(resolveSteeringAgendaStep(f.client, scope, step)).rejects.toThrow("steering_reconciliation_agenda_invalid")
  })

  it("rejects a malformed recovery marker instead of treating it as a model Step", async () => {
    const step = { ...recoveryStep, modelProfileSnapshot: { scheduledPipelineRecoveryStep: { kind: "scheduled_pipeline_recovery" } } }
    const f = fixture()
    await expect(resolveSteeringAgendaStep(f.client, scope, step)).rejects.toThrow("steering_reconciliation_agenda_invalid")
    expect(f.query).not.toHaveBeenCalled()
  })
})
