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

function requireQuestionToolCall(item: Row, content: Row, rootTaskId: string | null): string {
  const callId = text(content.toolCallId)
  if (!callId) throw new Error("question_recovery_tool_lineage_invalid")
  if (item.taskId == null && !text(rootTaskId)) throw new Error("question_recovery_tool_lineage_invalid")
  return callId
}

function assertStepLineage(item: Row, callId: string, input: RecoveryInput): void {
  // Broker wait rows stay turn-scoped; use the root task only when resolving
  // their tool-call lineage to worker-owned records.
  const taskId = item.taskId ?? input.rootTaskId ?? null
  const stepsFor = (id: string) => input.steps.filter(step => text(step.id) === id)
  const callMatchesTask = (call: Row) => (call.taskId ?? null) === taskId
  const direct = text(item.stepId)
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
  if (calls.length !== 1 || !callMatchesTask(calls[0])) {
    throw new Error("question_recovery_tool_lineage_invalid")
  }
  const callStepId = text(calls[0].stepId)
  if (!callStepId) throw new Error("question_recovery_step_missing")
  const callSteps = stepsFor(callStepId)
  if (callSteps.length !== 1) throw new Error("question_recovery_step_missing")
  if ((callSteps[0].taskId ?? null) !== taskId) throw new Error("question_recovery_tool_lineage_invalid")
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
  for (const entry of entries) {
    if (existing.filter(candidate => candidate.id === entry.id).length > 1) {
      throw new Error("question_recovery_history_duplicate")
    }
  }
  const known = new Map(existing.map(entry => [entry.id, entry.content]))
  for (const entry of entries) {
    if (known.has(entry.id) && !same(known.get(entry.id), entry.content)) throw new Error("question_recovery_history_collision")
  }
  const questionIndex = existing.findIndex(entry => entry.id === entries[0].id)
  const answerIndex = existing.findIndex(entry => entry.id === entries[1].id)
  if (questionIndex >= 0 && answerIndex >= 0 && questionIndex > answerIndex) {
    throw new Error("question_recovery_history_order_invalid")
  }
  if (known.has(entries[1].id) && !known.has(entries[0].id)) throw new Error("question_recovery_history_pair_incomplete")
  return entries.filter(entry => !known.has(entry.id))
}

function validateStart(event: Row, item: Row, questionId: string, callId: string | null): bigint {
  const payload = record(event.payload)
  if (event.actor !== "orchestrator" || event.itemId !== item.id || event.correlationId !== item.id || event.causationId !== questionId
    || payload.itemId !== item.id || payload.waitKind !== "question"
    || (payload.toolCallId ?? null) !== callId) throw new Error("question_recovery_start_lineage_invalid")
  return sequence(event.sequence)
}

function validateAnswer(event: Row, item: Row, questionId: string, callId: string | null, lease: TurnLease): bigint {
  const payload = record(event.payload)
  if (event.actor !== "user" || event.itemId !== item.id || event.correlationId !== questionId || event.causationId !== item.id
    || payload.waitKind !== "question" || payload.waitId !== questionId || payload.itemId !== item.id
    || payload.turnId !== lease.turnId || (payload.toolCallId ?? null) !== callId
    || payload.status !== "answered") throw new Error("question_recovery_answer_lineage_invalid")
  return sequence(event.sequence)
}

function claimsPersistedAnswer(item: Row, content: Row): boolean {
  return item.status === "completed" || content.answerAvailable === true || text(content.answer) !== null
}

/** Projects only broker-answered questions with a complete durable scope and step lineage. */
export async function recoverAnsweredQuestionHistory(
  client: RecoveryClient,
  input: RecoveryInput,
): Promise<ContextHistoryEntry[]> {
  const { lease, rootTaskId } = input
  const items = await client.query<Row>(
    `SELECT item."id", item."sessionId", item."turnId", item."stepId", item."taskId", item."type", item."status", item."content",
            session."userId" AS "userId", turn."userId" AS "turnUserId"
       FROM "agent_items" AS item
       JOIN "agent_sessions" AS session ON session."id" = item."sessionId" AND session."userId" = $3
       JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId" AND turn."userId" = $3
      WHERE item."sessionId" = $1 AND item."turnId" = $2 AND (item."taskId" IS NULL OR item."taskId" = $4)
        AND item."type" = 'question' ORDER BY item."createdAt" ASC, item."id" ASC`,
    [lease.sessionId, lease.turnId, lease.userId, rootTaskId],
  )
  if (items.rows.length === 0) return []
  // Some test repositories return a neighboring Turn row for this query.
  // Classify the actual item type before treating it as recovery evidence.
  const questions = items.rows.filter(item => item.type === "question")
  const itemIds = questions.map(item => {
    const id = text(item.id)
    if (!id) {
      if (claimsPersistedAnswer(item, record(item.content))) throw new Error("question_recovery_item_id_invalid")
      return null
    }
    return id
  }).filter((id): id is string => id !== null)
  if (itemIds.length === 0) return []
  for (const item of questions) {
    const content = record(item.content)
    if (claimsPersistedAnswer(item, content)) {
      assertItemFence(item, input)
      requireQuestionToolCall(item, content, rootTaskId)
    }
  }
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
  const candidates = questions.filter(item => {
    const id = text(item.id)
    return claimsPersistedAnswer(item, record(item.content))
      || (!!id && events.rows.some(event => event.itemId === id && event.type === "question.answered"))
  })
  if (candidates.length === 0) return []
  const allByQuestion = new Map<string, number>()
  for (const item of questions) {
    const id = text(record(item.content).questionId)
    if (id) allByQuestion.set(id, (allByQuestion.get(id) ?? 0) + 1)
  }
  const result: { order: bigint; entries: ContextHistoryEntry[] }[] = []
  for (const item of candidates) {
    assertItemFence(item, input)
    const content = record(item.content)
    const questionId = text(content.questionId)
    const callId = requireQuestionToolCall(item, content, rootTaskId)
    const itemEvents = events.rows.filter(event => event.itemId === item.id)
    if (item.status !== "completed" || content.waitKind !== "question" || content.answerAvailable !== true || !questionId || !text(content.question)
      || !validOptions(content.options) || !text(content.answer) || allByQuestion.get(questionId) !== 1) {
      throw new Error("question_recovery_item_malformed")
    }
    assertStepLineage(item, callId, input)
    const answers = itemEvents.filter(event => event.type === "question.answered")
    if (answers.length !== 1) throw new Error("question_recovery_answer_event_ambiguous")
    const starts = itemEvents.filter(event => event.type === "item.started")
    if (starts.length !== 1) throw new Error("question_recovery_start_event_ambiguous")
    for (const event of itemEvents) {
      const brokerAnswer = event.type === "question.answered" && event.actor === "user" && event.taskId === null
      if (event.userId !== lease.userId || event.turnUserId !== lease.userId || event.sessionId !== lease.sessionId
        || event.turnId !== lease.turnId || (event.taskId !== item.taskId && !brokerAnswer)
        || (event.taskId !== null && event.taskId !== rootTaskId)) throw new Error("question_recovery_event_scope_invalid")
    }
    const startedAt = validateStart(starts[0], item, questionId, callId)
    const answeredAt = validateAnswer(answers[0], item, questionId, callId, lease)
    if (answeredAt <= startedAt) throw new Error("question_recovery_sequence_invalid")
    const entries = historyPair(item, content)
    result.push({ order: answeredAt, entries: appendIfNew(entries, input.existingHistory) })
  }
  result.sort((left, right) => left.order < right.order ? -1 : left.order > right.order ? 1 : 0)
  return result.flatMap(row => row.entries)
}
