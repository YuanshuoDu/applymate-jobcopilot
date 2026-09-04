import { describe, expect, it } from "vitest"

import { mockAtsSubmit } from "./dry-run-submit.js"

describe("application submit dry-run script", () => {
  it("uses a deterministic mock provider and never performs an external request", async () => {
    const result = await mockAtsSubmit({
      target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit: async () => true,
    })
    expect(result).toEqual({ confirmationId: "mock-confirmation-0001", postSubmitUrl: "https://mock-ats.invalid/confirmation" })
  })
})
