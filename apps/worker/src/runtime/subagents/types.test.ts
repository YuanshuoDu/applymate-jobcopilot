import { describe, expect, it } from "vitest"
import { PAUSE_DEFERRED_MARKER, parseSubagentJobPayload } from "./types.js"
import type { SubagentContinuation, SubagentFinishResult, SubagentMailboxContinuation } from "./types.js"

describe("subagent dispatch transport contract", () => {
  it("exposes the durable pause-deferred fence and keeps payload parsing strict", () => {
    expect(PAUSE_DEFERRED_MARKER).toBe("deferred:session_pause_requested")
    expect(parseSubagentJobPayload({ taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "generation-2" }))
      .toEqual({ taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "generation-2" })
  })
})

describe("subagent finish continuation contract", () => {
  it("keeps children-pending control separate from mailbox message IDs", () => {
    const mailbox: SubagentMailboxContinuation = {
      kind: "mailbox_input_pending", missingMessageIds: ["message-1"], observedMessageIds: [],
    }
    const children: SubagentContinuation = { kind: "children_pending" }
    const finish: SubagentFinishResult = { status: "children_pending" }

    expect(mailbox).toEqual({ kind: "mailbox_input_pending", missingMessageIds: ["message-1"], observedMessageIds: [] })
    expect(children).toEqual({ kind: "children_pending" })
    expect("missingMessageIds" in children).toBe(false)
    expect(finish).toEqual({ status: "children_pending" })
    expect("messageIds" in finish).toBe(false)
  })
})
