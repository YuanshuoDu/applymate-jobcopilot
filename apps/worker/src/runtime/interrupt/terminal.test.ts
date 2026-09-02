import { describe, expect, it } from "vitest"

import { InMemoryTerminalEventPort } from "./terminal.js"

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }

describe("terminal event port", () => {
  it("appends one terminal event for concurrent Stop calls and keeps payload metadata", async () => {
    const terminal = new InMemoryTerminalEventPort()
    const [first, second] = await Promise.all([
      terminal.append({ ...target, requestId: "stop-1", reason: "user_stop", payload: { operationCount: 2 } }),
      terminal.append({ ...target, requestId: "stop-2", reason: "duplicate_stop", payload: ["metadata"] }),
    ])
    expect([first, second].sort()).toEqual(["appended", "duplicate"])
    const lookupTarget = { ...target, payload: { lookup: true } }
    expect(terminal.events(lookupTarget)).toHaveLength(1)
    expect(terminal.events()[0].payload).toEqual({ operationCount: 2 })
  })
})
