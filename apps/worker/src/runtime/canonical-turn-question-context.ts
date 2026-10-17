import type { StepContextSnapshot, ContextHistoryEntry } from "./context/step-context-builder.js"
import type { PriorHistoryEntry } from "./canonical-steering-markers.js"
import type { AnsweredQuestionContext } from "./question-answer-recovery.js"

export function mergeCanonicalTurnQuestionContext(input: {
  snapshot: StepContextSnapshot
  priorHistory: readonly PriorHistoryEntry[]
  recovered: AnsweredQuestionContext
}): StepContextSnapshot {
  const { planningClarificationHistoryPair: _savedPair, ...snapshot } = input.snapshot
  const seen = new Set(input.snapshot.steerHistory.map(entry => entry.id))
  const prior = input.priorHistory.filter(entry => !seen.has(entry.id))
    .map(({ sequence: _sequence, ...entry }): ContextHistoryEntry => entry)
  return {
    ...snapshot,
    steerHistory: [...input.snapshot.steerHistory, ...prior, ...input.recovered.history],
    planningClarifications: input.recovered.planningClarifications,
    ...(input.recovered.planningClarificationHistoryPair
      ? { planningClarificationHistoryPair: input.recovered.planningClarificationHistoryPair }
      : {}),
  }
}
