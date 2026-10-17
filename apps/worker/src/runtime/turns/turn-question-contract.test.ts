import { describe, expect, it } from "vitest"

import { parseTurnQuestionArguments, parseTurnQuestionIntentEnvelope, TURN_QUESTION_INTENT_SCHEMA } from "./turn-question-contract.js"

describe("native user question contract", () => {
  it("normalizes one question and maps choices into canonical options", () => {
    expect(parseTurnQuestionArguments({ question: "  Which location?  ", choices: [{ label: " Berlin ", value: " de-ber " }] })).toEqual({
      schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input",
      question: "Which location?", options: [{ label: "Berlin", value: "de-ber" }],
    })
    expect(parseTurnQuestionArguments({ question: "Your preferred date?" })?.options).toEqual([])
  })

  it("enforces byte bounds, unique choices, and exact model keys", () => {
    expect(parseTurnQuestionArguments({ question: "x".repeat(2_001) })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "é".repeat(1_001) })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "x", extra: "owner" })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "x", choices: [{ label: "a", value: "same" }, { label: "b", value: "same" }] })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "x", choices: Array.from({ length: 7 }, (_, index) => ({ label: `L${index}`, value: `V${index}` })) })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "x", choices: [{ label: "a".repeat(201), value: "yes" }] })).toBeNull()
  })

  it("accepts only the exact bounded server intent envelope for durable recovery", () => {
    const envelope = parseTurnQuestionArguments({ question: "Which region?", choices: [{ label: "North", value: "north" }] })!
    expect(parseTurnQuestionIntentEnvelope(envelope)).toEqual(envelope)
    expect(parseTurnQuestionIntentEnvelope({ ...envelope, toolCallId: "model-owned" })).toBeNull()
    expect(parseTurnQuestionIntentEnvelope({ ...envelope, stage: "approval" })).toBeNull()
    expect(parseTurnQuestionIntentEnvelope({ ...envelope, options: [{ label: "North", value: "north", secret: "x" }] })).toBeNull()
    expect(parseTurnQuestionIntentEnvelope({ ...envelope, question: " x ".repeat(1000) })).toBeNull()
  })
})
