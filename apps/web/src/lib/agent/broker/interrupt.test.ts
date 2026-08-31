import { describe, expect, it, vi } from "vitest"

import { cancelPendingWaitsInTransaction } from "./interrupt"

type Row = Record<string, any> // Fixture rows intentionally model Prisma JSON records.

describe("Agent wait interrupt cleanup", () => {
  it("marks pending waits interrupted and cancels the approval in one transaction", async () => {
    const item: Row = {
      id: "agent-wait:approval:approval_1", type: "approval_request", revision: 0,
      content: { approvalId: "approval_1", toolCallId: "call_1" },
    }
    const events: Row[] = []
    const tx = {
      agentItem: {
        findMany: vi.fn(async () => [item]),
        updateMany: vi.fn(async ({ data }: { data: Row }) => { item.status = data.status; item.content = data.content; return { count: 1 } }),
      },
      agentApproval: { updateMany: vi.fn(async () => ({ count: 1 })) },
      agentEvent: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Row }) => { events.push(data); return { ...data, sequence: BigInt(1) } }),
      },
      agentOutbox: { create: vi.fn(async () => ({ id: "outbox_1" })) },
      $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(1) }]),
    }

    await cancelPendingWaitsInTransaction(tx as never, { sessionId: "session_1", userId: "user_1", turnId: "turn_1", clientMessageId: "interrupt_1" })

    expect(item.status).toBe("interrupted")
    expect(item.content).toMatchObject({ cancelled: true, cancellationReason: "interrupt" })
    expect(tx.agentApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "pending" }), data: expect.objectContaining({ status: "rejected" }) }))
    expect(events[0].payload).toMatchObject({ outcome: "cancelled", reason: "interrupt", toolCallId: "call_1" })
  })
})
