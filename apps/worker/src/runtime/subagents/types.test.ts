import { describe, expect, it } from "vitest"
import { PAUSE_DEFERRED_MARKER, parseSubagentJobPayload } from "./types.js"

describe("subagent dispatch transport contract", () => {
  it("exposes the durable pause-deferred fence and keeps payload parsing strict", () => {
    expect(PAUSE_DEFERRED_MARKER).toBe("deferred:session_pause_requested")
    expect(parseSubagentJobPayload({ taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "generation-2" }))
      .toEqual({ taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "generation-2" })
  })
})
