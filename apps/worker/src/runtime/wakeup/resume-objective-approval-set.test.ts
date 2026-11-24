import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { AgentTurnWakeupPayload } from "./types.js"
import { assertObjectiveApprovalSetItem, assertObjectiveApprovalSetWakeupEvent } from "./resume-objective-approval-set.js"

const payload: AgentTurnWakeupPayload = {
  eventId: "event_1", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:approval-set:set_1",
  waitKind: "approval_set", waitId: "set_1", toolCallId: null, status: "resolved", nextTurnRevision: 8,
}
const mismatch = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }

describe("approval-set wakeup validation", () => {
  it("rejects an unrecognized item before querying member receipts", async () => {
    const client = { query: vi.fn() } as unknown as pg.PoolClient

    await expect(assertObjectiveApprovalSetItem(client, payload, "user_1", { taskId: null, content: {} }, mismatch))
      .rejects.toMatchObject({ code: "approval_set_lineage_mismatch" })
    expect(client.query).not.toHaveBeenCalled()
  })

  it("rejects a wake event whose durable actor does not match the grouped protocol", async () => {
    const client = { query: vi.fn(async () => ({ rows: [{
      sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, type: "turn.wakeup",
      taskId: null, actor: "system", correlationId: payload.turnId, causationId: "completion_1",
      idempotencyKey: `approval-set:${payload.waitId}:wakeup`, payload: {
        waitKind: payload.waitKind, waitId: payload.waitId, itemId: payload.itemId, turnId: payload.turnId,
        toolCallId: null, status: "resolved", nextTurnRevision: payload.nextTurnRevision,
      },
    }] })) } as unknown as pg.PoolClient

    await expect(assertObjectiveApprovalSetWakeupEvent(client, payload, mismatch))
      .rejects.toMatchObject({ code: "event_lineage_mismatch" })
    expect(client.query).toHaveBeenCalledOnce()
  })
})
