import { describe, expect, it } from "vitest"

import {
  CanonicalSteeringMarkerError,
  emptySteeringMarkerState,
  priorConversation,
  restoreCanonicalSteeringMarkers,
} from "./canonical-steering-markers.js"
import { STEERING_MARKER_EVENT_TYPE, steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "./context/steering-marker.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" } as const
const payload = (kind: "observed" | "applied" = "observed"): SteeringMarkerPayload => ({
  schemaVersion: "agent-harness.steering-marker.v1", kind, status: kind, sessionId: scope.sessionId, turnId: scope.turnId,
  taskId: scope.rootTaskId, stepId: "step-1", inputId: "input-1", idempotencyKey: steeringMarkerIdempotencyKey(scope.sessionId, scope.turnId, "input-1"),
  obligationId: "obligation-1", goalRevision: 1, planRevision: 1, acceptedSequence: "4",
})
const event = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "event-1", type: STEERING_MARKER_EVENT_TYPE, actor: "system", userId: scope.userId, sessionId: scope.sessionId,
  turnId: scope.turnId, taskId: scope.rootTaskId, sequence: "4", payload: payload(), ...overrides,
})

const priorInput = (id: string, delivery: unknown, status: unknown, text = id, extra: Record<string, unknown> = {}) => ({
  id, targetTurnId: "prior-turn", historyRole: "user", acceptedSequence: "8", historySequence: "8",
  content: { text }, delivery, status, consumedByStepId: null, consumedAt: null, cancelledAt: null, ...extra,
})

describe("priorConversation input disposition", () => {
  it("adds the three closed dispositions while leaving consumed and assistant content unchanged", () => {
    expect(priorConversation([
      priorInput("consumed", "follow_up", "consumed", "Consumed", { consumedByStepId: "step-1", consumedAt: new Date("2026-10-07T00:00:00.000Z") }),
      priorInput("cancelled", "follow_up", "cancelled", "Cancelled after consumption", {
        consumedByStepId: "step-2", consumedAt: new Date("2026-10-07T00:00:00.000Z"), cancelledAt: new Date("2026-10-08T00:00:00.000Z"),
      }),
      priorInput("cancelled-unconsumed", "follow_up", "cancelled", "Cancelled before consumption", { cancelledAt: new Date("2026-10-08T00:00:00.000Z") }),
      priorInput("rejected", "steer", "rejected", "Rejected"),
      priorInput("unconsumed", "steer", "accepted", "Unconsumed"),
      priorInput("queued-steer", "steer", "queued", "Queued steer"),
      { id: "assistant", turnId: "prior-turn", historyRole: "assistant", historySequence: "9", content: { text: "Earlier answer" } },
    ], "current-turn", null)).toEqual([
      { id: "history:user:consumed", content: { role: "user", text: "Consumed" }, sequence: 8n },
      { id: "history:user:cancelled", content: { role: "user", text: "Cancelled after consumption", priorInputDisposition: "cancelled" }, sequence: 8n },
      { id: "history:user:cancelled-unconsumed", content: { role: "user", text: "Cancelled before consumption", priorInputDisposition: "cancelled" }, sequence: 8n },
      { id: "history:user:rejected", content: { role: "user", text: "Rejected", priorInputDisposition: "rejected" }, sequence: 8n },
      { id: "history:user:unconsumed", content: { role: "user", text: "Unconsumed", priorInputDisposition: "not_consumed" }, sequence: 8n },
      { id: "history:user:queued-steer", content: { role: "user", text: "Queued steer", priorInputDisposition: "not_consumed" }, sequence: 8n },
      { id: "history:assistant:assistant", content: { role: "assistant", text: "Earlier answer" }, sequence: 9n },
    ])
  })

  it("omits unknown, missing, and pending follow-up lifecycle rows without reading accessors", () => {
    let statusRead = false
    const accessor = priorInput("accessor", "steer", "cancelled")
    Object.defineProperty(accessor, "status", { enumerable: true, get: () => { statusRead = true; return "cancelled" } })
    const inherited = Object.assign(Object.create({ delivery: "steer", status: "cancelled" }), {
      id: "inherited", targetTurnId: "prior-turn", historyRole: "user", historySequence: "8", content: { text: "Inherited" },
    }) as Record<string, unknown>
    const rows = [
      priorInput("pending-follow-up", "follow_up", "accepted"),
      priorInput("queued-follow-up", "follow_up", "queued"),
      priorInput("unknown-delivery", "other", "cancelled"),
      priorInput("unknown-status", "steer", "pending"),
      priorInput("missing-status", "steer", undefined),
      priorInput("missing-delivery", undefined, "cancelled"),
      accessor,
      inherited,
      priorInput("current-turn", "follow_up", "cancelled", "Current", { targetTurnId: "current-turn", cancelledAt: new Date("2026-10-08T00:00:00.000Z") }),
      priorInput("before-cursor", "follow_up", "cancelled", "Covered", { historySequence: "4", cancelledAt: new Date("2026-10-08T00:00:00.000Z") }),
    ]

    expect(priorConversation(rows, "current-turn", 4n)).toEqual([])
    expect(statusRead).toBe(false)
  })

  it.each([
    ["accepted", "consumedByStepId", "step-1"],
    ["accepted", "consumedAt", new Date("2026-10-07T00:00:00.000Z")],
    ["accepted", "cancelledAt", new Date("2026-10-07T00:00:00.000Z")],
    ["queued", "consumedByStepId", "step-1"],
    ["queued", "consumedAt", new Date("2026-10-07T00:00:00.000Z")],
    ["queued", "cancelledAt", new Date("2026-10-07T00:00:00.000Z")],
  ] as const)("omits %s steering when %s is non-null", (status, marker, markerValue) => {
    expect(priorConversation([
      priorInput("contradictory", "steer", status, "Contradictory lifecycle", { [marker]: markerValue }),
    ], "current-turn", null)).toEqual([])
  })

  it.each([
    ["consumed without a consumer", "steer", "consumed", { consumedAt: new Date("2026-10-07T00:00:00.000Z") }],
    ["consumed without a timestamp", "follow_up", "consumed", { consumedByStepId: "step-1" }],
    ["consumed with an invalid timestamp", "steer", "consumed", { consumedByStepId: "step-1", consumedAt: "2026-10-07T00:00:00.000Z" }],
    ["consumed with an invalid Date", "steer", "consumed", { consumedByStepId: "step-1", consumedAt: new Date(Number.NaN) }],
    ["consumed with a cancellation marker", "follow_up", "consumed", { consumedByStepId: "step-1", consumedAt: new Date("2026-10-07T00:00:00.000Z"), cancelledAt: new Date("2026-10-08T00:00:00.000Z") }],
    ["steer cancelled", "steer", "cancelled", { cancelledAt: new Date("2026-10-08T00:00:00.000Z") }],
    ["cancelled without a timestamp", "follow_up", "cancelled", {}],
    ["cancelled with an invalid timestamp", "follow_up", "cancelled", { cancelledAt: "2026-10-08T00:00:00.000Z" }],
    ["cancelled with an invalid Date", "follow_up", "cancelled", { cancelledAt: new Date(Number.NaN) }],
    ["cancelled with only a consumer", "follow_up", "cancelled", { consumedByStepId: "step-1", cancelledAt: new Date("2026-10-08T00:00:00.000Z") }],
    ["cancelled with only a consumption time", "follow_up", "cancelled", { consumedAt: new Date("2026-10-07T00:00:00.000Z"), cancelledAt: new Date("2026-10-08T00:00:00.000Z") }],
    ["rejected with a consumer", "steer", "rejected", { consumedByStepId: "step-1" }],
    ["rejected with a consumption time", "follow_up", "rejected", { consumedAt: new Date("2026-10-07T00:00:00.000Z") }],
    ["rejected with a cancellation time", "follow_up", "rejected", { cancelledAt: new Date("2026-10-08T00:00:00.000Z") }],
  ] as const)("omits %s lifecycle", (_name, delivery, status, extra) => {
    expect(priorConversation([
      priorInput("malformed", delivery, status, "Malformed lifecycle", extra),
    ], "current-turn", null)).toEqual([])
  })

  const invalidConsumerIds = [
    ["empty", ""],
    ["whitespace-only", "   "],
    ["untrimmed", " step-1 "],
    ["control character", "step\u0001id"],
    ["DEL character", "step\u007fid"],
    ["over 256 characters", "x".repeat(257)],
  ] as const

  it.each(invalidConsumerIds)("omits consumed input with %s consumer id", (_name, consumedByStepId) => {
    expect(priorConversation([
      priorInput("invalid-consumer", "steer", "consumed", "Invalid consumer", {
        consumedByStepId, consumedAt: new Date("2026-10-07T00:00:00.000Z"),
      }),
    ], "current-turn", null)).toEqual([])
  })

  it.each(invalidConsumerIds)("omits consumed-then-cancelled follow-up with %s consumer id", (_name, consumedByStepId) => {
    expect(priorConversation([
      priorInput("invalid-cancelled-consumer", "follow_up", "cancelled", "Invalid cancellation consumer", {
        consumedByStepId, consumedAt: new Date("2026-10-07T00:00:00.000Z"), cancelledAt: new Date("2026-10-08T00:00:00.000Z"),
      }),
    ], "current-turn", null)).toEqual([])
  })
})

