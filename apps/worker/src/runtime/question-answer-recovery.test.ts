import { describe, expect, it } from "vitest"

import { recoverAnsweredQuestionHistory } from "./question-answer-recovery.js"

const lease = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-2", leaseVersion: 2,
  leaseStartedAt: new Date("2026-10-02T00:00:00.000Z"), leaseExpiresAt: new Date("2026-10-02T00:01:00.000Z") }

function item(patch: Record<string, unknown> = {}) {
  return {
    id: "question-item", type: "question", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null,
    stepId: null, status: "completed", content: { waitKind: "question", questionId: "wait-1", toolCallId: "call-1",
      question: "Continue?", options: [{ label: "Yes", value: "yes" }], answer: "yes", answerAvailable: true }, ...patch,
  }
}
function events(startPatch: Record<string, unknown> = {}, answerPatch: Record<string, unknown> = {}) {
  return [
    { id: "started", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null,
      itemId: "question-item", type: "item.started", actor: "orchestrator", sequence: "10", correlationId: "question-item", causationId: "wait-1",
      payload: { itemId: "question-item", waitKind: "question", questionId: "wait-1", toolCallId: "call-1" }, ...startPatch },
    { id: "answered", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null,
      itemId: "question-item", type: "question.answered", actor: "user", sequence: "11", correlationId: "wait-1", causationId: "question-item",
      payload: { waitKind: "question", waitId: "wait-1", itemId: "question-item", turnId: "turn-1", toolCallId: "call-1", status: "answered", answerAvailable: true }, ...answerPatch },
  ]
}
function client(itemRows: Record<string, unknown>[] = [item()], eventRows: Record<string, unknown>[] = events()) {
  const value = { query: async (sql: string) => ({ rows: sql.includes('FROM "agent_items"') ? itemRows : eventRows }) }
  return value as never
}
function input(patch: Record<string, unknown> = {}) {
  return { lease, rootTaskId: "root-1", steps: [{ id: "step-1" }],
    toolItems: [{ id: "call-item", stepId: "step-1", type: "tool_call", content: { toolCallId: "call-1" } }],
    existingHistory: [], ...patch } as never
}

