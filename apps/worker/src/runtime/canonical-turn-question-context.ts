import type { StepContextSnapshot, ContextHistoryEntry } from "./context/step-context-builder.js"
import type { PriorHistoryEntry } from "./canonical-steering-markers.js"
import type { AnsweredQuestionContext } from "./question-answer-recovery.js"

function normalizeRecoveredQuestionPairs(history: readonly ContextHistoryEntry[], recovered: readonly ContextHistoryEntry[]): ContextHistoryEntry[] {
  const recoveredIds = new Set(recovered.map(entry => entry.id))
  const result = [...history]
  for (const questionId of recoveredIds) {
    if (!questionId.startsWith("agent-question:") || !questionId.endsWith(":question")) continue
    const answerId = questionId.slice(0, -":question".length) + ":answer"
    if (!recoveredIds.has(answerId)) continue
    const questionIndex = result.findIndex(entry => entry.id === questionId)
    const answerIndex = result.findIndex(entry => entry.id === answerId)
    if (questionIndex < 0 || answerIndex < 0 || answerIndex > questionIndex) continue
    const question = result.splice(questionIndex, 1)[0]!
    const answer = result.splice(answerIndex, 1)[0]!
    result.splice(answerIndex, 0, question, answer)
  }
  return result
}

export function mergeCanonicalTurnQuestionContext(input: {
  snapshot: StepContextSnapshot
  priorHistory: readonly PriorHistoryEntry[]
  recovered: AnsweredQuestionContext
}): StepContextSnapshot {
  const { planningClarificationHistoryPair: _savedPair, ...snapshot } = input.snapshot
  const steerHistory = normalizeRecoveredQuestionPairs(input.snapshot.steerHistory, input.recovered.history)
  const seen = new Set(steerHistory.map(entry => entry.id))
  const prior = input.priorHistory.filter(entry => !seen.has(entry.id))
    .map(({ sequence: _sequence, ...entry }): ContextHistoryEntry => { seen.add(entry.id); return entry })
  const recovered = input.recovered.history.filter(entry => !seen.has(entry.id))
  return {
    ...snapshot,
    steerHistory: [...steerHistory, ...prior, ...recovered],
    planningClarifications: input.recovered.planningClarifications,
    ...(input.recovered.planningClarificationHistoryPair
      ? { planningClarificationHistoryPair: input.recovered.planningClarificationHistoryPair }
      : {}),
  }
}
