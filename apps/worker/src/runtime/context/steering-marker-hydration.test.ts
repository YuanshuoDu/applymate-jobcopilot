import { describe, expect, it } from "vitest"

import { InputClaimStoreError, type StoredAgentInput } from "./input-claim-store.js"
import { activeMarkerInputIds, assertHydratedSteeringInputs, mergeSteeringInputs } from "./steering-marker-hydration.js"
import { steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "./steering-marker.js"

const marker = (inputId = "input-1"): SteeringMarkerPayload => ({
  schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
  stepId: "step-1", inputId, idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", inputId), obligationId: "obligation-1", goalRevision: 1, planRevision: 1, acceptedSequence: "2",
})
const input = (id: string, sequence: bigint, status: StoredAgentInput["status"] = "consumed"): StoredAgentInput => ({
  id, sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: id, delivery: "steer", status, content: [{ type: "text", text: id }], acceptedSequence: sequence,
  consumedByStepId: status === "consumed" ? "old-step" : null, consumedAt: status === "consumed" ? new Date() : null, createdAt: new Date(),
})

describe("steering marker hydration helpers", () => {
  it("sorts marker IDs and merges hydrated inputs without checkpoint duplication", () => {
    const scope = { sessionId: "session-1", turnId: "turn-1", taskId: "task-1" }
    expect(activeMarkerInputIds([marker("input-2"), marker("input-1")], undefined, scope)).toEqual(["input-1", "input-2"])
    const merged = mergeSteeringInputs([input("new", 4n)], [input("old", 2n)])
    expect(merged.map(value => value.id)).toEqual(["old", "new"])
  })

  it("rejects a marker outside the fenced session, Turn, or task", () => {
    expect(() => activeMarkerInputIds([marker()], undefined, { sessionId: "session-x", turnId: "turn-1", taskId: "task-1" })).toThrow(InputClaimStoreError)
    expect(() => activeMarkerInputIds([marker()], undefined, { sessionId: "session-1", turnId: "turn-1", taskId: "task-x" })).toThrow(InputClaimStoreError)
  })

  it("rejects root, duplicate, malformed, and unconsumed marker inputs", () => {
    expect(() => activeMarkerInputIds([marker("root")], "root")).toThrow(InputClaimStoreError)
    expect(() => activeMarkerInputIds([marker(), marker()])).toThrow(InputClaimStoreError)
    expect(() => assertHydratedSteeringInputs(["input-1"], [input("input-1", 1n, "accepted")])).toThrow(InputClaimStoreError)
  })
})
