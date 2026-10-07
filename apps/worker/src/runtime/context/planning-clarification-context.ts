import type { TurnQuestionPlanningSummary } from "../turns/turn-question-planning-contract.js"
import type { ContextBlock, ContextHistoryEntry } from "./step-context-builder.js"

export type PlanningClarificationHistoryPair = Readonly<{ questionEntryId: string; answerEntryId: string }>

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validSequence(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false
  try { return BigInt(value) <= 9_223_372_036_854_775_807n } catch { return false }
}

function safeSummary(value: TurnQuestionPlanningSummary): TurnQuestionPlanningSummary {
  if (!(value.observedPlanRevision === null || validRevision(value.observedPlanRevision))
    || !validRevision(value.graphRevisionAtAsk)
    || !Number.isSafeInteger(value.pendingSteerCount) || value.pendingSteerCount < 0
    || !Number.isSafeInteger(value.unconsumedSteerCount) || value.unconsumedSteerCount < 0
    || value.unconsumedSteerCount > value.pendingSteerCount
    || !validSequence(value.inputThroughSequence)) throw new Error("planning_clarification_summary_invalid")
  return {
    observedPlanRevision: value.observedPlanRevision,
    graphRevisionAtAsk: value.graphRevisionAtAsk,
    pendingSteerCount: value.pendingSteerCount,
    unconsumedSteerCount: value.unconsumedSteerCount,
    inputThroughSequence: value.inputThroughSequence,
  }
}

/** Renders the safe latest-question projection separately from untrusted Q/A history. */
export function planningClarificationContext(
  values: readonly TurnQuestionPlanningSummary[] = [],
  history: readonly ContextHistoryEntry[] = [],
  pair?: PlanningClarificationHistoryPair,
): {
  summaries: readonly TurnQuestionPlanningSummary[]
  blocks: readonly ContextBlock[]
  afterAnswerEntryId?: string
} {
  if (values.length > 1) throw new Error("planning_clarification_latest_only")
  const candidates = values.map(safeSummary)
  if (candidates.length === 0 || !pair || typeof pair.questionEntryId !== "string" || !pair.questionEntryId.trim()
    || typeof pair.answerEntryId !== "string" || !pair.answerEntryId.trim()) return { summaries: [], blocks: [] }
  const questions = history.flatMap((entry, index) => entry.id === pair.questionEntryId ? [index] : [])
  const answers = history.flatMap((entry, index) => entry.id === pair.answerEntryId ? [index] : [])
  const questionIndex = questions[0]
  const answerIndex = answers[0]
  if (questions.length !== 1 || answers.length !== 1 || questionIndex === undefined || answerIndex === undefined
    || answerIndex !== questionIndex + 1) return { summaries: [], blocks: [] }
  const question = questionIndex === undefined ? null : history[questionIndex]?.content
  const answer = answerIndex === undefined ? null : history[answerIndex]?.content
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  if (!isRecord(question) || question.role !== "assistant" || question.type !== "question"
    || !isRecord(answer) || answer.role !== "user" || answer.type !== "answer") return { summaries: [], blocks: [] }
  const summaries = candidates
  return {
    summaries,
    afterAnswerEntryId: pair.answerEntryId,
    blocks: summaries.map(summary => ({
      id: "planning-clarification:latest-answered-question",
      layer: "steer_history",
      role: "data",
      trust: "internal_record",
      source: "native_question_recovery",
      content: summary,
    })),
  }
}
