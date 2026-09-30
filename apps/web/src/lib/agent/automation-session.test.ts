import { describe, expect, it, vi } from "vitest"
import { AutomationTurnOccupiedError, ensureAutomationTurn, resolveAutomationSession } from "./automation-session"

function session(id: string, options: { status?: string } = {}) {
  return {
    id,
    goal: "Run automation: Weekday Scout",
    status: options.status ?? "failed",
    source: "automation",
    memorySummary: "Dispatch failed",
    qualityScore: null,
    currentTaskId: null,
    createdAt: new Date("2026-08-29T08:00:00Z"),
    updatedAt: new Date("2026-08-29T08:00:00Z"),
    completedAt: new Date("2026-08-29T08:00:00Z"),
  }
}

describe("resolveAutomationSession", () => {
  it("reuses the session already linked to an automation", async () => {
    const existing = session("session_1")
    const db = {
      agentSession: { findFirst: vi.fn().mockResolvedValue(existing), create: vi.fn(), deleteMany: vi.fn() },
      agentAutomation: { updateMany: vi.fn(), findFirst: vi.fn() },
    }

    await expect(resolveAutomationSession(db, {
      automationId: "automation_1", userId: "user_1", sessionId: "session_1", name: "Weekday Scout",
    })).resolves.toEqual({ session: existing, created: false })
    expect(db.agentSession.create).not.toHaveBeenCalled()
  })

  it("reuses an existing runtime-paused session", async () => {
    const existing = session("session_1", { status: "paused" })
    const db = {
      agentSession: { findFirst: vi.fn().mockResolvedValue(existing), create: vi.fn(), deleteMany: vi.fn() },
      agentAutomation: { updateMany: vi.fn(), findFirst: vi.fn() },
    }

    await expect(resolveAutomationSession(db, {
      automationId: "automation_1", userId: "user_1", sessionId: "session_1", name: "Weekday Scout",
    })).resolves.toEqual({ session: existing, created: false })
  })

  it("creates and links one canonical session when none exists", async () => {
    const created = session("session_1")
    const db = {
      agentSession: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(created), deleteMany: vi.fn() },
      agentAutomation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findFirst: vi.fn() },
    }

    await expect(resolveAutomationSession(db, {
      automationId: "automation_1", userId: "user_1", name: "Weekday Scout",
    })).resolves.toEqual({ session: created, created: true })
    expect(db.agentAutomation.updateMany).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1", sessionId: null },
      data: { sessionId: "session_1" },
    })
  })
})

describe("ensureAutomationTurn", () => {
  it("creates one queued Turn after terminal history", async () => {
    const db = { agentTurn: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "turn_2" }) } }

    await expect(ensureAutomationTurn(db, { sessionId: "session_1", userId: "user_1", name: "Weekday Scout" }))
      .resolves.toEqual({ turnId: "turn_2", created: true })
    expect(db.agentTurn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sessionId: "session_1", userId: "user_1", source: "automation", status: "queued" }),
    }))
  })

  it("reuses an active Turn and does not create a duplicate run", async () => {
    const db = { agentTurn: { findFirst: vi.fn().mockResolvedValue({ id: "turn_active" }), create: vi.fn() } }

    await expect(ensureAutomationTurn(db, { sessionId: "session_1", userId: "user_1", name: "Weekday Scout" }))
      .resolves.toEqual({ turnId: "turn_active", created: false })
    expect(db.agentTurn.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1", userId: "user_1", source: "automation" }),
    }))
    expect(db.agentTurn.create).not.toHaveBeenCalled()
  })

  it("handles a concurrent create race by returning the active Turn", async () => {
    const db = {
      agentTurn: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "turn_raced" }),
        create: vi.fn().mockRejectedValue({ code: "P2002" }),
      },
    }

    await expect(ensureAutomationTurn(db, { sessionId: "session_1", userId: "user_1", name: "Weekday Scout" }))
      .resolves.toEqual({ turnId: "turn_raced", created: false })
    expect(db.agentTurn.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1", userId: "user_1", source: "automation" }),
    }))
  })

  it("fails closed when the create race belongs to a non-automation Turn", async () => {
    const db = {
      agentTurn: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        create: vi.fn().mockRejectedValue({ code: "P2002" }),
      },
    }

    await expect(ensureAutomationTurn(db, { sessionId: "session_1", userId: "user_1", name: "Weekday Scout" }))
      .rejects.toMatchObject({
        name: "AutomationTurnOccupiedError",
        code: "automation_turn_occupied",
        sessionId: "session_1",
      })
  })

  it("propagates non-unique database errors", async () => {
    const databaseError = new Error("database unavailable")
    const db = {
      agentTurn: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(databaseError),
      },
    }

    await expect(ensureAutomationTurn(db, { sessionId: "session_1", userId: "user_1", name: "Weekday Scout" }))
      .rejects.toBe(databaseError)
    expect(databaseError).not.toBeInstanceOf(AutomationTurnOccupiedError)
  })
})
