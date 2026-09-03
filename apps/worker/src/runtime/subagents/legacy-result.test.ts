import { describe, expect, it } from "vitest"

import { normalizeLegacySubagentResult } from "./legacy-result.js"

describe("legacy subagent result compatibility", () => {
  it("normalizes legacy success and error shapes", () => {
    expect(normalizeLegacySubagentResult({ status: "success", output: { id: "evidence-a" } })).toEqual({ status: "completed", result: { id: "evidence-a" } })
    expect(normalizeLegacySubagentResult({ ok: false, error: "old failure" })).toMatchObject({ status: "failed", failureReason: "old failure" })
  })

  it("keeps unknown legacy values typed and non-executable", () => {
    expect(normalizeLegacySubagentResult({ answer: "done" })).toEqual({ status: "completed", result: { legacy: true, value: { answer: "done" } } })
  })
})
