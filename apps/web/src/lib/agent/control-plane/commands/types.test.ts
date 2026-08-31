import { describe, expect, it } from "vitest"

import { COMMAND_DISPOSITIONS } from "./types"

describe("Agent command contracts", () => {
  it("keeps the public disposition vocabulary closed", () => {
    expect(COMMAND_DISPOSITIONS).toEqual([
      "started",
      "steered",
      "queued_follow_up",
      "duplicate",
    ])
  })
})
