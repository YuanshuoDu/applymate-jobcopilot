import { describe, expect, it, vi } from "vitest"
import { formatObjectiveLocationSteerMessage, OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { readTaskGraphConfirmedLocationSteer } from "./task-graph-confirmed-location-steer.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" } as const
const inputContent = [{ type: "text", text: formatObjectiveLocationSteerMessage(["berlin", "dublin"]) }]
const receipt = { schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION, acceptedInputSequence: 10, locations: ["berlin", "dublin"] }

function event(payload: unknown = receipt) {
  return { id: "scope-event", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, sequence: 20n,
    type: OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, actor: "user", correlationId: scope.turnId, causationId: "accepted-event",
    itemId: null, payload, turnRootTaskId: scope.rootTaskId, turnUserId: scope.userId, sessionUserId: scope.userId,
    turnSource: "user", turnExecutionMode: "canonical_task_graph" }
}
function acceptedInput(overrides: Record<string, unknown> = {}) {
  return { inputId: "input-1", inputSessionId: scope.sessionId, inputTurnId: scope.turnId, inputUserId: scope.userId, clientMessageId: "client-1",
    delivery: "steer", status: "consumed", inputContent, acceptedSequence: 10n, consumedByStepId: "step-1", consumedAt: new Date(), cancelledAt: null,
    acceptedEventId: "accepted-event", acceptedSessionId: scope.sessionId, acceptedTurnId: scope.turnId, acceptedEventSequence: 10n,
    acceptedType: "input.accepted", acceptedActor: "user", acceptedTaskId: null, acceptedCorrelationId: scope.turnId, acceptedCausationId: null,
    acceptedItemId: "item-1", acceptedPayload: { clientMessageId: "client-1", delivery: "steer", disposition: "steered", inputId: "input-1", source: "user" },
    acceptedItemJoinedId: "item-1", acceptedItemSessionId: scope.sessionId, acceptedItemTurnId: scope.turnId, acceptedItemType: "user_message",
    acceptedItemTaskId: null, acceptedItemStepId: null, acceptedItemStatus: "completed", acceptedItemPhase: "commentary", acceptedItemRevision: 0,
    acceptedItemContent: { clientMessageId: "client-1", disposition: "steered", parts: inputContent, source: "user" }, ...overrides }
}
function consumerStep() {
  return { stepId: "step-1", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, ordinal: 3, attempt: 1,
    status: "completed", inputThroughSequence: 10n, consumedInputIds: ["input-1"], turnRootTaskId: scope.rootTaskId,
    turnUserId: scope.userId, sessionUserId: scope.userId }
}
function fixture(options: { latest?: unknown[]; accepted?: unknown[]; duplicate?: boolean; step?: unknown[] } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    const rows = sql.includes('FROM "agent_steps" AS step') ? options.step ?? [consumerStep()]
      : sql.includes('FROM "agent_events" AS accepted_event') ? options.accepted ?? [acceptedInput()]
        : sql.includes('event."causationId" = $4') ? options.duplicate ? [{ duplicate: 1 }] : []
          : options.latest ?? [event()]
    return { rows: rows as Record<string, unknown>[], rowCount: rows.length }
  })
  return { client: { query } as unknown as Parameters<typeof readTaskGraphConfirmedLocationSteer>[0], calls }
}

