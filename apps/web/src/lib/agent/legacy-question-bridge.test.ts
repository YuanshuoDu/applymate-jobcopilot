import { describe, expect, it } from "vitest"

import {
  classifyLegacyQuestionBridge,
  type LegacyQuestionBridgeInput,
} from "./legacy-question-bridge"

const question = {
  id: "question_1",
  userId: "user_1",
  runId: "session_1",
  stage: "prepare",
  question: "Choose a path",
  options: [{ value: "keep", label: "Keep" }, { value: "skip", label: "Skip" }],
}

const turn = { id: "turn_1", sessionId: "session_1", userId: "user_1", status: "waiting_for_user" }

function proof(overrides: Partial<LegacyQuestionBridgeInput> = {}): LegacyQuestionBridgeInput {
  return {
    question,
    userId: "user_1",
    session: { id: "session_1", userId: "user_1" },
    activeTurns: [turn],
    item: {
      id: "agent-wait:question:question_1",
      sessionId: "session_1",
      turnId: "turn_1",
      type: "question",
      status: "started",
      content: {
        waitKind: "question",
        questionId: "question_1",
        stage: "prepare",
        question: "Choose a path",
        options: [{ label: "Keep", value: "keep" }, { label: "Skip", value: "skip" }],
      },
    },
    provenance: {
      sourceEvent: "orchestrator_question",
      sourcePayload: { id: "question_1" },
    },
    ...overrides,
  }
}

describe("classifyLegacyQuestionBridge", () => {
  it("bridges complete ownership, Turn, Item, content, and provenance proof", () => {
    expect(classifyLegacyQuestionBridge(proof())).toEqual({
      disposition: "bridged", questionId: "question_1", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:question:question_1",
    })
  })

  it("keeps the bridge pending when provenance is missing", () => {
    expect(classifyLegacyQuestionBridge(proof({ provenance: null }))).toEqual({ disposition: "bridge_pending", reason: "provenance_missing" })
  })

  it("keeps ambiguous active Turns pending without selecting the latest", () => {
    expect(classifyLegacyQuestionBridge(proof({ activeTurns: [turn, { ...turn, id: "turn_2" }] }))).toEqual({
      disposition: "bridge_pending", reason: "active_turn_ambiguous",
    })
  })

  it("rejects a mismatched canonical question Item", () => {
    expect(classifyLegacyQuestionBridge(proof({ item: { ...proof().item!, content: { ...proof().item!.content as object, question: "Different question" } } }))).toEqual({
      disposition: "legacy_only", reason: "canonical_item_mismatch",
    })
  })

  it("rejects foreign ownership before considering active Turn evidence", () => {
    expect(classifyLegacyQuestionBridge(proof({ userId: "user_2" }))).toEqual({ disposition: "legacy_only", reason: "foreign_ownership" })
  })

  it("treats JSON object-key order as equivalent but preserves option order", () => {
    expect(classifyLegacyQuestionBridge(proof())).toMatchObject({ disposition: "bridged" })
    expect(classifyLegacyQuestionBridge(proof({
      item: {
        ...proof().item!,
        content: {
          ...proof().item!.content as object,
          options: [{ value: "skip", label: "Skip" }, { value: "keep", label: "Keep" }],
        },
      },
    }))).toEqual({ disposition: "legacy_only", reason: "canonical_item_mismatch" })
  })

  it("rejects provenance that names a different legacy question", () => {
    expect(classifyLegacyQuestionBridge(proof({ provenance: { sourceEvent: "orchestrator_question", sourcePayload: { id: "question_2" } } }))).toEqual({
      disposition: "legacy_only", reason: "provenance_mismatch",
    })
  })
})
