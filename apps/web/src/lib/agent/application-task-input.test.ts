import { describe, expect, it } from "vitest"
import { formQuestionFields, sanitizeConfirmedAnswers } from "./application-task-input"

describe("application task answer input", () => {
  const question = { missing: ["Portfolio URL"], sensitive: ["Visa sponsorship", "Salary expectation"] }

  it("keeps only legacy answers for fields the worker paused on", () => {
    expect(sanitizeConfirmedAnswers(question, {
      "Visa sponsorship": "No",
      invented: "model must not store this",
    })).toEqual({ "Visa sponsorship": "No" })
  })

  it("exposes a unique bounded list of legacy fields", () => {
    expect(formQuestionFields({ missing: ["A", "A"], sensitive: ["B"] })).toEqual([
      { key: "A", label: "A" }, { key: "B", label: "B" },
    ])
  })

  it("validates V2 answers by exact opaque key, even when labels repeat", () => {
    const first = "form-answer-v2-" + "a".repeat(64)
    const second = "form-answer-v2-" + "b".repeat(64)
    const questionV2 = { missing: [{ key: first, label: "Application field" }], sensitive: [{ key: second, label: "Application field" }] }

    expect(formQuestionFields(questionV2)).toEqual([
      { key: first, label: "Application field" }, { key: second, label: "Application field" },
    ])
    expect(sanitizeConfirmedAnswers(questionV2, {
      [first]: "No", ["form-answer-v2-" + "c".repeat(64)]: "wrong field", "Application field": "legacy guess",
    })).toEqual({ [first]: "No" })
  })

  it("keeps an invalid V2 key display-only and rejects it as an answer target", () => {
    const questionV2 = { missing: [{ key: "selector-name", label: "Work authorization" }] }
    expect(formQuestionFields(questionV2)).toEqual([{ key: null, label: "Work authorization" }])
    expect(sanitizeConfirmedAnswers(questionV2, { "selector-name": "No" })).toBeNull()
  })
})
