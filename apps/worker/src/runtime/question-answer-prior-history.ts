import { Buffer } from "node:buffer"
import type pg from "pg"

import type { ContextHistoryEntry } from "./context/step-context-builder.js"
import { recoverAnsweredQuestionLineage, type QuestionAnswerLineage, type RecoveryInput } from "./question-answer-recovery-lineage.js"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
type SourceTurn = Readonly<{ id: string; rootTaskId: string; createdAt: Date }>
type Candidate = Readonly<{ createdAt: Date; sequence: bigint; id: string; entries: readonly ContextHistoryEntry[]; bytes: number }>

const MAX_SOURCE_TURNS = 8
const MAX_TURNS_SCANNED = 64
const MAX_QUESTIONS_PER_TURN = 16
const MAX_RETURNED_PAIRS = 16
const MAX_RETURNED_BYTES = 64 * 1024
const MAX_LINKED_ROWS = 64
const LINEAGE_FAILURES = new Set([
  "question_recovery_answer_event_ambiguous", "question_recovery_answer_lineage_invalid",
  "question_recovery_event_history_limit", "question_recovery_event_scope_invalid", "question_recovery_history_limit",
  "question_recovery_item_id_invalid", "question_recovery_item_malformed",
  "question_recovery_item_scope_invalid", "question_recovery_sequence_invalid", "question_recovery_start_event_ambiguous",
  "question_recovery_start_lineage_invalid", "question_recovery_step_invalid", "question_recovery_step_missing",
  "question_recovery_tool_lineage_invalid",
])

function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function nonempty(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null }
function date(value: unknown): Date | null { return value instanceof Date && Number.isFinite(value.getTime()) ? value : null }
function sequence(value: unknown): bigint | null {
  try { const result = BigInt(String(value)); return result > 0n ? result : null } catch { return null }
}
function questionPair(lineage: QuestionAnswerLineage, itemId: string): ContextHistoryEntry[] {
  return [
    { id: "agent-question:" + itemId + ":question", content: { role: "assistant", type: "question", question: lineage.content.question, options: lineage.content.options } },
    { id: "agent-question:" + itemId + ":answer", content: { role: "user", type: "answer", questionId: lineage.questionId, text: lineage.content.answer } },
  ]
}
function questionPairBytes(entries: readonly ContextHistoryEntry[]): number {
  try { return Buffer.byteLength(JSON.stringify(entries), "utf8") } catch { return Number.POSITIVE_INFINITY }
}
function lineageFailure(error: unknown): boolean {
  return error instanceof Error && LINEAGE_FAILURES.has(error.message)
    && !("code" in error) && !("severity" in error) && !("detail" in error)
}
function isRootAskUser(lineage: QuestionAnswerLineage, calls: readonly Row[], rootTaskId: string): boolean {
  const matches = calls.filter(call => call.type === "tool_call" && call.taskId === rootTaskId
    && call.stepId === lineage.stepId && object(call.content).toolCallId === lineage.toolCallId)
  if (matches.length !== 1) return false
  const content = object(matches[0]?.content)
  return content.toolName === "agent.ask_user" && content.toolVersion === "1"
    && content.status === "completed" && content.errorCode === null
}

