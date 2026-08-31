import { describe, expect, it } from "vitest"

import { MAX_MODEL_REROUTES } from "./index.js"

describe("selection public exports", () => {
  it("publishes a bounded reroute limit", () => {
    expect(MAX_MODEL_REROUTES).toBe(2)
  })
})
