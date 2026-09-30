import { describe, expect, it } from "vitest"

import { assertContent, dispositionFromEvent } from "./command-content"
import { invalidCommand } from "./errors"

describe("command content helpers", () => {
  it("requires at least one input part", () => {
    expect(() => assertContent([])).toThrow(invalidCommand("Agent commands require at least one content part"))
    expect(() => assertContent([{ type: "text", text: "Start" }])).not.toThrow()
  })

  it("uses a persisted disposition only when the event payload contains a known value", () => {
    expect(dispositionFromEvent({ sequence: BigInt(1), payload: { disposition: "steered" } }, "started")).toBe("steered")
    expect(dispositionFromEvent({ sequence: BigInt(1), payload: { disposition: "unknown" } }, "started")).toBe("started")
    expect(dispositionFromEvent(null, "queued_follow_up")).toBe("queued_follow_up")
  })
})