describe("restoreCanonicalSteeringMarkers", () => {
  it("restores an observed/applied pair without exposing an active marker", () => {
    const applied = event({ id: "event-2", sequence: "5", payload: payload("applied") })
    const state = restoreCanonicalSteeringMarkers([event(), applied], scope)
    expect(state.active).toEqual([])
    expect(state.observed).toHaveLength(1)
    expect(state.applied).toHaveLength(1)
  })

  it("keeps an active marker and returns fresh empty state without a root task", () => {
    expect(restoreCanonicalSteeringMarkers([event()], scope).active).toHaveLength(1)
    expect(restoreCanonicalSteeringMarkers([event({ taskId: "child-1" })], { ...scope, rootTaskId: null })).toEqual(emptySteeringMarkerState())
  })

  it.each([
    ["foreign actor", { actor: "user" }],
    ["foreign user", { userId: "user-2" }],
    ["foreign task", { taskId: "child-1" }],
    ["orphan applied", { payload: payload("applied") }],
    ["sequence before accepted", { sequence: "3" }],
    ["unknown payload", { payload: { ...payload(), extra: true } }],
  ])("fails closed for %s", (_name, overrides) => {
    expect(() => restoreCanonicalSteeringMarkers([event(overrides)], scope)).toThrow(CanonicalSteeringMarkerError)
  })

  it("rejects conflicting duplicate event ids and malformed marker envelopes", () => {
    expect(() => restoreCanonicalSteeringMarkers([event(), event({ payload: { ...payload(), stepId: "step-2" } })], scope)).toThrow("steering_marker_state_invalid")
    expect(() => restoreCanonicalSteeringMarkers([event({ extra: true })], scope)).toThrow("steering_marker_state_invalid")
  })

  it("accepts exact duplicate replay and rejects sequence collisions", () => {
    expect(restoreCanonicalSteeringMarkers([event(), event()], scope).observed).toHaveLength(1)
    expect(() => restoreCanonicalSteeringMarkers([event(), event({ id: "event-2" })], scope)).toThrow("steering_marker_state_invalid")
  })
})
