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
      payload: { itemId: "question-item", waitKind: "question", questionId: "[REDACTED]", toolCallId: "call-1" }, ...startPatch },
    { id: "answered", userId: "user-1", turnUserId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: null,
      itemId: "question-item", type: "question.answered", actor: "user", sequence: "11", correlationId: "wait-1", causationId: "question-item",
      payload: { waitKind: "question", waitId: "wait-1", itemId: "question-item", turnId: "turn-1", toolCallId: "call-1", status: "answered", answerAvailable: "[REDACTED]" }, ...answerPatch },
  ]
}
function client(itemRows: Record<string, unknown>[] = [item()], eventRows: Record<string, unknown>[] = events(), queryLog: string[] = []) {
  const value = { query: async (sql: string) => {
    queryLog.push(sql)
    return { rows: sql.includes('FROM "agent_items"') ? itemRows : eventRows }
  } }
  return value as never
}
function input(patch: Record<string, unknown> = {}) {
  return { lease, rootTaskId: "root-1", steps: [{ id: "step-1", taskId: "root-1" }],
    toolItems: [{ id: "call-item", stepId: "step-1", taskId: "root-1", type: "tool_call", content: { toolCallId: "call-1" } }],
    existingHistory: [], ...patch } as never
}

describe("recoverAnsweredQuestionHistory", () => {
  it("accepts broker-redacted event fields when the durable item and exact event lineage prove the answer", async () => {
    const redactedEvents = events()
    expect(redactedEvents[0].payload.questionId).toBe("[REDACTED]")
    expect(redactedEvents[1].payload.answerAvailable).toBe("[REDACTED]")
    const history = await recoverAnsweredQuestionHistory(client([item()], redactedEvents), input())
    expect(history).toEqual([
      { id: "agent-question:question-item:question", content: { role: "assistant", type: "question", question: "Continue?", options: [{ label: "Yes", value: "yes" }] } },
      { id: "agent-question:question-item:answer", content: { role: "user", type: "answer", questionId: "wait-1", text: "yes" } },
    ])
  })

  it("rejects a start event whose causation does not exactly match the durable question ID", async () => {
    await expect(recoverAnsweredQuestionHistory(client([item()], events({ causationId: "other-wait" })), input()))
      .rejects.toThrow("question_recovery_start_lineage_invalid")
  })

  it("still requires answer availability in the durable question item", async () => {
    const unavailable = item({ content: { ...item().content as object, answerAvailable: false } })
    await expect(recoverAnsweredQuestionHistory(client([unavailable], events()), input()))
      .rejects.toThrow("question_recovery_item_malformed")
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
    await expect(recoverAnsweredQuestionHistory(client([item({ stepId: "step-1" })]), input()))
      .resolves.toHaveLength(2)
    await expect(recoverAnsweredQuestionHistory(client(), input({
      toolItems: [{ id: "call-item", stepId: "other-step", taskId: "root-1", type: "tool_call", content: { toolCallId: "call-1" } }],
    }))).rejects.toThrow("question_recovery_step_missing")
  })

  it("accepts only the broker's user-scoped null-task answer event for a root-owned question", async () => {
    const rootQuestion = item({ taskId: "root-1", stepId: "step-1" })
    const start = { ...events()[0]!, taskId: "root-1" }
    await expect(recoverAnsweredQuestionHistory(client([rootQuestion], [start, events()[1]!]), input()))
      .resolves.toHaveLength(2)
    await expect(recoverAnsweredQuestionHistory(client([rootQuestion], [start, { ...events()[1]!, taskId: "foreign-root" }]), input()))
      .rejects.toThrow("question_recovery_event_scope_invalid")
    await expect(recoverAnsweredQuestionHistory(client([rootQuestion], [start, { ...events()[1]!, actor: "system" }]), input()))
      .rejects.toThrow("question_recovery_event_scope_invalid")
  })

  it("attaches a turn-scoped null-task wait only to the unique matching root-task call and step", async () => {
    const directQuestion = item({ stepId: "step-1" })
    const matchingCall = { id: "call-item", stepId: "step-1", taskId: "root-1", type: "tool_call", content: { toolCallId: "call-1" } }
    await expect(recoverAnsweredQuestionHistory(client([directQuestion]), input())).resolves.toHaveLength(2)
    await expect(recoverAnsweredQuestionHistory(client([directQuestion]), input({
      toolItems: [{ ...matchingCall, taskId: "foreign-root" }],
    }))).rejects.toThrow("question_recovery_tool_lineage_invalid")
    await expect(recoverAnsweredQuestionHistory(client([directQuestion]), input({
      toolItems: [{ ...matchingCall, stepId: "other-step" }],
    }))).rejects.toThrow("question_recovery_tool_lineage_invalid")
    await expect(recoverAnsweredQuestionHistory(client([directQuestion]), input({
      steps: [{ id: "step-1", taskId: "foreign-root" }],
    }))).rejects.toThrow("question_recovery_step_invalid")
    await expect(recoverAnsweredQuestionHistory(client([directQuestion]), input({
      toolItems: [matchingCall, { ...matchingCall, id: "duplicate-call-item" }],
    }))).rejects.toThrow("question_recovery_tool_lineage_invalid")
    await expect(recoverAnsweredQuestionHistory(client([directQuestion]), input({ steps: [] })))
      .rejects.toThrow("question_recovery_step_invalid")
    await expect(recoverAnsweredQuestionHistory(client([directQuestion]), input({ toolItems: [] })))
      .rejects.toThrow("question_recovery_tool_lineage_invalid")
  })

  it("rejects a task-root direct-step question without a tool-call ID before reading events", async () => {
    const queryLog: string[] = []
    const missingCall = item({ taskId: "root-1", stepId: "step-1", content: { ...item().content as object, toolCallId: null } })
    await expect(recoverAnsweredQuestionHistory(client([missingCall], events(), queryLog), input()))
      .rejects.toThrow("question_recovery_tool_lineage_invalid")
    expect(queryLog).toHaveLength(1)
    expect(queryLog[0]).toContain('FROM "agent_items"')
  })

  it("rejects null-task tool lineage when the canonical root task is missing", async () => {
    const queryLog: string[] = []
    const nullTaskCall = { id: "call-item", stepId: "step-1", taskId: null, type: "tool_call", content: { toolCallId: "call-1" } }
    await expect(recoverAnsweredQuestionHistory(client([item()], events(), queryLog), input({
      rootTaskId: null,
      steps: [{ id: "step-1", taskId: null }],
      toolItems: [nullTaskCall],
    }))).rejects.toThrow("question_recovery_tool_lineage_invalid")
    expect(queryLog).toHaveLength(1)
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
    await expect(recoverAnsweredQuestionHistory(client(), input({ steps: [], toolItems: [
      { type: "tool_call", stepId: null, taskId: "root-1", content: { toolCallId: "call-1" } },
    ] }))).rejects.toThrow("question_recovery_step_missing")
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
