import { describe, expect, it } from "vitest"
import { formAnswerKeyForSelector, isAnswerableFormControl, isFormAnswerKeyV2 } from "./form-answer-key.js"

describe("form answer keys", () => {
  it("creates an opaque, versioned key deterministically from stable selector identity", () => {
    const first = formAnswerKeyForSelector("candidate-salary", "salary")
    const repeated = formAnswerKeyForSelector("candidate-salary", "salary")
    expect(first).toMatch(/^form-answer-v2-[a-f0-9]{64}$/)
    expect(first).toBe(repeated)
    expect(first).not.toContain("candidate-salary")
    expect(first).not.toContain("salary")
  })

  it("uses one stable selector identity and refuses fields without one", () => {
    expect(formAnswerKeyForSelector("field-id", "field-name")).toBe(formAnswerKeyForSelector("field-id", "other-name"))
    expect(formAnswerKeyForSelector(null, "field-name")).not.toBe(formAnswerKeyForSelector("field-id", "field-name"))
    expect(formAnswerKeyForSelector(null, null)).toBeNull()
    expect(formAnswerKeyForSelector(" ", " ")).toBeNull()
  })

  it("marks only deterministic text-like and single-select controls answerable", () => {
    expect(isAnswerableFormControl("input", "email")).toBe(true)
    expect(isAnswerableFormControl("textarea", "")).toBe(true)
    expect(isAnswerableFormControl("select", "", false)).toBe(true)
    expect(isAnswerableFormControl("select", "", true)).toBe(false)
    expect(isAnswerableFormControl("input", "radio")).toBe(false)
    expect(isAnswerableFormControl("input", "checkbox")).toBe(false)
    expect(isAnswerableFormControl("input", "password")).toBe(false)
  })

  it("recognizes only well-formed V2 keys", () => {
    expect(isFormAnswerKeyV2("form-answer-v2-" + "a".repeat(64))).toBe(true)
    expect(isFormAnswerKeyV2("form-answer-v2-selector-value")).toBe(false)
  })
})
