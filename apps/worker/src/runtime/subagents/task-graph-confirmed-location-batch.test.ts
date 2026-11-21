import { describe, expect, it, vi } from "vitest"
import { formatObjectiveLocationSteerMessage, OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { TaskGraphConfirmedLocationBatchInput } from "./task-graph-confirmed-location-batch.js"
import { readTaskGraphConfirmedLocationBatch, readTaskGraphConfirmedLocationBatchForReceipt } from "./task-graph-confirmed-location-batch.js"
import { STEERING_RECONCILIATION_SCHEMA_VERSION, parseSteeringReconciliationReceipt, steeringReconciliationIdempotencyKey,
  validSteeringReconciliationScope } from "./steering-reconciliation-contract.js"

const identity = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" } as const
const scope = { ...identity, parentTaskId: identity.rootTaskId, stepId: "step-current", turnLeaseOwner: "turn-owner",
  turnLeaseVersion: 3, parentLeaseOwner: "root-owner", parentAttemptCount: 2 } as const
const locations = new Map([[10n, ["berlin"]], [20n, ["dublin"]]])
const ids = new Map([[10n, "input-1"], [20n, "input-2"]])
const inputContent = (sequence: bigint) => [{ type: "text", text: formatObjectiveLocationSteerMessage(locations.get(sequence)!) }]

function row(sequence: bigint, options: Readonly<{ duplicateCount?: number; actor?: string; status?: string }> = {}) {
  const inputId = ids.get(sequence)!, clientMessageId = `client-${inputId}`, acceptedEventId = `accepted-${inputId}`
  const content = inputContent(sequence), payload = { schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
    acceptedInputSequence: Number(sequence), locations: locations.get(sequence) }
  return {
    eventId: `location-${inputId}`, eventSessionId: identity.sessionId, eventTurnId: identity.turnId, eventTaskId: identity.rootTaskId,
    eventSequence: sequence + 50n, eventType: OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, eventActor: options.actor ?? "user",
    eventCorrelationId: identity.turnId, eventCausationId: acceptedEventId, eventItemId: null, eventPayload: payload,
    turnRootTaskId: identity.rootTaskId, turnUserId: identity.userId, sessionUserId: identity.userId,
    turnSource: "user", turnExecutionMode: "canonical_task_graph",
    inputId, inputSessionId: identity.sessionId, inputTurnId: identity.turnId, inputUserId: identity.userId, clientMessageId,
    delivery: "steer", status: options.status ?? "consumed", inputContent: content, acceptedSequence: sequence,
    consumedByStepId: "step-current", consumedAt: new Date(), cancelledAt: null,
    acceptedEventId, acceptedSessionId: identity.sessionId, acceptedTurnId: identity.turnId, acceptedEventSequence: sequence,
    acceptedType: "input.accepted", acceptedActor: "user", acceptedTaskId: null, acceptedCorrelationId: identity.turnId,
    acceptedCausationId: null, acceptedItemId: `item-${inputId}`,
    acceptedPayload: { clientMessageId, delivery: "steer", disposition: "steered", inputId, source: "user" },
    acceptedItemJoinedId: `item-${inputId}`, acceptedItemSessionId: identity.sessionId, acceptedItemTurnId: identity.turnId,
    acceptedItemType: "user_message", acceptedItemTaskId: null, acceptedItemStepId: null, acceptedItemStatus: "completed",
    acceptedItemPhase: "commentary", acceptedItemRevision: 0,
    acceptedItemContent: { clientMessageId, disposition: "steered", parts: content, source: "user" },
    stepId: "step-current", stepSessionId: identity.sessionId, stepTurnId: identity.turnId, stepTaskId: identity.rootTaskId,
    ordinal: 4, attempt: 2, stepStatus: "streaming", inputThroughSequence: 20n, consumedInputIds: ["input-1", "input-2"],
    duplicateCount: options.duplicateCount ?? 0,
  }
}

function request(rows: readonly unknown[] = [row(10n), row(20n)]): { input: TaskGraphConfirmedLocationBatchInput; calls: string[] } {
  const callSql: string[] = []
  const query = vi.fn(async (sql: string) => { callSql.push(sql); return { rows, rowCount: rows.length } })
  const callId = "plan-call"
  const steerInputIds = ["input-1", "input-2"]
  const receipt = { schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: identity.sessionId,
    turnId: identity.turnId, rootTaskId: identity.rootTaskId, stepId: scope.stepId,
    decision: "revise" as const, observedRevision: 1, resultingRevision: 2, steerInputIds,
    inputCheckpoint: { throughSequence: "20" } }
  const prepared = { scope, callId, decision: "revise" as const, expectedRevision: 1, resultingRevision: 2, steerInputIds,
    inputThroughSequence: 20n, idempotencyKey: steeringReconciliationIdempotencyKey(scope, callId)!, receipt }
  const reconciliation = { originalInputId: null, currentRevision: 1, decisionStepId: scope.stepId, decisionStepOrdinal: 4,
    decisionStepAttempt: scope.parentAttemptCount, decisionInputThroughSequence: 20n, agendaPlanRevision: 1,
    unresolvedInputs: [10n, 20n].map(sequence => ({ id: ids.get(sequence)!, acceptedSequence: sequence, status: "consumed" as const,
      consumedByStepId: scope.stepId, consumingOrdinal: 4 })) }
  return { input: { client: { query } as unknown as TaskGraphConfirmedLocationBatchInput["client"], scope,
    consumedThroughSequence: 20n, prepared, reconciliation }, calls: callSql }
}

describe("confirmed location steer batch", () => {
  it("rebinds every exact prepared member and selects the greatest accepted input sequence", async () => {
    const f = request()
    expect(validSteeringReconciliationScope(f.input.prepared.scope)).toBe(true)
    expect(parseSteeringReconciliationReceipt(f.input.prepared.receipt)).not.toBeNull()
    expect(parseSteeringReconciliationReceipt(f.input.prepared.receipt, f.input.prepared.scope)).not.toBeNull()
    const result = await readTaskGraphConfirmedLocationBatch(f.input)
    expect(f.calls).toHaveLength(1)
    expect(result).toMatchObject({
      kind: "confirmed", locations: ["dublin"], acceptedInputId: "input-2", acceptedInputSequence: 20n,
      acceptedInputIds: ["input-1", "input-2"], acceptedInputSequences: [10n, 20n],
    })
    expect(f.calls[0]).toContain('input."id" = ANY($5::text[])')
    expect(f.calls[0]).toContain('location_event."causationId" = accepted_event."id"')
    expect(f.calls[0]).toContain('LIMIT $6')
  })

  it.each([
    ["missing member", [row(10n)]],
    ["duplicate acceptance", [row(10n), row(20n), row(20n)]],
    ["foreign actor", [row(10n), row(20n, { actor: "system" })]],
    ["ordinary input in prepared set", [row(10n), row(20n, { status: "accepted" })]],
    ["duplicate receipt binding", [row(10n), row(20n, { duplicateCount: 1 })]],
  ])("does not coalesce a %s", async (_label, rows) => {
    await expect(readTaskGraphConfirmedLocationBatch(request(rows).input)).resolves.toEqual({ kind: "unavailable" })
  })

  it("rejects a stale prepared identity or omitted accepted member", async () => {
    const stale = request()
    const altered = { ...stale.input, prepared: { ...stale.input.prepared, scope: { ...scope, turnLeaseVersion: 1 } } }
    await expect(readTaskGraphConfirmedLocationBatch(altered)).resolves.toEqual({ kind: "unavailable" })
    const omitted = request()
    const reconciliation = { ...omitted.input.reconciliation, unresolvedInputs: omitted.input.reconciliation.unresolvedInputs.slice(0, 1) }
    await expect(readTaskGraphConfirmedLocationBatch({ ...omitted.input, reconciliation })).resolves.toEqual({ kind: "unavailable" })
  })

  it("rebinds historical members to the exact receipt cutoff and original Step order", async () => {
    const f = request()
    const input = { client: f.input.client, scope: identity, consumedThroughSequence: 30n, inputIds: ["input-1", "input-2"],
      inputThroughSequence: 20n, decisionStep: { id: "step-current", ordinal: 4, attempt: 2 } }
    await expect(readTaskGraphConfirmedLocationBatchForReceipt(input)).resolves.toMatchObject({
      kind: "confirmed", locations: ["dublin"], acceptedInputId: "input-2", acceptedInputSequence: 20n,
      acceptedInputIds: ["input-1", "input-2"], acceptedInputSequences: [10n, 20n],
    })
    await expect(readTaskGraphConfirmedLocationBatchForReceipt({ ...input,
      decisionStep: { ...input.decisionStep, ordinal: 3 } })).resolves.toEqual({ kind: "unavailable" })
    await expect(readTaskGraphConfirmedLocationBatchForReceipt({ ...input,
      decisionStep: { ...input.decisionStep, attempt: 1 } })).resolves.toEqual({ kind: "unavailable" })
  })
})