async function sourceTurns(client: Client, input: RecoveryInput): Promise<SourceTurn[]> {
  const current = await client.query<Row>(
    `SELECT active_turn."createdAt" FROM "agent_turns" AS active_turn
       JOIN "agent_sessions" AS session ON session."id" = active_turn."sessionId" AND session."userId" = $2
      WHERE active_turn."id" = $1 AND active_turn."sessionId" = $3 AND active_turn."userId" = $2`,
    [input.lease.turnId, input.lease.userId, input.lease.sessionId],
  )
  const currentCreatedAt = date(current.rows[0]?.createdAt)
  if (!currentCreatedAt) throw new Error("question_recovery_current_turn_scope_invalid")
  const prior = await client.query<Row>(
    `SELECT prior."id", prior."createdAt", root."id" AS "rootTaskId"
       FROM (SELECT candidate."id", candidate."sessionId", candidate."rootTaskId", candidate."createdAt"
               FROM "agent_turns" AS candidate
               JOIN "agent_sessions" AS candidate_session ON candidate_session."id" = candidate."sessionId" AND candidate_session."userId" = $2
              WHERE candidate."sessionId" = $1 AND candidate."userId" = $2 AND candidate."id" <> $3
                AND candidate."status" = 'completed' AND candidate."createdAt" < $4
              ORDER BY candidate."createdAt" DESC, candidate."id" DESC LIMIT $5) AS prior
       JOIN "sub_agent_tasks" AS root ON root."id" = prior."rootTaskId" AND root."sessionId" = prior."sessionId"
        AND root."turnId" = prior."id" AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
      WHERE prior."sessionId" = $1
        AND EXISTS (SELECT 1 FROM "agent_items" AS question
          WHERE question."sessionId" = prior."sessionId" AND question."turnId" = prior."id"
            AND question."taskId" = root."id" AND question."type" = 'question'
            AND (question."status" = 'completed' OR question."content"->>'answerAvailable' = 'true'
              OR question."content"->>'answer' IS NOT NULL OR EXISTS (SELECT 1 FROM "agent_events" AS answered
                WHERE answered."sessionId" = question."sessionId" AND answered."turnId" = question."turnId"
                  AND answered."itemId" = question."id" AND answered."type" = 'question.answered'
                  AND (answered."taskId" IS NULL OR answered."taskId" = root."id")))
            AND EXISTS (SELECT 1 FROM "agent_items" AS ask_call
              WHERE ask_call."sessionId" = question."sessionId" AND ask_call."turnId" = question."turnId"
                AND ask_call."taskId" = root."id" AND ask_call."type" = 'tool_call'
                AND ask_call."status" = 'completed' AND ask_call."content"->>'toolName' = 'agent.ask_user'
                AND ask_call."content"->>'toolVersion' = '1' AND ask_call."content"->>'status' = 'completed'
                AND ask_call."content"->'errorCode' = 'null'::jsonb
                AND ask_call."content"->>'toolCallId' = question."content"->>'toolCallId'))
      ORDER BY prior."createdAt" DESC, prior."id" DESC LIMIT $6`,
    [input.lease.sessionId, input.lease.userId, input.lease.turnId, currentCreatedAt, MAX_TURNS_SCANNED, MAX_SOURCE_TURNS],
  )
  return prior.rows.flatMap(row => {
    const id = nonempty(row.id), rootTaskId = nonempty(row.rootTaskId), createdAt = date(row.createdAt)
    return id && rootTaskId && createdAt && createdAt < currentCreatedAt ? [{ id, rootTaskId, createdAt }] : []
  })
}

async function linkedRows(client: Client, source: SourceTurn, input: RecoveryInput): Promise<{ steps: Row[]; calls: Row[] } | null> {
  const questions = await client.query<Row>(
    `SELECT question."id", question."stepId", question."content"->>'toolCallId' AS "toolCallId"
       FROM "agent_items" AS question
      WHERE question."sessionId" = $1 AND question."turnId" = $2 AND question."taskId" = $3 AND question."type" = 'question'
        AND (question."status" = 'completed' OR question."content"->>'answerAvailable' = 'true'
          OR question."content"->>'answer' IS NOT NULL OR EXISTS (SELECT 1 FROM "agent_events" AS answered
            WHERE answered."sessionId" = question."sessionId" AND answered."turnId" = question."turnId"
              AND answered."itemId" = question."id" AND answered."type" = 'question.answered'
              AND (answered."taskId" IS NULL OR answered."taskId" = question."taskId')))
      ORDER BY question."createdAt" ASC, question."id" ASC LIMIT $4`,
    [input.lease.sessionId, source.id, source.rootTaskId, MAX_QUESTIONS_PER_TURN + 1],
  )
  if (questions.rows.length > MAX_QUESTIONS_PER_TURN) return null
  const callIds = [...new Set(questions.rows.map(question => nonempty(question.toolCallId)).filter((id): id is string => id !== null))]
  const calls = await client.query<Row>(
    `SELECT call."id", call."stepId", call."taskId", call."type", call."content"
       FROM "agent_items" AS call
      WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3 AND call."type" = 'tool_call'
        AND call."content"->>'toolCallId' = ANY($4::text[])
      ORDER BY call."createdAt" ASC, call."id" ASC LIMIT $5`,
    [input.lease.sessionId, source.id, source.rootTaskId, callIds, MAX_LINKED_ROWS + 1],
  )
  if (calls.rows.length > MAX_LINKED_ROWS) return null
  const stepIds = [...new Set(calls.rows.map(call => nonempty(call.stepId)).filter((id): id is string => id !== null))]
  const steps = await client.query<Row>(
    `SELECT step."id", step."taskId" FROM "agent_steps" AS step
      WHERE step."sessionId" = $1 AND step."turnId" = $2 AND step."taskId" = $3 AND step."id" = ANY($4::text[])
      ORDER BY step."id" ASC LIMIT $5`,
    [input.lease.sessionId, source.id, source.rootTaskId, stepIds, MAX_LINKED_ROWS + 1],
  )
  if (steps.rows.length > MAX_LINKED_ROWS) return null
  return { steps: steps.rows, calls: calls.rows }
}

