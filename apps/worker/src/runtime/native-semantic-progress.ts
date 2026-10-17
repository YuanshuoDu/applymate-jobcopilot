import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import { NoProgressError } from "./progress.js"

export type NativeSemanticProgressTracker = Readonly<{
  observe(input: Readonly<{ candidateText: string; controlTaskId: string; stepId: string }>): boolean
  reset(): void
}>

/** Tracks only opaque per-runtime repeats; neither the key nor its count escapes. */
export function createNativeSemanticProgressTracker(): NativeSemanticProgressTracker {
  let key: string | undefined
  let steps = new Set<string>()
  return {
    observe(input) {
      const nextKey = `${digestNativeVerificationValue(input.candidateText)}\u0000${input.controlTaskId}`
      if (nextKey !== key) { key = nextKey; steps = new Set() }
      steps.add(input.stepId)
      return steps.size >= 3
    },
    reset() { key = undefined; steps = new Set() },
  }
}

export function nativeSemanticNoProgressError(): NoProgressError {
  return new NoProgressError({ signature: "native_semantic_rejection", stateFingerprint: "root_candidate" })
}
