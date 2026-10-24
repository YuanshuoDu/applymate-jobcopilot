import { describe, expect, it } from "vitest"

import { reconcileRecoveredQuestionHistory } from "./turn-question-runtime-support.js"

const question = { id: "agent-question:item:question", content: { role: "assistant", type: "question", question: "Where?", options: [] } }
const answer = { id: "agent-question:item:answer", content: { role: "user", type: "answer", questionId: "wait-1", text: "Dublin" } }

describe("reconcileRecoveredQuestionHistory", () => {
  it("re-appends a validated pair after ordinary snapshot history without mutating the snapshot", () => {
    const ordinary = { id: "history:user:prior", content: { role: "user", text: "Earlier" } }
    const snapshot = [answer, ordinary, question]

    expect(reconcileRecoveredQuestionHistory(snapshot, [question, answer])).toEqual({
      snapshotHistory: [ordinary], historyToAppend: [question, answer],
    })
    expect(snapshot).toEqual([answer, ordinary, question])
  })

  it("uses recovered answer-event order when all pairs are present in opposite snapshot order", () => {
    const earlierQuestion = { id: "agent-question:earlier:question", content: { role: "assistant", type: "question", question: "Earlier?", options: [] } }
    const earlierAnswer = { id: "agent-question:earlier:answer", content: { role: "user", type: "answer", questionId: "wait-earlier", text: "First" } }
    const laterQuestion = { id: "agent-question:later:question", content: { role: "assistant", type: "question", question: "Later?", options: [] } }
    const laterAnswer = { id: "agent-question:later:answer", content: { role: "user", type: "answer", questionId: "wait-later", text: "Second" } }
    const firstOrdinary = { id: "history:user:a", content: { role: "user", text: "Keep first" } }
    const secondOrdinary = { id: "history:user:b", content: { role: "user", text: "Keep second" } }
    const snapshot = [laterAnswer, firstOrdinary, laterQuestion, secondOrdinary, earlierAnswer, earlierQuestion]

    expect(reconcileRecoveredQuestionHistory(snapshot, [earlierQuestion, earlierAnswer, laterQuestion, laterAnswer])).toEqual({
      snapshotHistory: [firstOrdinary, secondOrdinary],
      historyToAppend: [earlierQuestion, earlierAnswer, laterQuestion, laterAnswer],
    })
    expect(snapshot).toEqual([laterAnswer, firstOrdinary, laterQuestion, secondOrdinary, earlierAnswer, earlierQuestion])
  })

  it("restores an older absent pair before a newer partially present pair", () => {
    const olderQuestion = { id: "agent-question:older:question", content: { role: "assistant", type: "question", question: "Older?", options: [] } }
    const olderAnswer = { id: "agent-question:older:answer", content: { role: "user", type: "answer", questionId: "wait-older", text: "First" } }
    const newerQuestion = { id: "agent-question:newer:question", content: { role: "assistant", type: "question", question: "Newer?", options: [] } }
    const newerAnswer = { id: "agent-question:newer:answer", content: { role: "user", type: "answer", questionId: "wait-newer", text: "Second" } }
    const ordinary = { id: "history:user:between", content: { role: "user", text: "Keep this" } }
    const snapshot = [newerQuestion, ordinary]

    expect(reconcileRecoveredQuestionHistory(snapshot, [olderQuestion, olderAnswer, newerQuestion, newerAnswer])).toEqual({
      snapshotHistory: [ordinary],
      historyToAppend: [olderQuestion, olderAnswer, newerQuestion, newerAnswer],
    })
    expect(snapshot).toEqual([newerQuestion, ordinary])
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
