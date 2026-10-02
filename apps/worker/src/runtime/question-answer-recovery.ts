import type pg from "pg"

import type { ContextHistoryEntry } from "./context/step-context-builder.js"
import type { TurnLease } from "./turns/lease.js"

type Row = Record<string, unknown>
type RecoveryClient = Pick<pg.PoolClient, "query">
type RecoveryInput = {
  readonly lease: TurnLease
  readonly rootTaskId: string | null
  readonly steps: readonly Row[]
  readonly toolItems: readonly Row[]
  readonly existingHistory: readonly ContextHistoryEntry[]
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function sequence(value: unknown): bigint {
  try {
    const parsed = BigInt(String(value))
    if (parsed < 1n) throw new Error()
    return parsed
  } catch { throw new Error("question_recovery_sequence_invalid") }
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => same(value, right[index]))
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const leftRecord = left as Row
  const rightRecord = right as Row
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && same(leftRecord[key], rightRecord[key]))
}

function assertItemFence(item: Row, input: RecoveryInput): void {
  if (item.userId !== input.lease.userId || item.turnUserId !== input.lease.userId
    || item.sessionId !== input.lease.sessionId || item.turnId !== input.lease.turnId
    || (item.taskId !== null && item.taskId !== input.rootTaskId)) throw new Error("question_recovery_item_scope_invalid")
}

function assertStepLineage(item: Row, content: Row, input: RecoveryInput): void {
  const taskId = item.taskId ?? null
  const stepsFor = (id: string) => input.steps.filter(step => text(step.id) === id)
  const callMatchesTask = (call: Row) => (call.taskId ?? null) === taskId
  const direct = text(item.stepId)
  const callId = text(content.toolCallId)
  if (direct) {
    const directSteps = stepsFor(direct)
    if (directSteps.length !== 1 || (directSteps[0].taskId ?? null) !== taskId) throw new Error("question_recovery_step_invalid")
    if (callId) {
      const calls = input.toolItems.filter(candidate => candidate.type === "tool_call"
        && record(candidate.content).toolCallId === callId)
      if (calls.length !== 1 || calls[0].stepId !== direct || !callMatchesTask(calls[0])) throw new Error("question_recovery_tool_lineage_invalid")
    }
    return
  }
  if (!callId) throw new Error("question_recovery_step_missing")
  const calls = input.toolItems.filter(candidate => candidate.type === "tool_call"
    && record(candidate.content).toolCallId === callId)
  const callSteps = calls.length === 1 ? stepsFor(text(calls[0].stepId) ?? "") : []
  if (calls.length !== 1 || !callMatchesTask(calls[0]) || callSteps.length !== 1 || (callSteps[0].taskId ?? null) !== taskId) {
    throw new Error("question_recovery_tool_lineage_invalid")
  }
}

function validOptions(value: unknown): boolean {
  return Array.isArray(value) && value.every(option => {
    const row = record(option)
    return typeof row.label === "string" && typeof row.value === "string"
  })
}

function historyPair(item: Row, content: Row): ContextHistoryEntry[] {
  const itemId = text(item.id)!
  const questionId = text(content.questionId)!
  return [
    { id: `agent-question:${itemId}:question`, content: { role: "assistant", type: "question", question: content.question, options: content.options } },
    { id: `agent-question:${itemId}:answer`, content: { role: "user", type: "answer", questionId, text: content.answer } },
  ]
}

function appendIfNew(entries: readonly ContextHistoryEntry[], existing: readonly ContextHistoryEntry[]): ContextHistoryEntry[] {
  const known = new Map(existing.map(entry => [entry.id, entry.content]))
  for (const entry of entries) {
    if (known.has(entry.id) && !same(known.get(entry.id), entry.content)) throw new Error("question_recovery_history_collision")
  }
  if (known.has(entries[1].id) && !known.has(entries[0].id)) throw new Error("question_recovery_history_pair_incomplete")
  return entries.filter(entry => !known.has(entry.id))
}

function validateStart(event: Row, item: Row, questionId: string, callId: string | null): bigint {
  const payload = record(event.payload)
  if (event.actor !== "orchestrator" || event.itemId !== item.id || event.correlationId !== item.id || event.causationId !== questionId
    || payload.itemId !== item.id || payload.waitKind !== "question" || payload.questionId !== questionId
    || (payload.toolCallId ?? null) !== callId) throw new Error("question_recovery_start_lineage_invalid")
  return sequence(event.sequence)
}

