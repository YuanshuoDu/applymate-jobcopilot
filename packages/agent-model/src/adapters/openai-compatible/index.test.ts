import { describe, expect, it } from "vitest"

import * as adapter from "./index.js"

describe("OpenAI-compatible adapter boundary", () => {
  it("exposes the adapter through its server-side subpath", () => {
    expect(adapter.createOpenAiCompatibleAdapter).toBeTypeOf("function")
    expect(adapter.buildOpenAiRequest).toBeTypeOf("function")
    expect(adapter.ChatCompletionsParser).toBeTypeOf("function")
    expect(adapter.ResponsesParser).toBeTypeOf("function")
  })
})
