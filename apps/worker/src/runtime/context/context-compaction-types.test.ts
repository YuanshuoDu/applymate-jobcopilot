import { describe, expect, it } from "vitest"

import { COMPACTION_ITEM_TYPE, CompactionError } from "./context-compaction-types.js"

describe("context compaction contracts", () => {
  it("uses the protocol's generic compaction item type", () => {
    expect(COMPACTION_ITEM_TYPE).toBe("context_compaction")
  })

  it("exposes a typed failure without exposing source content", () => {
    const error = new CompactionError("invariant_loss", "Compaction invariant comparison failed")
    expect(error).toMatchObject({ name: "CompactionError", code: "invariant_loss" })
    expect(error.message).not.toContain("answer")
  })
})
