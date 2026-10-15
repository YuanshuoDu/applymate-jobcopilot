import { describe, expect, it } from "vitest"

import { planningClarificationContext } from "./planning-clarification-context.js"

const summary = {
  observedPlanRevision: 3,
  graphRevisionAtAsk: 4,
  pendingSteerCount: 2,
  unconsumedSteerCount: 1,
  inputThroughSequence: "12",
} as const

describe("planningClarificationContext", () => {
  it("renders the exact safe projection as a separate internal record block", () => {
    const history = [
      { id: "private-question-id:question", content: { role: "assistant", type: "question", question: "private question text" } },
      { id: "private-question-id:answer", content: { role: "user", type: "answer", text: "private answer text" } },
    ]
    const value = planningClarificationContext([{
      ...summary,
      questionItemId: "private-question-id",
      pendingInputIds: ["private-input-id"],
      question: "private question text",
    } as typeof summary], history, {
      questionEntryId: "private-question-id:question", answerEntryId: "private-question-id:answer",
    })

    expect(value.summaries).toEqual([summary])
    expect(value.afterAnswerEntryId).toBe("private-question-id:answer")
    expect(value.blocks).toEqual([{
      id: "planning-clarification:latest-answered-question",
      layer: "steer_history",
      role: "data",
      trust: "internal_record",
      source: "native_question_recovery",
      content: summary,
    }])
    expect(JSON.stringify({ summaries: value.summaries, blocks: value.blocks })).not.toContain("private-question-id")
    expect(JSON.stringify({ summaries: value.summaries, blocks: value.blocks })).not.toContain("private-input-id")
    expect(JSON.stringify({ summaries: value.summaries, blocks: value.blocks })).not.toContain("private question text")
  })

  it("supports an unknown agenda revision for a legacy asked question", () => {
    const history = [
      { id: "question", content: { role: "assistant", type: "question" } },
      { id: "answer", content: { role: "user", type: "answer" } },
    ]
    expect(planningClarificationContext([{ ...summary, observedPlanRevision: null }], history,
      { questionEntryId: "question", answerEntryId: "answer" }).blocks[0]?.content)
      .toEqual({ ...summary, observedPlanRevision: null })
  })

  it("omits metadata when the recovered pair is missing, incomplete, or non-adjacent", () => {
    const question = { id: "question", content: { role: "assistant", type: "question" } }
    const answer = { id: "answer", content: { role: "user", type: "answer" } }
    const pair = { questionEntryId: "question", answerEntryId: "answer" }
    expect(planningClarificationContext([summary]).summaries).toEqual([])
    expect(planningClarificationContext([summary], [question], pair).blocks).toEqual([])
    expect(planningClarificationContext([summary], [question, { id: "middle", content: "history" }, answer], pair).blocks).toEqual([])
    expect(planningClarificationContext([summary], [question, question, answer], pair).blocks).toEqual([])
  })

  it("fails closed for an invalid cursor, counts, revisions, or multiple latest projections", () => {
    expect(() => planningClarificationContext([{ ...summary, inputThroughSequence: "01" }])).toThrow("planning_clarification_summary_invalid")
    expect(() => planningClarificationContext([{ ...summary, unconsumedSteerCount: 3 }])).toThrow("planning_clarification_summary_invalid")
    expect(() => planningClarificationContext([{ ...summary, observedPlanRevision: -1 }])).toThrow("planning_clarification_summary_invalid")
    expect(() => planningClarificationContext([summary, summary])).toThrow("planning_clarification_latest_only")
  })
})
