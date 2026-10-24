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
    if (!sql.includes('FROM "agent_items"')) return { rows: eventRows }
    const candidates = rootOnly ? itemRows.filter(row => row.taskId === rootTaskId) : itemRows
    const filtersPrivateStages = sql.includes(`IS DISTINCT FROM 'scheduled_prepare'`)
      && sql.includes(`IS DISTINCT FROM 'scheduled_gate'`)
    const rows = filtersPrivateStages ? candidates.filter(row => {
      const stage = (row.content as Row | undefined)?.stage
      return stage !== 'scheduled_prepare' && stage !== 'scheduled_gate'
    }) : candidates
    return { rows, rowCount: rows.length }
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

  it("excludes private scheduled Prepare and Gate choices while retaining native and legacy questions", async () => {
    const ordinary = item("ordinary-question", "ordinary-wait", "ordinary-call", { taskId: rootTaskId, content: {
      ...(item("ordinary-question", "ordinary-wait", "ordinary-call").content as Row), stage: "user_input",
    } })
    const legacy = item("legacy-question", "legacy-wait", "legacy-call", { taskId: null })
    const prepare = item("prepare-question", "prepare-wait", "unused-call", { taskId: rootTaskId, content: {
      ...(item("prepare-question", "prepare-wait", "unused-call").content as Row), toolCallId: null, stage: "scheduled_prepare",
      answer: "keep_resume", answerAvailable: true, scheduledPrepareChoiceBinding: { privateBinding: "DO_NOT_PROJECT_PREPARE" },
    } })
    const gate = item("gate-question", "gate-wait", "unused-call", { taskId: rootTaskId, content: {
      ...(item("gate-question", "gate-wait", "unused-call").content as Row), toolCallId: null, stage: "scheduled_gate",
      answer: "skip", answerAvailable: true,
      scheduledGateChoiceBinding: { privateBinding: "DO_NOT_PROJECT" },
      scheduledGateChoiceResumeAcknowledgement: { privateAck: "DO_NOT_PROJECT" },
    } })
    const eventRows = [...events(ordinary), ...events(legacy), ...events(prepare), ...events(gate)]
    const f = client([ordinary, legacy, prepare, gate], eventRows)
    const lineage = await recoverAnsweredQuestionLineage(f, input({ toolItems: [
      { id: "ordinary-call-item", stepId: "step-1", taskId: rootTaskId, type: "tool_call", content: { toolCallId: "ordinary-call" } },
      { id: "legacy-call-item", stepId: "step-1", taskId: rootTaskId, type: "tool_call", content: { toolCallId: "legacy-call" } },
    ] }))

    expect(lineage.map(row => row.item.id)).toEqual(expect.arrayContaining([ordinary.id, legacy.id]))
    expect(lineage.map(row => row.item.id)).toHaveLength(2)
    expect(lineage.flatMap(row => row.entries).map(entry => entry.content)).toEqual(expect.arrayContaining([
      { role: "assistant", type: "question", question: "Where should I focus?", options: [{ label: "Dublin", value: "dublin" }] },
      { role: "user", type: "answer", questionId: "ordinary-wait", text: "dublin" },
    ]))
    expect(JSON.stringify(lineage)).not.toMatch(/DO_NOT_PROJECT|keep_resume|skip/)
    const itemSql = f.query.mock.calls.find(([sql]) => sql.includes('FROM "agent_items"'))?.[0] ?? ""
    expect(itemSql).toContain(`IS DISTINCT FROM 'scheduled_prepare'`)
    expect(itemSql).toContain(`IS DISTINCT FROM 'scheduled_gate'`)
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
    const prepare = item("prepare-question", "prepare-wait", "unused-call", { taskId: rootTaskId, content: {
      ...(item("prepare-question", "prepare-wait", "unused-call").content as Row), toolCallId: null, stage: "scheduled_prepare",
    } })
    const gate = item("gate-question", "gate-wait", "unused-call", { taskId: rootTaskId, content: {
      ...(item("gate-question", "gate-wait", "unused-call").content as Row), toolCallId: null, stage: "scheduled_gate",
    } })
    const f = client([rootQuestion, brokerQuestion, prepare, gate], [...events(rootQuestion), ...events(prepare), ...events(gate)], true)
    const result = await recoverAnsweredQuestionLineage(f, input({ rootOnly: true }))
    expect(result).toHaveLength(1)
    expect(result[0]?.item).toEqual(rootQuestion)
    const rootOnlySql = f.query.mock.calls.find(([sql]) => sql.includes('SELECT item."id"'))?.[0] ?? ""
    expect(rootOnlySql).toContain('item."taskId" = $4')
    expect(rootOnlySql).toContain(`IS DISTINCT FROM 'scheduled_prepare'`)
    expect(rootOnlySql).toContain(`IS DISTINCT FROM 'scheduled_gate'`)
    expect(rootOnlySql).toContain('ask_call."content"->>\'toolName\' = \'agent.ask_user\'')
    expect(rootOnlySql).toContain("question.answered")
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
    const ordinaryNullCall = item("native-null-call", "native-null-wait", "unused-call", { taskId: rootTaskId, content: {
      ...(item("native-null-call", "native-null-wait", "unused-call").content as Row), toolCallId: null, stage: "user_input",
    } })
    await expect(recoverAnsweredQuestionLineage(client([ordinaryNullCall], events(ordinaryNullCall)), input({ toolItems: [] })))
      .rejects.toThrow("question_recovery_tool_lineage_invalid")
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