async function sourceCandidates(client: Client, source: SourceTurn, input: RecoveryInput, existingHistory: readonly ContextHistoryEntry[]): Promise<Candidate[]> {
  const linked = await linkedRows(client, source, input)
  if (!linked) return []
  const recoveryInput: RecoveryInput = { ...input, lease: { userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: source.id },
    rootTaskId: source.rootTaskId, steps: linked.steps, toolItems: linked.calls, existingHistory,
    maxQuestions: MAX_QUESTIONS_PER_TURN, rootOnly: true }
  let lineages: QuestionAnswerLineage[]
  try { lineages = await recoverAnsweredQuestionLineage(client, recoveryInput) }
  catch (error) { if (lineageFailure(error)) return []; throw error }
  const result: Candidate[] = []
  for (const lineage of lineages) {
    if (!isRootAskUser(lineage, linked.calls, source.rootTaskId)) continue
    const itemId = nonempty(lineage.item.id)
    if (!itemId) continue
    const entries = questionPair(lineage, itemId)
    const answeredSequence = sequence(lineage.answeredEvent.sequence)
    const bytes = questionPairBytes(entries)
    if (answeredSequence === null || bytes > MAX_RETURNED_BYTES) continue
    const existingIds = new Set(existingHistory.map(entry => entry.id))
    const missing = lineage.entries.filter(entry => !existingIds.has(entry.id))
    if (missing.length) result.push({ createdAt: source.createdAt, sequence: answeredSequence, id: itemId, entries: missing, bytes })
  }
  return result
}

/** Re-derives bounded earlier root ask_user statements; they remain untrusted history, never verifier proof. */
export async function recoverPriorRootQuestionHistory(
  client: Client, input: RecoveryInput,
): Promise<ContextHistoryEntry[]> {
  const sources = await sourceTurns(client, input)
  const existing = [...input.existingHistory]
  const candidates: Candidate[] = []
  for (const source of sources) {
    const found = await sourceCandidates(client, source, input, existing)
    candidates.push(...found)
    for (const candidate of found) existing.push(...candidate.entries)
  }
  candidates.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
    || (left.sequence === right.sequence ? right.id.localeCompare(left.id) : left.sequence > right.sequence ? -1 : 1))
  const selected: Candidate[] = []
  let bytes = 0
  for (const candidate of candidates) {
    if (selected.length >= MAX_RETURNED_PAIRS || bytes + candidate.bytes > MAX_RETURNED_BYTES) continue
    selected.push(candidate); bytes += candidate.bytes
  }
  selected.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()
    || (left.sequence === right.sequence ? left.id.localeCompare(right.id) : left.sequence < right.sequence ? -1 : 1))
  return selected.flatMap(candidate => [...candidate.entries])
}
