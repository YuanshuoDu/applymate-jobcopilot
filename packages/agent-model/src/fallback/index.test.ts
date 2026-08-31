import { describe, expect, it } from "vitest"

import { MAX_REPAIR_ATTEMPTS, isCursorLoss, parseNextStep } from "./index.js"

describe("fallback public exports", () => {
  it("exports the bounded repair parser", async () => {
    expect(MAX_REPAIR_ATTEMPTS).toBe(1)
    await expect(parseNextStep({
      schemaVersion: "agent-harness.v2", kind: "finish", response: { text: "done" },
    })).resolves.toMatchObject({ repairAttempts: 0 })
    expect(isCursorLoss(new Error("not typed"))).toBe(false)
  })
})
