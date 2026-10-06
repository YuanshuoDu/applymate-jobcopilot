import type { StepContextSnapshot } from "./context/step-context-builder.js"

export function withNativeVerificationFeedback(snapshot: StepContextSnapshot, feedback?: string): StepContextSnapshot {
  if (feedback === undefined) return snapshot
  if (!feedback.trim() || feedback.length > 512) throw new Error("native_verification_feedback_invalid")
  return { ...snapshot, system: [...snapshot.system, {
    id: "native-verification-recovery",
    content: `Independent review did not accept the previous root candidate. Address these verified criteria before proposing a new candidate: ${feedback}`,
  }] }
}