describe("task graph confirmed location steer", () => {
  it("confirms a canonical receipt bound to one owned consumed steer and root Step", async () => {
    const f = fixture()
    await expect(readTaskGraphConfirmedLocationSteer(f.client, scope, 10n)).resolves.toEqual({
      kind: "confirmed", locations: ["berlin", "dublin"], acceptedInputSequence: 10n,
    })
    expect(f.calls[0]?.sql).toContain('turn."rootTaskId" AS "turnRootTaskId"')
    expect(f.calls[0]?.sql).toContain('turn."userId" = $4 AND session."userId" = $4')
    expect(f.calls[0]?.sql).toContain('ORDER BY event."sequence" DESC LIMIT 1')
    expect(f.calls.at(-1)?.sql).toContain('step."id" = $1')
  })

  it("returns pending for a valid newer unconsumed steer without claiming it as confirmed", async () => {
    const value = { ...receipt, acceptedInputSequence: 12 }
    const f = fixture({ latest: [event(value)], accepted: [acceptedInput({ status: "accepted", acceptedSequence: 12n, acceptedEventSequence: 12n,
      consumedByStepId: null, consumedAt: null })] })
    await expect(readTaskGraphConfirmedLocationSteer(f.client, scope, 10n)).resolves.toEqual({ kind: "pending" })
    expect(f.calls.some(call => call.sql.includes('FROM "agent_steps" AS step'))).toBe(false)
  })

  it("returns absent only when no scoped acceptance exists", async () => {
    const f = fixture({ latest: [] })
    await expect(readTaskGraphConfirmedLocationSteer(f.client, scope, 10n)).resolves.toEqual({ kind: "absent" })
    expect(f.calls).toHaveLength(1)
  })

  it("does not fall back from a malformed or mismatched latest owned event", async () => {
    const malformed = { ...event({ ...receipt, extra: true }) }
    const f = fixture({ latest: [malformed] })
    await expect(readTaskGraphConfirmedLocationSteer(f.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
    expect(f.calls).toHaveLength(1)
    const mismatch = fixture({ latest: [{ ...event(), taskId: "other-root" }] })
    await expect(readTaskGraphConfirmedLocationSteer(mismatch.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
  })

  it("rejects a foreign acceptance actor or malformed receipt locations", async () => {
    for (const latest of [[{ ...event(), actor: "system" }], [{ ...event(), turnUserId: "other-user" }],
      [{ ...event(), turnExecutionMode: "legacy" }], [event({ ...receipt, locations: ["Berlin", "Dublin"] })]]) {
      const f = fixture({ latest })
      await expect(readTaskGraphConfirmedLocationSteer(f.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
    }
    const alteredScope = fixture()
    const invalidScope = { ...scope, debug: true }
    await expect(readTaskGraphConfirmedLocationSteer(alteredScope.client, invalidScope, 10n))
      .resolves.toEqual({ kind: "unavailable" })
  })

  it("rejects duplicate receipt bindings and duplicate accepted input joins", async () => {
    const duplicate = fixture({ duplicate: true })
    await expect(readTaskGraphConfirmedLocationSteer(duplicate.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
    const repeatedInput = fixture({ accepted: [acceptedInput(), acceptedInput()] })
    await expect(readTaskGraphConfirmedLocationSteer(repeatedInput.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
  })

  it("rejects item-content digest mismatches and invalid root consumer evidence", async () => {
    const digestMismatch = fixture({ accepted: [acceptedInput({ acceptedItemContent: {
      clientMessageId: "client-1", disposition: "steered", parts: [{ type: "text", text: "altered" }], source: "user",
    } })] })
    await expect(readTaskGraphConfirmedLocationSteer(digestMismatch.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
    const wrongLocations = fixture({ latest: [event({ ...receipt, locations: ["cork"] })] })
    await expect(readTaskGraphConfirmedLocationSteer(wrongLocations.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
    const cursorMismatch = fixture({ step: [{ ...consumerStep(), consumedInputIds: [], inputThroughSequence: 9n }] })
    await expect(readTaskGraphConfirmedLocationSteer(cursorMismatch.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
  })

  it("rejects an altered consumer Step id or acceptance ordering", async () => {
    const wrongStep = fixture({ step: [{ ...consumerStep(), stepId: "different-step" }] })
    await expect(readTaskGraphConfirmedLocationSteer(wrongStep.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
    const ordered = fixture({ latest: [{ ...event(), sequence: 10n }] })
    await expect(readTaskGraphConfirmedLocationSteer(ordered.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
  })

  it("rejects receipt sequence mismatch and canceled input", async () => {
    const mismatch = fixture({ accepted: [acceptedInput({ acceptedSequence: 11n })] })
    await expect(readTaskGraphConfirmedLocationSteer(mismatch.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
    const canceled = fixture({ accepted: [acceptedInput({ cancelledAt: new Date() })] })
    await expect(readTaskGraphConfirmedLocationSteer(canceled.client, scope, 10n)).resolves.toEqual({ kind: "unavailable" })
  })
})
