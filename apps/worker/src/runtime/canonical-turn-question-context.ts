import type { StepContextSnapshot, ContextHistoryEntry } from "./context/step-context-builder.js"
import type { PriorHistoryEntry } from "./canonical-steering-markers.js"
import type { AnsweredQuestionContext } from "./question-answer-recovery.js"

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => same(value, right[index]))
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && same(leftRecord[key], rightRecord[key]))
}

function normalizeRecoveredQuestionPairs(history: readonly ContextHistoryEntry[], recovered: readonly ContextHistoryEntry[]): ContextHistoryEntry[] {
  const recoveredById = new Map(recovered.map(entry => [entry.id, entry]))
  const locatedPairs: { slot: number; question: ContextHistoryEntry; answer: ContextHistoryEntry }[] = []
  const pairedIds = new Set<string>()
  const seenPairs = new Set<string>()

  for (const question of recovered) {
    const questionId = question.id
    if (!questionId.startsWith("agent-question:") || !questionId.endsWith(":question") || seenPairs.has(questionId)) continue
    const answerId = questionId.slice(0, -":question".length) + ":answer"
    const answer = recoveredById.get(answerId)
    if (!answer) continue
    seenPairs.add(questionId)
    const questionIndexes = history.flatMap((entry, index) => entry.id === questionId ? [index] : [])
    const answerIndexes = history.flatMap((entry, index) => entry.id === answerId ? [index] : [])
    if (questionIndexes.length > 1 || answerIndexes.length > 1) throw new Error("question_recovery_history_duplicate")
    if (answerIndexes.length && !questionIndexes.length) throw new Error("question_recovery_history_pair_incomplete")
    if (questionIndexes.length && !same(history[questionIndexes[0]!]!.content, question.content)
      || answerIndexes.length && !same(history[answerIndexes[0]!]!.content, answer.content)) {
      throw new Error("question_recovery_history_collision")
    }
    if (!questionIndexes.length) continue
    const slot = Math.min(questionIndexes[0]!, answerIndexes[0] ?? questionIndexes[0]!)
    locatedPairs.push({ slot, question, answer })
    pairedIds.add(questionId)
    pairedIds.add(answerId)
  }

  const slots = new Map<number, { question: ContextHistoryEntry; answer: ContextHistoryEntry }>()
  const orderedSlots = locatedPairs.map(pair => pair.slot).sort((left, right) => left - right)
  locatedPairs.forEach((pair, index) => slots.set(orderedSlots[index]!, pair))
  const result: ContextHistoryEntry[] = []
  history.forEach((entry, index) => {
    const pair = slots.get(index)
    if (pair) result.push(pair.question, pair.answer)
    if (!pairedIds.has(entry.id)) result.push(entry)
  })
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
