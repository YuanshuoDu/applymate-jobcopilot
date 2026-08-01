import { describe, expect, it } from "vitest"
import { formQuestionFields, sanitizeConfirmedAnswers } from "./application-task-input"

describe("application task answer input", () => {
  const question = { missing: ["Portfolio URL"], sensitive: ["Visa sponsorship", "Salary expectation"] }

  it("keeps only answers for fields the worker paused on", () => {
    expect(sanitizeConfirmedAnswers(question, {
      "Visa sponsorship": "No",
      invented: "model must not store this",
    })).toEqual({ "Visa sponsorship": "No" })
  })

  it("exposes a unique bounded list of fields", () => {
    expect(formQuestionFields({ missing: ["A", "A"], sensitive: ["B"] })).toEqual(["A", "B"])
  })
})
