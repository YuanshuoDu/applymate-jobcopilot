import type pg from "pg"
import type { ContextHistoryEntry } from "./context/step-context-builder.js"
import { recoverAnsweredQuestionLineage, type RecoveryInput } from "./question-answer-recovery-lineage.js"

type RecoveryClient = Pick<pg.PoolClient, "query">

/** Projects only broker-answered questions with a complete durable scope and step lineage. */
export async function recoverAnsweredQuestionHistory(
  client: RecoveryClient,
  input: RecoveryInput,
): Promise<ContextHistoryEntry[]> {
  const lineage = await recoverAnsweredQuestionLineage(client, input)
  return lineage.flatMap(item => item.entries)
}