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
  content: { text }, delivery, status, ...extra,
})

describe("priorConversation input disposition", () => {
  it("adds the three closed dispositions while leaving consumed and assistant content unchanged", () => {
    expect(priorConversation([
      priorInput("consumed", "follow_up", "consumed", "Consumed"),
      priorInput("cancelled", "follow_up", "cancelled", "Cancelled"),
      priorInput("rejected", "steer", "rejected", "Rejected"),
      priorInput("unconsumed", "steer", "accepted", "Unconsumed"),
      priorInput("queued-steer", "steer", "queued", "Queued steer"),
      { id: "assistant", turnId: "prior-turn", historyRole: "assistant", historySequence: "9", content: { text: "Earlier answer" } },
    ], "current-turn", null)).toEqual([
      { id: "history:user:consumed", content: { role: "user", text: "Consumed" }, sequence: 8n },
      { id: "history:user:cancelled", content: { role: "user", text: "Cancelled", priorInputDisposition: "cancelled" }, sequence: 8n },
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
      priorInput("current-turn", "steer", "cancelled", "Current", { targetTurnId: "current-turn" }),
      priorInput("before-cursor", "steer", "cancelled", "Covered", { historySequence: "4" }),
    ]

    expect(priorConversation(rows, "current-turn", 4n)).toEqual([])
    expect(statusRead).toBe(false)
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
