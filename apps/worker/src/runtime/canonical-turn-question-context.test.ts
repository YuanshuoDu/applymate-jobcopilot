import { describe, expect, it } from "vitest"

import { collectContextSnapshot } from "./context/context-snapshot-collector.js"
import { mergeCanonicalTurnQuestionContext } from "./canonical-turn-question-context.js"

describe("mergeCanonicalTurnQuestionContext", () => {
  it("keeps safe planning observations separate while preserving prior and answered history", () => {
    const duplicate = { id: "snapshot-entry", content: { role: "assistant", text: "already present" } }
    const question = { id: "agent-question:item:question", content: { role: "assistant", type: "question", question: "Where?" } }
    const answer = { id: "agent-question:item:answer", content: { role: "user", type: "answer", text: "Germany" } }
    const summary = { observedPlanRevision: 2, graphRevisionAtAsk: 3, pendingSteerCount: 1, unconsumedSteerCount: 1, inputThroughSequence: "9" }
    const selectedPair = { questionEntryId: question.id, answerEntryId: answer.id }
    const snapshot = { system: [], profile: [], steerHistory: [duplicate, question, answer], businessRefs: [], toolObservations: [],
      planningClarificationHistoryPair: { questionEntryId: "saved-question", answerEntryId: "saved-answer" } }
    const result = mergeCanonicalTurnQuestionContext({
      snapshot,
      priorHistory: [
        { ...duplicate, sequence: 2n },
        { id: "prior-user:input", content: { role: "user", text: "Previous request" }, sequence: 3n },
      ],
      recovered: { history: [], planningClarifications: [summary], planningClarificationHistoryPair: selectedPair },
    })

    expect(result.steerHistory).toEqual([duplicate, question, answer, { id: "prior-user:input", content: { role: "user", text: "Previous request" } }])
    expect(result.planningClarifications).toEqual([summary])
    expect(result.planningClarificationHistoryPair).toEqual(selectedPair)
    expect(JSON.stringify(result.steerHistory)).not.toContain("graphRevisionAtAsk")
    expect(JSON.stringify(result.planningClarifications)).not.toContain("Germany")
  })

  it("discards saved pair anchors when live recovery has no current validated pair", () => {
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [],
      planningClarificationHistoryPair: { questionEntryId: "saved-question", answerEntryId: "saved-answer" } }
    const result = mergeCanonicalTurnQuestionContext({ snapshot, priorHistory: [], recovered: { history: [], planningClarifications: [] } })
    expect(result).not.toHaveProperty("planningClarificationHistoryPair")
    expect(result.planningClarifications).toEqual([])
  })

  it("strips the transient pair association from durable snapshot context", async () => {
    const pair = { questionEntryId: "agent-question:private:question", answerEntryId: "agent-question:private:answer" }
    const question = { id: pair.questionEntryId, content: { role: "assistant", type: "question", question: "Where?" } }
    const answer = { id: pair.answerEntryId, content: { role: "user", type: "answer", text: "Germany" } }
    const snapshot = await collectContextSnapshot({
      scope: { userId: "user-1" }, sessionId: "session-1", throughSequence: 9n,
      source: {
        goal: "Find roles", userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [],
        artifacts: [], facts: [], failedAttempts: [], references: [], tokenUsage: [],
        context: { system: [], profile: [], steerHistory: [question, answer], toolObservations: [], planningClarificationHistoryPair: pair } as never,
      },
      references: { verify: async reference => ({ ...reference, verified: true as const }) },
    })
    expect(snapshot.content.context.steerHistory).toEqual([answer, question])
    expect(snapshot.content.context).not.toHaveProperty("planningClarificationHistoryPair")
  })
})
