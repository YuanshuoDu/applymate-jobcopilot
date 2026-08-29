import { describe, expect, it, vi } from "vitest"
import { resolveAutomationSession } from "./automation-session"

function session(id: string) {
  return {
    id,
    goal: "Run automation: Weekday Scout",
    status: "failed",
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
