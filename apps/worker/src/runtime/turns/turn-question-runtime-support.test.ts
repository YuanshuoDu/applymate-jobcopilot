import { describe, expect, it } from "vitest"

import { reconcileRecoveredQuestionHistory } from "./turn-question-runtime-support.js"

const question = { id: "agent-question:item:question", content: { role: "assistant", type: "question", question: "Where?", options: [] } }
const answer = { id: "agent-question:item:answer", content: { role: "user", type: "answer", questionId: "wait-1", text: "Dublin" } }

describe("reconcileRecoveredQuestionHistory", () => {
  it("restores an exact durable pair in place after snapshot ID sorting", () => {
    const ordinary = { id: "history:user:prior", content: { role: "user", text: "Earlier" } }
    const snapshot = [answer, ordinary, question]

    expect(reconcileRecoveredQuestionHistory(snapshot, [question, answer])).toEqual({
      snapshotHistory: [question, answer, ordinary], historyToAppend: [],
    })
    expect(snapshot).toEqual([answer, ordinary, question])
  })

  it.each([
    ["changed question", { ...question, content: { ...question.content, question: "Changed?" } }],
    ["changed answer", { ...answer, content: { ...answer.content, text: "Changed" } }],
    ["same ID with a non-Q/A kind", { ...question, content: { role: "assistant", type: "narrative", question: "Where?", options: [] } }],
  ] as const)("rejects a persisted %s collision", (_label, changed) => {
    const snapshot = changed.id === question.id ? [answer, changed] : [changed, question]
    expect(() => reconcileRecoveredQuestionHistory(snapshot, [question, answer])).toThrow("question_recovery_history_collision")
  })

  it("does not infer durable pairs from ID text and rejects malformed recovery output", () => {
    const unverified = { id: "agent-question:forged:question", content: { role: "assistant", type: "question" } }
    expect(reconcileRecoveredQuestionHistory([unverified], [])).toEqual({ snapshotHistory: [unverified], historyToAppend: [] })
    expect(() => reconcileRecoveredQuestionHistory([], [answer, question])).toThrow("question_recovery_history_pair_invalid")
  })
})
