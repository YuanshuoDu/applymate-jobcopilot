import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

vi.mock("@prisma/client", () => ({ Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) } }))

import { AgentSessionControlService } from "./session-control"

const command = {
  sessionId: "session_1", userId: "user_1", clientMessageId: "control_1", action: "pause" as const,
  expectedTurnId: "turn_1", expectedRevision: 3,
}
const activeTurn = { id: "turn_1", source: "user", status: "in_progress", revision: 3 }
const requestedAt = "2026-10-06T12:00:00.000Z"

function fixture(options: { status?: string; turn?: typeof activeTurn | null; existing?: unknown; owned?: boolean } = {}) {
  let status = options.status ?? "running"
  let rawQuery = 0
  const order: string[] = []
  const tx = {
    $queryRaw: vi.fn(async () => {
      rawQuery += 1
      return rawQuery === 1 ? (options.owned === false ? [] : [{ id: command.sessionId }]) : [{ eventSequence: 9n }]
    }),
    agentSession: {
      findFirst: vi.fn(async () => ({ status })),
      updateMany: vi.fn(async ({ data }: { data: { status: string } }) => {
        order.push("status")
        status = data.status
        return { count: 1 }
      }),
    },
    agentTurn: { findFirst: vi.fn(async () => options.turn === undefined ? activeTurn : options.turn) },
    agentEvent: {
      findFirst: vi.fn(async () => options.existing ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        order.push("event")
        return data
      }),
    },
    agentOutbox: { create: vi.fn(async () => ({})) },
  }
  const db = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient
  return { db, tx, order, service: new AgentSessionControlService(db, () => new Date(requestedAt)) }
}

describe("AgentSessionControlService", () => {
  it.each([
    ["pause", "running", "pausing", "session.pause_requested"],
    ["resume", "paused", "resuming", "session.resume_requested"],
  ] as const)("commits a %s status and durable request event together", async (action, previousStatus, nextStatus, eventType) => {
    const { service, tx, order } = fixture({ status: previousStatus })
    const result = await service.control({ ...command, action })

    expect(result).toEqual({ sessionId: command.sessionId, turnId: command.expectedTurnId, action, status: nextStatus, disposition: "requested", sequence: "9" })
    expect(tx.agentSession.updateMany).toHaveBeenCalledWith({
      where: { id: command.sessionId, userId: command.userId, status: previousStatus }, data: { status: nextStatus },
    })
    expect(tx.agentEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sessionId: command.sessionId, turnId: command.expectedTurnId, type: eventType, actor: "user",
      idempotencyKey: "agent-session-control:control_1",
      payload: { turnId: command.expectedTurnId, expectedRevision: command.expectedRevision, requestedAt },
    }) })
    expect(tx.agentOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      topic: "agent.session.event", aggregateId: command.sessionId, payload: expect.objectContaining({ type: eventType }),
    }) })
    expect(order).toEqual(["status", "event"])
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["pause", "pausing", "session.pause_requested"],
    ["resume", "resuming", "session.resume_requested"],
  ] as const)("returns a stable %s duplicate without changing the session again", async (action, status, eventType) => {
    const existing = { type: eventType, sequence: 12n,
      payload: { turnId: command.expectedTurnId, expectedRevision: command.expectedRevision, requestedAt } }
    const { service, tx, order } = fixture({ status, existing })
    await expect(service.control({ ...command, action })).resolves.toEqual({
      sessionId: command.sessionId, turnId: command.expectedTurnId, action, status, disposition: "duplicate", sequence: "12",
    })
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
    expect(order).toEqual([])
  })

  it("rejects idempotency-key reuse for a different action or Turn revision", async () => {
    const existing = { type: "session.pause_requested", sequence: 12n,
      payload: { turnId: command.expectedTurnId, expectedRevision: command.expectedRevision, requestedAt } }
    const mismatchedAction = fixture({ existing })
    await expect(mismatchedAction.service.control({ ...command, action: "resume" })).rejects.toMatchObject({ code: "session_control_idempotency_conflict" })
    const changedRevision = fixture({ existing })
    await expect(changedRevision.service.control({ ...command, expectedRevision: 4 })).rejects.toMatchObject({ code: "session_control_idempotency_conflict" })
  })

  it("checks owner, current Turn and revision, and allowed transition before writing", async () => {
    const foreign = fixture({ owned: false })
    await expect(foreign.service.control(command)).rejects.toMatchObject({ code: "agent_session_not_found" })
    expect(foreign.tx.agentTurn.findFirst).not.toHaveBeenCalled()

    const changedTurn = fixture({ turn: { ...activeTurn, id: "turn_other" } })
    await expect(changedTurn.service.control(command)).rejects.toMatchObject({ code: "active_turn_changed" })
    expect(changedTurn.tx.agentSession.updateMany).not.toHaveBeenCalled()

    const changedRevision = fixture({ turn: { ...activeTurn, revision: 4 } })
    await expect(changedRevision.service.control(command)).rejects.toMatchObject({ code: "active_turn_changed" })
    expect(changedRevision.tx.agentEvent.create).not.toHaveBeenCalled()

    for (const status of ["paused", "idle", "waiting_for_user"]) {
      const wrongState = fixture({ status })
      await expect(wrongState.service.control(command)).rejects.toMatchObject({ code: "session_control_state_conflict" })
      expect(wrongState.tx.agentSession.updateMany).not.toHaveBeenCalled()
      expect(wrongState.tx.agentEvent.create).not.toHaveBeenCalled()
    }
  })
})
