import { isDeepStrictEqual } from "node:util"
import type pg from "pg"

import { mergeCanonicalTurnQuestionContext } from "../canonical-turn-question-context.js"
import type { PriorHistoryEntry } from "../canonical-steering-markers.js"
import { recoverAnsweredQuestionContext } from "../question-answer-recovery.js"
import type { ContextHistoryEntry, StepContextSnapshot } from "../context/step-context-builder.js"
import type { TurnLease } from "./lease.js"

type RecoveryClient = Pick<pg.PoolClient, "query">
type EntryContent = Record<string, unknown>
const QUESTION_HISTORY_PREFIX = "agent-question:"

function content(entry: ContextHistoryEntry): EntryContent | null {
  return entry.content && typeof entry.content === "object" && !Array.isArray(entry.content)
    ? entry.content as EntryContent : null
}

function pairBase(entry: ContextHistoryEntry, suffix: "question" | "answer"): string | null {
  const ending = `:${suffix}`
  const base = entry.id.startsWith(QUESTION_HISTORY_PREFIX) && entry.id.endsWith(ending)
    ? entry.id.slice(0, -ending.length) : ""
  return base.length > QUESTION_HISTORY_PREFIX.length ? base : null
}

/** Rechecks receipt-backed Q/A pairs against persisted entries before restoring their presentation order. */
export function reconcileRecoveredQuestionHistory(
  snapshotHistory: readonly ContextHistoryEntry[],
  recoveredHistory: readonly ContextHistoryEntry[],
): { snapshotHistory: ContextHistoryEntry[]; historyToAppend: ContextHistoryEntry[] } {
  if (recoveredHistory.length % 2 !== 0) throw new Error("question_recovery_history_pair_invalid")
  const recoveredById = new Map<string, ContextHistoryEntry>()
  const pairs: [ContextHistoryEntry, ContextHistoryEntry][] = []
  for (let index = 0; index < recoveredHistory.length; index += 2) {
    const question = recoveredHistory[index]!, answer = recoveredHistory[index + 1]!
    const questionContent = content(question), answerContent = content(answer)
    const questionBase = pairBase(question, "question"), answerBase = pairBase(answer, "answer")
    if (!questionBase || questionBase !== answerBase || !questionContent || !answerContent
      || questionContent.role !== "assistant" || questionContent.type !== "question"
      || answerContent.role !== "user" || answerContent.type !== "answer"
      || recoveredById.has(question.id) || recoveredById.has(answer.id)) {
      throw new Error("question_recovery_history_pair_invalid")
    }
    recoveredById.set(question.id, question)
    recoveredById.set(answer.id, answer)
    pairs.push([question, answer])
  }
  for (const persisted of snapshotHistory) {
    const recovered = recoveredById.get(persisted.id)
    if (recovered && !isDeepStrictEqual(persisted.content, recovered.content)) {
      throw new Error("question_recovery_history_collision")
    }
  }
  // Snapshot order is canonical by ID; only the validated recovery sequence carries Q/A chronology.
  return {
    snapshotHistory: snapshotHistory.filter(entry => !recoveredById.has(entry.id)),
    historyToAppend: pairs.flatMap(pair => pair),
  }
}

/** Snapshot ID ordering is canonical; omit its Q/A IDs only while lineage validates their chronology. */
function historyForQuestionRecovery(history: readonly ContextHistoryEntry[]): ContextHistoryEntry[] {
  return history.filter(entry => !entry.id.startsWith(QUESTION_HISTORY_PREFIX))
}

export async function recoverCanonicalTurnQuestionContext(input: {
  client: RecoveryClient
  lease: Pick<TurnLease, "userId" | "sessionId" | "turnId">
  rootTaskId: string | null
  steps: readonly Record<string, unknown>[]
  toolItems: readonly Record<string, unknown>[]
  snapshot: StepContextSnapshot
  priorHistory: readonly PriorHistoryEntry[]
}): Promise<StepContextSnapshot> {
  const recovered = await recoverAnsweredQuestionContext(input.client, {
    lease: input.lease, rootTaskId: input.rootTaskId, steps: input.steps, toolItems: input.toolItems,
    existingHistory: historyForQuestionRecovery(input.snapshot.steerHistory), maxQuestions: 64,
  })
  const reconciled = reconcileRecoveredQuestionHistory(input.snapshot.steerHistory, recovered.history)
  return mergeCanonicalTurnQuestionContext({
    snapshot: { ...input.snapshot, steerHistory: reconciled.snapshotHistory }, priorHistory: input.priorHistory,
    recovered: { ...recovered, history: reconciled.historyToAppend },
  })
}
