import type pg from "pg"
import type { ContextHistoryEntry } from "./context/step-context-builder.js"
import { recoverAnsweredQuestionLineage, type QuestionAnswerLineage, type RecoveryInput } from "./question-answer-recovery-lineage.js"
import { recoverPriorRootQuestionHistory } from "./question-answer-prior-history.js"
import type { TurnQuestionPlanningSummary } from "./turns/turn-question-planning-contract.js"
import { readTurnQuestionPlanningHistory } from "./turns/turn-question-planning-history.js"
import type { PlanningClarificationHistoryPair } from "./context/planning-clarification-context.js"

type RecoveryClient = Pick<pg.PoolClient, "query">

export type AnsweredQuestionContext = Readonly<{
  history: ContextHistoryEntry[]
  planningClarifications: readonly TurnQuestionPlanningSummary[]
  planningClarificationHistoryPair?: PlanningClarificationHistoryPair
}>

function latestQuestionByDurableOrder(lineage: readonly QuestionAnswerLineage[], input: RecoveryInput): QuestionAnswerLineage | undefined {
  const stepOrder = new Map(input.steps.map((step, index) => [step.id, index]))
  const callOrder = new Map(input.toolItems.filter(item => item.type === "tool_call")
    .map((item, index) => {
      const content = item.content && typeof item.content === "object" && !Array.isArray(item.content)
        ? item.content as Record<string, unknown> : {}
      return [content.toolCallId, index] as const
    }))
  return lineage.reduce<QuestionAnswerLineage | undefined>((latest, candidate) => {
    const candidateStep = stepOrder.get(candidate.stepId)
    const candidateCall = callOrder.get(candidate.toolCallId)
    if (candidateStep === undefined || candidateCall === undefined) throw new Error("question_recovery_order_invalid")
    if (!latest) return candidate
    const latestStep = stepOrder.get(latest.stepId)
    const latestCall = callOrder.get(latest.toolCallId)
    if (latestStep === undefined || latestCall === undefined) throw new Error("question_recovery_order_invalid")
    return candidateStep > latestStep || (candidateStep === latestStep && candidateCall > latestCall) ? candidate : latest
  }, undefined)
}

/** Keeps safe planning metadata separate and linked only to the latest answered Q/A lineage. */
export async function recoverAnsweredQuestionContext(
  client: RecoveryClient,
  input: RecoveryInput,
): Promise<AnsweredQuestionContext> {
  const lineage = await recoverAnsweredQuestionLineage(client, input)
  const current = lineage.flatMap(item => item.entries)
  const prior = await recoverPriorRootQuestionHistory(client, { ...input, existingHistory: [...input.existingHistory, ...current] })
  const latest = latestQuestionByDurableOrder(lineage, input)
  let planningClarifications: readonly TurnQuestionPlanningSummary[] = []
  let planningClarificationHistoryPair: PlanningClarificationHistoryPair | undefined
  if (latest && input.rootTaskId) {
    const questionItemId = latest.item.id
    if (typeof questionItemId !== "string" || !questionItemId.trim()) throw new Error("question_recovery_item_id_invalid")
    const summaries = await readTurnQuestionPlanningHistory(client, {
      userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId, rootTaskId: input.rootTaskId,
    }, [{ stepId: latest.stepId, toolCallId: latest.toolCallId, waitId: latest.questionId, questionItemId }])
    if (summaries.length > 1) throw new Error("question_recovery_planning_summary_ambiguous")
    planningClarifications = summaries
    if (summaries.length === 1) planningClarificationHistoryPair = {
      questionEntryId: `agent-question:${questionItemId}:question`,
      answerEntryId: `agent-question:${questionItemId}:answer`,
    }
  }
  return { history: [...prior, ...current], planningClarifications, ...(planningClarificationHistoryPair ? { planningClarificationHistoryPair } : {}) }
}

/** Compatibility projection for callers that need only the historical Q/A blocks. */
export async function recoverAnsweredQuestionHistory(
  client: RecoveryClient,
  input: RecoveryInput,
): Promise<ContextHistoryEntry[]> {
  return (await recoverAnsweredQuestionContext(client, input)).history
}
