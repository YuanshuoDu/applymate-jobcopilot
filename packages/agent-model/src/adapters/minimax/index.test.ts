import { describe, expect, it } from "vitest"

import * as adapter from "./index.js"

describe("MiniMax adapter boundary", () => {
  it("exposes profile, registry, and request primitives", () => {
    expect(adapter.createMiniMaxAdapter).toBeTypeOf("function")
    expect(adapter.createMiniMaxModelRegistry).toBeTypeOf("function")
    expect(adapter.buildMiniMaxRequestBody).toBeTypeOf("function")
    expect(adapter.normalizeMiniMaxReasoningResponse).toBeTypeOf("function")
  })
})
