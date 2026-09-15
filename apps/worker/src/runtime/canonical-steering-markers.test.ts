import { describe, expect, it } from "vitest"

import {
  CanonicalSteeringMarkerError,
  emptySteeringMarkerState,
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
