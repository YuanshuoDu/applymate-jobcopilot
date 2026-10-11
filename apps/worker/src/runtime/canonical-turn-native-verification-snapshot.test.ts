import { describe, expect, it } from "vitest"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import { withNativeVerificationFeedback } from "./canonical-turn-native-verification-snapshot.js"

const snapshot: StepContextSnapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }

describe("withNativeVerificationFeedback", () => {
  it("adds only bounded safe report criteria to the next planner snapshot", () => {
    const result = withNativeVerificationFeedback(snapshot, "Independent native verification is failed. criterion=scope status=failed reason=does_not_meet_criterion.")
    expect(result.system).toHaveLength(1)
    expect(result.system[0]?.content).toContain("criterion=scope")
  })

  it("rejects feedback over the public snapshot bound", () => {
    expect(() => withNativeVerificationFeedback(snapshot, "x".repeat(513))).toThrow("native_verification_feedback_invalid")
  })
})
