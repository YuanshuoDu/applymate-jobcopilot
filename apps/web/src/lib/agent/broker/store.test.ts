import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

import { answerQuestion, createQuestionWait, decideApproval } from "./store"

type Row = Record<string, any> // Test fixture rows mirror Prisma JSON records.

function fakeDb() {
  const turn: Row = { id: "turn_1", status: "in_progress", revision: 4 }
  const item: Row = {
    id: "agent-wait:question:question_1", status: "started", revision: 0,
    content: { waitKind: "question", questionId: "question_1", toolCallId: "call_1", stage: "profile", question: "Work authorisation?", options: [{ value: "yes", label: "Yes" }], answerAvailable: false },
  }
  const approval: Row = {
    id: "approval_1", sessionId: "session_1", userId: "user_1", turnId: "turn_1", toolCallId: "call_approval",
    status: "pending", revision: 4, scopeHash: "scope_hash", expiresAt: new Date("2026-09-02T00:00:00.000Z"),
  }
  const events: Row[] = []
  const outbox: Row[] = []
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      return strings.join(" ").includes("SELECT") ? [{ id: "session_1" }] : [{ eventSequence: BigInt(9) }]
    }),
    agentTurn: {
      findFirst: vi.fn(async () => ({ ...turn })),
      updateMany: vi.fn(async ({ where }: { where: Row }) => {
        if (where.revision !== turn.revision || where.id !== turn.id) return { count: 0 }
        turn.revision += 1
        if (where.status !== "waiting_for_user" && where.status !== "waiting_for_approval") turn.status = "waiting_for_user"
        return { count: 1 }
      }),
    },
    agentItem: {
      create: vi.fn(async ({ data }: { data: Row }) => { Object.assign(item, data); return data }),
      findFirst: vi.fn(async () => item),
      updateMany: vi.fn(async ({ data }: { data: Row }) => { Object.assign(item, data); item.status = "completed"; item.revision += 1; return { count: 1 } }),
      findMany: vi.fn(async () => []),
    },
    agentApproval: {
      findFirst: vi.fn(async () => approval),
      updateMany: vi.fn(async ({ data }: { data: Row }) => { Object.assign(approval, data); return { count: 1 } }),
    },
    agentEvent: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => events.find((event) => event.idempotencyKey === where.idempotencyKey) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => { const event = { ...data, id: data.id ?? `event_${events.length + 1}`, sequence: BigInt(events.length + 10) }; events.push(event); return event }),
    },
    agentOutbox: { create: vi.fn(async ({ data }: { data: Row }) => { outbox.push(data); return data }) },
  }
  const db = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient
  return { db, tx, turn, item, approval, events, outbox }
}

describe("Agent wait broker", () => {
  it("projects a question as a durable wait without creating another Turn", async () => {
    const fake = fakeDb()
    const result = await createQuestionWait(fake.db, {
      questionId: "question_1", sessionId: "session_1", userId: "user_1", turnId: "turn_1", toolCallId: "call_1",
      stage: "profile", question: "Work authorisation?", options: [{ value: "yes", label: "Yes" }], expectedTurnRevision: 4,
    })

    expect(result).toEqual({ itemId: "agent-wait:question:question_1", turnRevision: 5 })
    expect(fake.tx.agentTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "waiting_for_user" }) }))
    expect(fake.tx.agentTurn.findFirst).toHaveBeenCalledTimes(1)
  })

  it("answers the original question, wakes the same Turn, and keeps raw answer out of facts", async () => {
    const fake = fakeDb()
    fake.turn.status = "waiting_for_user"
    fake.turn.revision = 5
    const result = await answerQuestion(fake.db, {
      waitId: "question_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1", expectedRevision: 5,
      clientMessageId: "answer_1", answer: "yes",
    })

    expect(result).toMatchObject({ disposition: "resolved", status: "answered", turnId: "turn_1", toolCallId: "call_1", nextTurnRevision: 6 })
    expect(fake.item.content.answer).toBe("yes")
    expect(JSON.stringify(fake.events.map((event) => event.payload))).not.toContain("yes")
    expect(JSON.stringify(fake.outbox)).not.toContain("yes")
    expect(fake.events.some((event) => event.type === "turn.wakeup")).toBe(true)
  })

  it("returns an idempotent duplicate and does not attempt a second answer", async () => {
    const fake = fakeDb()
    fake.turn.status = "waiting_for_user"
    fake.turn.revision = 5
    const first = await answerQuestion(fake.db, {
      waitId: "question_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1", expectedRevision: 5,
      clientMessageId: "answer_retry", answer: "yes",
    })
    const second = await answerQuestion(fake.db, {
      waitId: "question_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1", expectedRevision: 5,
      clientMessageId: "answer_retry", answer: "yes",
    })

    expect(first.disposition).toBe("resolved")
    expect(second).toMatchObject({ disposition: "duplicate", sequence: first.sequence, turnId: "turn_1" })
    expect(fake.tx.agentItem.updateMany).toHaveBeenCalledTimes(1)
  })

  it("resolves a scoped approval without creating a new Turn", async () => {
    const fake = fakeDb()
    fake.turn.status = "waiting_for_approval"
    fake.turn.revision = 5
    fake.item.id = "agent-wait:approval:approval_1"
    fake.item.status = "started"
    fake.item.revision = 0
    fake.item.content = { waitKind: "approval", approvalId: "approval_1", toolCallId: "call_approval", scopeHash: "scope_hash" }
    const result = await decideApproval(fake.db, {
      waitId: "approval_1", sessionId: "session_1", userId: "user_1", expectedTurnId: "turn_1", expectedRevision: 5,
      clientMessageId: "approval_1_decision", decision: "approved", now: new Date("2026-09-01T00:00:00.000Z"),
    })

    expect(result).toMatchObject({ status: "approved", turnId: "turn_1", toolCallId: "call_approval" })
    expect(fake.approval.status).toBe("approved")
    expect(fake.turn.id).toBe("turn_1")
  })
})