function validateAnswer(event: Row, item: Row, questionId: string, callId: string | null, lease: TurnLease): bigint {
  const payload = record(event.payload)
  if (event.actor !== "user" || event.itemId !== item.id || event.correlationId !== questionId || event.causationId !== item.id
    || payload.waitKind !== "question" || payload.waitId !== questionId || payload.itemId !== item.id
    || payload.turnId !== lease.turnId || (payload.toolCallId ?? null) !== callId
    || payload.status !== "answered" || payload.answerAvailable !== true) throw new Error("question_recovery_answer_lineage_invalid")
  return sequence(event.sequence)
}

/** Projects only broker-answered questions with a complete durable scope and step lineage. */
export async function recoverAnsweredQuestionHistory(
  client: RecoveryClient,
  input: RecoveryInput,
): Promise<ContextHistoryEntry[]> {
  const { lease, rootTaskId } = input
  const items = await client.query<Row>(
    `SELECT item."id", item."sessionId", item."turnId", item."stepId", item."taskId", item."status", item."content",
            session."userId" AS "userId", turn."userId" AS "turnUserId"
       FROM "agent_items" AS item
       JOIN "agent_sessions" AS session ON session."id" = item."sessionId" AND session."userId" = $3
       JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId" AND turn."userId" = $3
      WHERE item."sessionId" = $1 AND item."turnId" = $2 AND (item."taskId" IS NULL OR item."taskId" = $4)
        AND item."type" = 'question' ORDER BY item."createdAt" ASC, item."id" ASC`,
    [lease.sessionId, lease.turnId, lease.userId, rootTaskId],
  )
  if (items.rows.length === 0) return []
  const itemIds = items.rows.map(item => text(item.id) ?? "")
  if (itemIds.some(id => !id)) throw new Error("question_recovery_item_id_invalid")
  const events = await client.query<Row>(
    `SELECT event."id", event."sessionId", event."turnId", event."taskId", event."itemId", event."actor", event."sequence",
            event."type", event."correlationId", event."causationId", event."payload",
            session."userId" AS "userId", turn."userId" AS "turnUserId"
       FROM "agent_events" AS event
       JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $3
       JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId" AND turn."userId" = $3
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND (event."taskId" IS NULL OR event."taskId" = $4)
        AND event."itemId" = ANY($5::text[]) AND event."type" IN ('item.started', 'question.answered')
      ORDER BY event."sequence" ASC`,
    [lease.sessionId, lease.turnId, lease.userId, rootTaskId, itemIds],
  )
  const allByQuestion = new Map<string, number>()
  for (const item of items.rows) {
    const id = text(record(item.content).questionId)
    if (id) allByQuestion.set(id, (allByQuestion.get(id) ?? 0) + 1)
  }
  const result: { order: bigint; entries: ContextHistoryEntry[] }[] = []
  for (const item of items.rows) {
    assertItemFence(item, input)
    const content = record(item.content)
    const questionId = text(content.questionId)
    const itemEvents = events.rows.filter(event => event.itemId === item.id)
    const answers = itemEvents.filter(event => event.type === "question.answered")
    const claimed = content.answerAvailable === true || text(content.answer) !== null
    if (answers.length === 0 && !claimed) continue
    if (item.status !== "completed" || content.waitKind !== "question" || content.answerAvailable !== true || !questionId || !text(content.question)
      || !validOptions(content.options) || !text(content.answer) || allByQuestion.get(questionId) !== 1) {
      throw new Error("question_recovery_item_malformed")
    }
    assertStepLineage(item, content, input)
    if (answers.length !== 1) throw new Error("question_recovery_answer_event_ambiguous")
    const starts = itemEvents.filter(event => event.type === "item.started")
    if (starts.length !== 1) throw new Error("question_recovery_start_event_ambiguous")
    for (const event of itemEvents) {
      if (event.userId !== lease.userId || event.turnUserId !== lease.userId || event.sessionId !== lease.sessionId
        || event.turnId !== lease.turnId || event.taskId !== item.taskId
        || (event.taskId !== null && event.taskId !== rootTaskId)) throw new Error("question_recovery_event_scope_invalid")
    }
    const callId = text(content.toolCallId)
    const startedAt = validateStart(starts[0], item, questionId, callId)
    const answeredAt = validateAnswer(answers[0], item, questionId, callId, lease)
    if (answeredAt <= startedAt) throw new Error("question_recovery_sequence_invalid")
    const entries = historyPair(item, content)
    result.push({ order: answeredAt, entries: appendIfNew(entries, input.existingHistory) })
  }
  result.sort((left, right) => left.order < right.order ? -1 : left.order > right.order ? 1 : 0)
  return result.flatMap(row => row.entries)
}
