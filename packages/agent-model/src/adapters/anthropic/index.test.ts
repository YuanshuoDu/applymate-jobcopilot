import { describe, expect, it } from "vitest"

import * as adapter from "./index.js"

describe("Anthropic adapter boundary", () => {
  it("exposes the server-side adapter primitives", () => {
    expect(adapter.createAnthropicAdapter).toBeTypeOf("function")
    expect(adapter.buildAnthropicRequest).toBeTypeOf("function")
    expect(adapter.AnthropicMessagesParser).toBeTypeOf("function")
  })
})
