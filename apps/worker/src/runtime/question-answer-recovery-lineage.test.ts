import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { recoverAnsweredQuestionLineage } from "./question-answer-recovery-lineage.js"
import { recoverAnsweredQuestionHistory } from "./question-answer-recovery.js"
import type { RecoveryInput } from "./question-answer-recovery-lineage.js"

type Row = Record<string, unknown>
const lease = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }
const rootTaskId = "root-1"

function item(id = "question-item", questionId = "wait-1", toolCallId = "call-1", patch: Row = {}): Row {
  return {
    id, revision: 2, userId: lease.userId, turnUserId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    taskId: null, stepId: null, type: "question", status: "completed",
    content: { waitKind: "question", questionId, toolCallId, question: "Where should I focus?",
      options: [{ label: "Dublin", value: "dublin" }], answer: "dublin", answerAvailable: true },
    ...patch,
  }
}

function events(questionItem = item(), startSequence = "10", answerSequence = "11", startPatch: Row = {}, answerPatch: Row = {}): Row[] {
  const content = questionItem.content as Row
  return [
    { id: "start-event", userId: lease.userId, turnUserId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
      taskId: questionItem.taskId, itemId: questionItem.id, type: "item.started", actor: "orchestrator", sequence: startSequence,
      correlationId: questionItem.id, causationId: content.questionId,
      payload: { itemId: questionItem.id, waitKind: "question", toolCallId: content.toolCallId }, ...startPatch },
    { id: "answer-event", userId: lease.userId, turnUserId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
      taskId: null, itemId: questionItem.id, type: "question.answered", actor: "user", sequence: answerSequence,
      correlationId: content.questionId, causationId: questionItem.id,
      payload: { waitKind: "question", waitId: content.questionId, itemId: questionItem.id, turnId: lease.turnId,
        toolCallId: content.toolCallId, status: "answered" }, ...answerPatch },
  ]
}

function client(itemRows: Row[] = [item()], eventRows: Row[] = events(), rootOnly = false) {
  const value = { query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const exactOwnedCurrentTurnQuery = sql.includes('SELECT active_turn."createdAt" FROM "agent_turns" AS active_turn')
      && sql.includes('JOIN "agent_sessions" AS session ON session."id" = active_turn."sessionId" AND session."userId" = $2')
      && sql.includes('WHERE active_turn."id" = $1 AND active_turn."sessionId" = $3 AND active_turn."userId" = $2')
    if (exactOwnedCurrentTurnQuery) {
      const owned = values[0] === lease.turnId && values[1] === lease.userId && values[2] === lease.sessionId
      const rows = owned ? [{ createdAt: new Date("2026-10-07T00:00:00.000Z") }] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('SELECT "id" FROM "agent_turns"') && sql.includes('"rootTaskId" = $4')) {
      const owned = values[0] === lease.turnId && values[1] === lease.sessionId && values[2] === lease.userId && values[3] === rootTaskId
      const rows = owned ? [{ id: lease.turnId }] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('event."idempotencyKey" = ANY($2::text[])')) return { rows: [] }
    if (sql.includes('SELECT prior."id", prior."createdAt", root."id" AS "rootTaskId"')) return { rows: [], rowCount: 0 }
    return { rows: sql.includes('FROM "agent_items"')
      ? rootOnly ? itemRows.filter(row => row.taskId === rootTaskId) : itemRows : eventRows }
  }) }
  return value as unknown as Pick<pg.PoolClient, "query"> & { readonly query: typeof value.query }
}
function input(patch: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    lease, rootTaskId, steps: [{ id: "step-1", taskId: rootTaskId }],
    toolItems: [{ id: "call-item", stepId: "step-1", taskId: rootTaskId, type: "tool_call", content: { toolCallId: "call-1" } }],
    existingHistory: [], ...patch,
  }
}

