import { describe, expect, it } from "vitest"
import { createNativeSemanticProgressTracker, nativeSemanticNoProgressError } from "./native-semantic-progress.js"

describe("native semantic progress guard", () => {
  it("counts distinct steps for one candidate and owned control, with replay idempotence", () => {
    const guard = createNativeSemanticProgressTracker()
    const input = { candidateText: "same candidate", controlTaskId: "owned-control", stepId: "step-1" }
    expect(guard.observe(input)).toBe(false)
    expect(guard.observe(input)).toBe(false)
    expect(guard.observe({ ...input, stepId: "step-2" })).toBe(false)
    expect(guard.observe({ ...input, stepId: "step-3" })).toBe(true)
    expect(guard.observe({ ...input, stepId: "step-3" })).toBe(true)
  })

  it("resets on candidate, owned-control, or explicit new-input changes", () => {
    const guard = createNativeSemanticProgressTracker()
    expect(guard.observe({ candidateText: "candidate-a", controlTaskId: "control-a", stepId: "1" })).toBe(false)
    expect(guard.observe({ candidateText: "candidate-a", controlTaskId: "control-a", stepId: "2" })).toBe(false)
    expect(guard.observe({ candidateText: "candidate-b", controlTaskId: "control-a", stepId: "3" })).toBe(false)
    expect(guard.observe({ candidateText: "candidate-b", controlTaskId: "control-b", stepId: "4" })).toBe(false)
    expect(guard.observe({ candidateText: "candidate-b", controlTaskId: "control-b", stepId: "5" })).toBe(false)
    guard.reset()
    expect(guard.observe({ candidateText: "candidate-b", controlTaskId: "control-b", stepId: "6" })).toBe(false)
    expect(guard.observe({ candidateText: "candidate-b", controlTaskId: "control-b", stepId: "7" })).toBe(false)
  })

  it("uses a fixed safe no-progress diagnostic", () => {
    expect(nativeSemanticNoProgressError()).toMatchObject({
      code: "no_progress", reasonCode: "repeated_signature",
      observation: { signature: "native_semantic_rejection", stateFingerprint: "root_candidate" },
    })
  })
})