describe("recoverAnsweredQuestionHistory", () => {
  it("projects separate, ordered question/options and answer entries using the unique tool-call step", async () => {
    const history = await recoverAnsweredQuestionHistory(client(), input())
    expect(history).toEqual([
      { id: "agent-question:question-item:question", content: { role: "assistant", type: "question", question: "Continue?", options: [{ label: "Yes", value: "yes" }] } },
      { id: "agent-question:question-item:answer", content: { role: "user", type: "answer", questionId: "wait-1", text: "yes" } },
    ])
  })

  it("accepts a directly fenced step and deduplicates a complete snapshot pair", async () => {
    const entries = await recoverAnsweredQuestionHistory(client([item({ stepId: "step-1" })]), input({ existingHistory: [
      { id: "agent-question:question-item:question", content: { role: "assistant", type: "question", question: "Continue?", options: [{ label: "Yes", value: "yes" }] } },
      { id: "agent-question:question-item:answer", content: { role: "user", type: "answer", questionId: "wait-1", text: "yes" } },
    ] }))
    expect(entries).toEqual([])
  })

  it("rejects an existing stable-ID pair when the answer precedes the question", async () => {
    await expect(recoverAnsweredQuestionHistory(client(), input({ existingHistory: [
      { id: "agent-question:question-item:answer", content: { role: "user", type: "answer", questionId: "wait-1", text: "yes" } },
      { id: "agent-question:question-item:question", content: { role: "assistant", type: "question", question: "Continue?", options: [{ label: "Yes", value: "yes" }] } },
    ] }))).rejects.toThrow("question_recovery_history_order_invalid")
  })

  it("rejects repeated existing question or answer stable IDs even when the entries match", async () => {
    const question = { id: "agent-question:question-item:question", content: {
      role: "assistant", type: "question", question: "Continue?", options: [{ label: "Yes", value: "yes" }],
    } }
    const answer = { id: "agent-question:question-item:answer", content: {
      role: "user", type: "answer", questionId: "wait-1", text: "yes",
    } }
    await expect(recoverAnsweredQuestionHistory(client(), input({ existingHistory: [question, question, answer] })))
      .rejects.toThrow("question_recovery_history_duplicate")
    await expect(recoverAnsweredQuestionHistory(client(), input({ existingHistory: [question, answer, answer] })))
      .rejects.toThrow("question_recovery_history_duplicate")
  })

  it("projects only question, direct step, and tool-call lineage with exact task scope", async () => {
    const rootQuestion = item({ taskId: "root-1", stepId: "step-1" })
    const rootEvents = events().map(event => ({ ...event, taskId: "root-1" })) as Record<string, unknown>[]
    await expect(recoverAnsweredQuestionHistory(client([rootQuestion], rootEvents), input({
      steps: [{ id: "step-1", taskId: "root-1" }],
      toolItems: [{ id: "call-item", stepId: "step-1", taskId: "root-1", type: "tool_call", content: { toolCallId: "call-1" } }],
    }))).resolves.toHaveLength(2)
    await expect(recoverAnsweredQuestionHistory(client([item({ stepId: "step-1" })]), input({ steps: [{ id: "step-1", taskId: "root-1" }] })))
      .rejects.toThrow("question_recovery_step_invalid")
    await expect(recoverAnsweredQuestionHistory(client(), input({
      toolItems: [{ id: "call-item", stepId: "step-1", taskId: "root-1", type: "tool_call", content: { toolCallId: "call-1" } }],
    }))).rejects.toThrow("question_recovery_tool_lineage_invalid")
  })

  it("adds only the missing answer when the matching question is already in snapshot history", async () => {
    const entries = await recoverAnsweredQuestionHistory(client(), input({ existingHistory: [
      { id: "agent-question:question-item:question", content: { role: "assistant", type: "question", question: "Continue?", options: [{ label: "Yes", value: "yes" }] } },
    ] }))
    expect(entries.map(entry => entry.id)).toEqual(["agent-question:question-item:answer"])
  })

  it("deduplicates equivalent snapshot JSON when top-level and nested object keys are reordered", async () => {
    const entries = await recoverAnsweredQuestionHistory(client(), input({ existingHistory: [
      { id: "agent-question:question-item:question", content: { options: [{ value: "yes", label: "Yes" }], question: "Continue?", type: "question", role: "assistant" } },
      { id: "agent-question:question-item:answer", content: { text: "yes", questionId: "wait-1", type: "answer", role: "user" } },
    ] }))
    expect(entries).toEqual([])
  })

  it("fails closed when question events have a different task scope", async () => {
    const rootScopedEvents = events().map(event => ({ ...event, taskId: "root-1" })) as Record<string, unknown>[]
    await expect(recoverAnsweredQuestionHistory(
      client([item({ taskId: null })], rootScopedEvents), input(),
    )).rejects.toThrow("question_recovery_event_scope_invalid")
    await expect(recoverAnsweredQuestionHistory(
      client([item({ taskId: "root-1" })], events()), input({
        steps: [{ id: "step-1", taskId: "root-1" }],
        toolItems: [{ id: "call-item", stepId: "step-1", taskId: "root-1", type: "tool_call", content: { toolCallId: "call-1" } }],
      }),
    )).rejects.toThrow("question_recovery_event_scope_invalid")
  })

  it("is inert for an unanswered question with no matching answer event", async () => {
    const pending = item({ status: "started", content: { waitKind: "question", questionId: "wait-1", toolCallId: "call-1",
      question: "Continue?", options: [{ label: "Yes", value: "yes" }], answer: null, answerAvailable: false } })
    await expect(recoverAnsweredQuestionHistory(client([pending], []), input())).resolves.toEqual([])
  })

  it("fails closed when an unanswered question row has a durable answered-event claim", async () => {
    const pending = item({ status: "started", content: { waitKind: "question", questionId: "wait-1", toolCallId: "call-1",
      question: "Continue?", options: [{ label: "Yes", value: "yes" }], answer: null, answerAvailable: false } })
    await expect(recoverAnsweredQuestionHistory(client([pending], events()), input()))
      .rejects.toThrow("question_recovery_item_malformed")
  })

  it("is inert for rows that are not question items and normal unanswered rows", async () => {
    const neighboringTurn = { id: "turn-1", sessionId: "session-1", turnId: "turn-1", status: "in_progress", rootTaskId: "root-1" }
    const unanswered = item({ status: "started", content: { ...item().content as object, answer: null, answerAvailable: false } })
    await expect(recoverAnsweredQuestionHistory(client([neighboringTurn], []), input())).resolves.toEqual([])
    await expect(recoverAnsweredQuestionHistory(client([unanswered], []), input())).resolves.toEqual([])
  })

  it("rejects an answered question candidate without its durable item ID", async () => {
    await expect(recoverAnsweredQuestionHistory(client([item({ id: null })]), input()))
      .rejects.toThrow("question_recovery_item_id_invalid")
  })

  it.each([
    ["foreign user", { userId: "other-user" }, events()],
    ["foreign session", { sessionId: "other-session" }, events()],
    ["foreign turn", { turnId: "other-turn" }, events()],
    ["foreign task", { taskId: "child-task" }, events()],
    ["missing step", {}, events()],
    ["mismatched question event", {}, events({}, { correlationId: "other-wait" })],
    ["wrong answer actor", {}, events({}, { actor: "system" })],
    ["answer before start", {}, events()],
    ["missing answer text", {}, events()],
  ])("fails closed for answered candidate with %s", async (label, itemPatch, eventRows) => {
    if (label === "answer before start") eventRows[1].sequence = "9"
    if (label === "missing answer text") itemPatch = { content: { ...item().content as object, answer: null } }
    await expect(recoverAnsweredQuestionHistory(client([item(itemPatch)], eventRows), input({
      ...(label === "missing step" ? { toolItems: [] } : {}),
    }))).rejects.toThrow()
  })

  it.each([
    ["missing answer event", item(), [events()[0]]],
    ["duplicate answer event", item(), [...events(), events()[1]]],
    ["missing start event", item(), [events()[1]]],
    ["mismatched answer causation", item(), events({}, { causationId: "other-item" })],
    ["empty answer", item({ content: { ...item().content as object, answer: " " } }), events()],
    ["malformed options", item({ content: { ...item().content as object, options: [{ label: "Yes" }] } }), events()],
    ["wrong item wait kind", item({ content: { ...item().content as object, waitKind: "approval" } }), events()],
    ["unavailable answer", item({ content: { ...item().content as object, answerAvailable: false } }), events()],
    ["duplicate question item", item(), events()],
  ])("fails closed for answered candidate with %s", async (label, question, eventRows) => {
    const questionRows = label === "duplicate question item" ? [question, item({ id: "question-item-2" })] : [question]
    await expect(recoverAnsweredQuestionHistory(client(questionRows, eventRows), input())).rejects.toThrow()
  })

  it("fails closed for absent and ambiguous tool-call-to-step lineage", async () => {
    await expect(recoverAnsweredQuestionHistory(client(), input({ toolItems: [] }))).rejects.toThrow("question_recovery_tool_lineage_invalid")
    await expect(recoverAnsweredQuestionHistory(client(), input({ toolItems: [
      { type: "tool_call", stepId: "step-1", content: { toolCallId: "call-1" } },
      { type: "tool_call", stepId: "step-1", content: { toolCallId: "call-1" } },
    ] }))).rejects.toThrow("question_recovery_tool_lineage_invalid")
  })

  it("fails closed for a conflicting stable ID or an answer-only snapshot entry", async () => {
    await expect(recoverAnsweredQuestionHistory(client(), input({ existingHistory: [
      { id: "agent-question:question-item:question", content: "different" },
    ] }))).rejects.toThrow("question_recovery_history_collision")
    await expect(recoverAnsweredQuestionHistory(client(), input({ existingHistory: [
      { id: "agent-question:question-item:answer", content: { role: "user", type: "answer", questionId: "wait-1", text: "yes" } },
    ] }))).rejects.toThrow("question_recovery_history_pair_incomplete")
  })
})