describe("durable question answer lineage", () => {
  it("returns complete root-call lineage in answer sequence order and preserves the legacy projection", async () => {
    const first = item("question-1", "wait-1", "call-1")
    const second = item("question-2", "wait-2", "call-2", { content: {
      ...(item("question-2", "wait-2", "call-2").content as Row), question: "Which city?", answer: "Cork",
    } })
    const rows = [first, second]
    const eventRows = [
      ...events(first, "10", "13"),
      ...events(second, "11", "12"),
    ]
    const supplied = input({ toolItems: [
      { id: "call-item-1", stepId: "step-1", taskId: rootTaskId, type: "tool_call", content: { toolCallId: "call-1" } },
      { id: "call-item-2", stepId: "step-2", taskId: rootTaskId, type: "tool_call", content: { toolCallId: "call-2" } },
    ], steps: [{ id: "step-1", taskId: rootTaskId }, { id: "step-2", taskId: rootTaskId }] })
    const lineage = await recoverAnsweredQuestionLineage(client(rows, eventRows), supplied)
    expect(lineage.map(row => row.questionId)).toEqual(["wait-2", "wait-1"])
    expect(lineage[0]).toMatchObject({ stepId: "step-2", toolCallId: "call-2", item: second,
      startedEvent: eventRows[2], answeredEvent: eventRows[3], entries: [
        { id: "agent-question:question-2:question", content: { role: "assistant", type: "question", question: "Which city?" } },
        { id: "agent-question:question-2:answer", content: { role: "user", type: "answer", questionId: "wait-2", text: "Cork" } },
      ] })
    expect(await recoverAnsweredQuestionHistory(client(rows, eventRows), supplied)).toEqual(lineage.flatMap(row => row.entries))
  })

  it("accepts the broker's null-task answer for a turn-scoped question only with the matching root tool call", async () => {
    const question = item()
    const result = await recoverAnsweredQuestionLineage(client([question]), input())
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ item: question, stepId: "step-1", toolCallId: "call-1" })
    expect(result[0]?.answeredEvent.taskId).toBeNull()
  })

  it("keeps the native root-only query separate from legacy broker-scoped history", async () => {
    const rootQuestion = item("question-item", "wait-1", "call-1", { taskId: rootTaskId })
    const brokerQuestion = item("broker-item", "broker-wait", "broker-call", { taskId: null })
    const f = client([rootQuestion, brokerQuestion], events(rootQuestion), true)
    const result = await recoverAnsweredQuestionLineage(f, input({ rootOnly: true }))
    expect(result).toHaveLength(1)
    expect(result[0]?.item).toEqual(rootQuestion)
    expect(f.query.mock.calls.some(([sql]) => sql.includes('item."taskId" = $4')
      && sql.includes('ask_call."content"->>\'toolName\' = \'agent.ask_user\'') && sql.includes("question.answered"))).toBe(true)
    const legacy = input({ toolItems: [{ id: "broker-call-item", stepId: "step-1", taskId: rootTaskId,
      type: "tool_call", content: { toolCallId: "broker-call" } }] })
    expect(await recoverAnsweredQuestionLineage(client([brokerQuestion], events(brokerQuestion)), legacy)).toHaveLength(1)
  })

  it.each([
    ["foreign item user", item("question-item", "wait-1", "call-1", { userId: "other-user" }), events()],
    ["foreign joined Turn owner", item("question-item", "wait-1", "call-1", { turnUserId: "other-user" }), events()],
    ["foreign session", item("question-item", "wait-1", "call-1", { sessionId: "other-session" }), events()],
    ["foreign Turn", item("question-item", "wait-1", "call-1", { turnId: "other-turn" }), events()],
    ["foreign task", item("question-item", "wait-1", "call-1", { taskId: "child-task" }), events()],
    ["foreign answer actor", item(), events(item(), "10", "11", {}, { actor: "system" })],
    ["foreign answer task", item(), events(item(), "10", "11", {}, { taskId: "other-root" })],
    ["wrong answer correlation", item(), events(item(), "10", "11", {}, { correlationId: "other-wait" })],
    ["wrong answer causation", item(), events(item(), "10", "11", {}, { causationId: "other-item" })],
    ["answer before start", item(), events(item(), "11", "10")],
    ["zero answer sequence", item(), events(item(), "10", "0")],
    ["wrong start actor", item(), events(item(), "10", "11", { actor: "user" })],
    ["wrong start correlation", item(), events(item(), "10", "11", { correlationId: "other-item" })],
    ["wrong start item binding", item(), events(item(), "10", "11", { itemId: "other-item" })],
  ])("rejects %s lineage", async (_label, question, rows) => {
    await expect(recoverAnsweredQuestionLineage(client([question], rows), input())).rejects.toThrow("question_recovery_")
  })

  it("rejects ambiguous duplicate question, answer, and tool-call lineages", async () => {
    const duplicateQuestion = item("question-item-2")
    await expect(recoverAnsweredQuestionLineage(client([item(), duplicateQuestion]), input())).rejects.toThrow("question_recovery_item_malformed")
    await expect(recoverAnsweredQuestionLineage(client([item()], [...events(), events()[1]!]), input()))
      .rejects.toThrow("question_recovery_answer_event_ambiguous")
    await expect(recoverAnsweredQuestionLineage(client(), input({ toolItems: [
      { id: "call-1", stepId: "step-1", taskId: rootTaskId, type: "tool_call", content: { toolCallId: "call-1" } },
      { id: "call-2", stepId: "step-1", taskId: rootTaskId, type: "tool_call", content: { toolCallId: "call-1" } },
    ] }))).rejects.toThrow("question_recovery_tool_lineage_invalid")
  })

  it("rejects malformed options, unavailable answers, and incomplete or conflicting snapshot pairs", async () => {
    const malformed = item("question-item", "wait-1", "call-1", { content: { ...(item().content as Row), options: [{ label: "Dublin" }] } })
    await expect(recoverAnsweredQuestionLineage(client([malformed]), input())).rejects.toThrow("question_recovery_item_malformed")
    const unavailable = item("question-item", "wait-1", "call-1", { content: { ...(item().content as Row), answerAvailable: false } })
    await expect(recoverAnsweredQuestionLineage(client([unavailable]), input())).rejects.toThrow("question_recovery_item_malformed")
    const answerOnly = { id: "agent-question:question-item:answer", content: { role: "user", type: "answer", questionId: "wait-1", text: "dublin" } }
    await expect(recoverAnsweredQuestionLineage(client(), input({ existingHistory: [answerOnly] })))
      .rejects.toThrow("question_recovery_history_pair_incomplete")
    const conflicting = { id: "agent-question:question-item:question", content: "changed" }
    await expect(recoverAnsweredQuestionLineage(client(), input({ existingHistory: [conflicting] })))
      .rejects.toThrow("question_recovery_history_collision")
  })

  it("fails closed when root-call and Step lineage is absent, foreign, or ambiguous", async () => {
    await expect(recoverAnsweredQuestionLineage(client(), input({ rootTaskId: null })))
      .rejects.toThrow("question_recovery_tool_lineage_invalid")
    await expect(recoverAnsweredQuestionLineage(client([item("question-item", "wait-1", "call-1", { stepId: "step-1" })]),
      input({ steps: [{ id: "step-1", taskId: "foreign-root" }] })))
      .rejects.toThrow("question_recovery_step_invalid")
    await expect(recoverAnsweredQuestionLineage(client(), input({ toolItems: [] })))
      .rejects.toThrow("question_recovery_tool_lineage_invalid")
    await expect(recoverAnsweredQuestionLineage(client(), input({ steps: [] })))
      .rejects.toThrow("question_recovery_step_missing")
  })
})
