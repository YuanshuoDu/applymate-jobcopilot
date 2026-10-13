import type pg from "pg"
import type { ContextHistoryEntry } from "./context/step-context-builder.js"
import { recoverAnsweredQuestionLineage, type RecoveryInput } from "./question-answer-recovery-lineage.js"
import { recoverPriorRootQuestionHistory } from "./question-answer-prior-history.js"

type RecoveryClient = Pick<pg.PoolClient, "query">

/** Projects only broker-answered questions with a complete durable scope and step lineage. */
export async function recoverAnsweredQuestionHistory(
  client: RecoveryClient,
  input: RecoveryInput,
): Promise<ContextHistoryEntry[]> {
  const lineage = await recoverAnsweredQuestionLineage(client, input)
  const current = lineage.flatMap(item => item.entries)
  const prior = await recoverPriorRootQuestionHistory(client, { ...input, existingHistory: [...input.existingHistory, ...current] })
  return [...prior, ...current]
}
