import { describe, expect, it, vi } from "vitest"

import { assertExpectedTurn, commandEventKey, createRootTurn, fallbackDisposition, lockOpenSession, type CommandTransaction } from "./transaction"
import { activeTurnChanged } from "./errors"

describe("Agent command transaction helpers", () => {
  it("uses stable command event keys and original delivery for fallback idempotency", () => {
    expect(commandEventKey("client-1")).toBe("agent-command:client-1")
    expect(fallbackDisposition({ id: "input", targetTurnId: "turn", delivery: "follow_up", acceptedSequence: BigInt(1) }, "follow_up")).toBe("queued_follow_up")
  })

  it("guards expected turn and revision together", async () => {
    await expect(assertExpectedTurn("stale", 2, { id: "current", source: "user", status: "in_progress", revision: 3 }))
      .rejects.toMatchObject(activeTurnChanged("stale", "current"))
  })

  it("locks an open session by user before command writes", async () => {
    const queryRaw = vi.fn(async (_query: unknown) => [{ id: "session_1", controlGate: "open", controlRevision: 0, pausedAt: null }])
    await lockOpenSession({ $queryRaw: queryRaw } as unknown as CommandTransaction, "session_1", "user_1")

    const query = queryRaw.mock.calls[0]?.[0] as unknown as { strings?: readonly string[] }
    const sql = query.strings?.join(" ") ?? ""
    expect(sql).toContain('"userId" =')
    expect(sql).toContain('"status" NOT IN (\'aborted\', \'archived\')')
    expect(sql).toContain("FOR UPDATE")
  })

  it("scopes the root Turn dispatch outbox row to its session", async () => {
    const agentTurn = { create: vi.fn().mockResolvedValue({ id: "turn_1" }) }
    const agentOutbox = { create: vi.fn().mockResolvedValue({}) }
    const command = { sessionId: "session_1", userId: "user_1", clientMessageId: "client_1", source: "user" as const }

    await createRootTurn(
      { agentTurn, agentOutbox } as unknown as CommandTransaction,
      command,
      [{ type: "text", text: "Start" }],
      "Canonical goal",
    )

    const turnData = agentTurn.create.mock.calls[0]?.[0]?.data
    expect(turnData.input).toEqual(expect.objectContaining({ goal: "Canonical goal" }))
    const outboxData = agentOutbox.create.mock.calls[0]?.[0]?.data
    expect(outboxData).toEqual(expect.objectContaining({
      aggregateId: command.sessionId,
      idempotencyKey: "turn-dispatch:turn_1",
    }))
    expect(outboxData.aggregateId).not.toBe("turn_1")
  })
})
