import { describe, expect, it } from "vitest"

import {
  STEERING_MARKER_EVENT_TYPE,
  STEERING_MARKER_MAX_EVENTS,
  parseSteeringMarkerPayload,
  reduceSteeringMarkers,
  steeringMarkerIdempotencyKey,
  type SteeringMarkerEvent,
  type SteeringMarkerPayload,
  type SteeringMarkerScope,
} from "./steering-marker.js"

const scope: SteeringMarkerScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "task-1" }
function payload(inputId = "input-1", status: "observed" | "applied" = "observed", stepId = "step-1"): SteeringMarkerPayload {
  return {
    schemaVersion: "agent-harness.steering-marker.v1", kind: status, status, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.taskId, stepId, inputId, idempotencyKey: steeringMarkerIdempotencyKey(scope.sessionId, scope.turnId, inputId),
    obligationId: "obligation-1", goalRevision: 2, planRevision: 3, acceptedSequence: "4",
  }
}
function event(id: string, sequence: string, marker: SteeringMarkerPayload, changes: Partial<SteeringMarkerEvent> = {}): SteeringMarkerEvent {
  return { id, type: STEERING_MARKER_EVENT_TYPE, actor: "system", ...scope, sequence, payload: marker, ...changes }
}
function valid(events: readonly SteeringMarkerEvent[]) {
  const result = reduceSteeringMarkers(events, scope)
  expect(result.valid).toBe(true)
  if (!result.valid) throw new Error(result.reason)
  return result.state
}

describe("steering marker payload", () => {
  it("parses a canonical observed marker and rejects unknown or nested data", () => {
    const marker = payload()
    expect(parseSteeringMarkerPayload(marker)).toEqual(marker)
    expect(parseSteeringMarkerPayload({ ...marker, extra: true })).toBeNull()
    expect(parseSteeringMarkerPayload({ ...marker, obligationId: { id: "nested" } })).toBeNull()
    expect(parseSteeringMarkerPayload({ ...marker, acceptedSequence: "01" })).toBeNull()
    expect(parseSteeringMarkerPayload({ ...marker, inputId: "secret: value" })).toBeNull()
  })

  it("requires matching lifecycle fields and a derived key", () => {
    const marker = payload()
    expect(parseSteeringMarkerPayload({ ...marker, status: "applied" })).toBeNull()
    expect(parseSteeringMarkerPayload({ ...marker, idempotencyKey: "only-input-1" })).toBeNull()
    expect(parseSteeringMarkerPayload({ ...marker, goalRevision: 0 })).toBeNull()
    expect(parseSteeringMarkerPayload({ ...marker, planRevision: "3" })).toBeNull()
  })
})

describe("steering marker reducer", () => {
  it("folds observed, applied, and active markers", () => {
    const state = valid([event("e2", "6", payload("input-2")), event("e1", "4", payload()) , event("e3", "7", payload("input-1", "applied", "step-2"))])
    expect(state.observed.map(item => item.inputId)).toEqual(["input-1", "input-2"])
    expect(state.applied.map(item => item.inputId)).toEqual(["input-1"])
    expect(state.active.map(item => item.inputId)).toEqual(["input-2"])
  })

  it("is deterministic for exact replay and repeated input across steps", () => {
    const first = event("e1", "4", payload())
    const replayed = valid([event("e2", "6", payload("input-2", "observed", "step-2")), first, first, event("e3", "8", payload("input-1", "observed", "step-2"))])
    const reordered = valid([event("e3", "8", payload("input-1", "observed", "step-2")), event("e2", "6", payload("input-2", "observed", "step-2")), first])
    expect(replayed).toEqual(reordered)
    expect(replayed.active).toHaveLength(2)
  })

  it("fails closed for conflicting, orphan, and out-of-order lifecycle evidence", () => {
    const observed = event("e1", "4", payload())
    expect(reduceSteeringMarkers([observed, event("e2", "5", payload("input-1", "observed", "other-step"), { payload: { ...payload(), acceptedSequence: "5" } })], scope).valid).toBe(false)
    expect(reduceSteeringMarkers([event("e2", "3", { ...payload("input-1", "applied"), acceptedSequence: "3" }), observed], scope)).toMatchObject({ valid: false, reason: "orphan_applied" })
    expect(reduceSteeringMarkers([event("e2", "5", payload("input-2", "applied")), event("e3", "6", payload())], scope)).toMatchObject({ valid: false, reason: "orphan_applied" })
  })

  it("rejects foreign scope, future sequence, duplicate sequence, and oversized input", () => {
    const marker = payload()
    expect(reduceSteeringMarkers([event("foreign", "4", marker, { userId: "user-2" })], scope)).toMatchObject({ valid: false, reason: "invalid_event" })
    expect(reduceSteeringMarkers([event("future", "4", { ...marker, acceptedSequence: "5" })], scope)).toMatchObject({ valid: false, reason: "invalid_event" })
    expect(reduceSteeringMarkers([event("e1", "4", marker), event("e2", "4", payload("input-2"))], scope)).toMatchObject({ valid: false, reason: "sequence_conflict" })
    const many = Array.from({ length: STEERING_MARKER_MAX_EVENTS + 1 }, (_, index) => event(`e-${index}`, String(index + 4), payload(`input-${index}`)))
    expect(reduceSteeringMarkers(many, scope)).toMatchObject({ valid: false, reason: "event_limit" })
    const large = Array.from({ length: 80 }, (_, index) => event("e".repeat(80) + index, String(index + 4), payload("input-" + "x".repeat(80) + index)))
    expect(reduceSteeringMarkers(large, scope)).toMatchObject({ valid: false, reason: "byte_limit" })
  })

  it("enforces a bounded replay cursor", () => {
    expect(reduceSteeringMarkers([event("e1", "4", payload())], scope, { throughSequence: "3" })).toMatchObject({ valid: false, reason: "invalid_event" })
    expect(reduceSteeringMarkers([event("e1", "4", payload())], scope, { throughSequence: "01" })).toMatchObject({ valid: false, reason: "invalid_through_sequence" })
    expect(valid([event("e1", "4", payload())])).toHaveProperty("active")
  })
})
