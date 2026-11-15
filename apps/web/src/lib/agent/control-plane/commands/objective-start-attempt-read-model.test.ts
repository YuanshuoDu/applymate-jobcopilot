import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

import {
  listObjectiveStartAttempts,
  objectiveStartReceiptTargetExists,
  stateWithAvailableReceiptTarget,
  taskRecoveryAccountScope,
} from "./objective-start-attempt-read-model"

const receipt = { sessionId: "session_1", inputId: "input_1", turnId: "turn_1", sequence: "7" }

describe("objective start attempt read model", () => {
  it("derives a stable opaque account scope from the authenticated user", () => {
    expect(taskRecoveryAccountScope("user_1")).toMatch(/^[a-f0-9]{64}$/)
    expect(taskRecoveryAccountScope("user_1")).toBe(taskRecoveryAccountScope("user_1"))
    expect(taskRecoveryAccountScope("user_1")).not.toBe(taskRecoveryAccountScope("user_2"))
  })

  it("requires an owner session containing the owner turn for a receipt", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "session_1" })
    const db = { agentSession: { findFirst } } as unknown as PrismaClient

    await expect(objectiveStartReceiptTargetExists(db, "user_1", receipt)).resolves.toBe(true)
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1", turns: { some: { id: "turn_1", userId: "user_1" } } },
      select: { id: true },
    })
    findFirst.mockResolvedValue(null)
    await expect(objectiveStartReceiptTargetExists(db, "user_1", receipt)).resolves.toBe(false)
  })

  it("returns a stable account partition without exposing identity or prompt data", async () => {
    const rows = [{
      clientMessageId: "attempt_1", status: "accepted", sessionId: "session_1", inputId: "input_1", turnId: "turn_1",
      acceptedSequence: BigInt(7), createdAt: new Date("2026-11-12T10:00:00Z"), updatedAt: new Date("2026-11-12T10:00:00Z"),
    }]
    const findMany = vi.fn().mockResolvedValue(rows)
    const db = {
      agentSession: { findFirst: vi.fn().mockResolvedValue({ id: "session_1" }) },
      agentObjectiveStartAttempt: { findMany },
    } as unknown as PrismaClient

    const first = await listObjectiveStartAttempts(db, "user_1", 20)
    const second = await listObjectiveStartAttempts(db, "user_1", 20)
    expect(second.accountScope).toBe(first.accountScope)
    expect(JSON.stringify(first)).not.toContain("user_1")
    expect(JSON.stringify(first)).not.toContain("Private objective")
    expect(first.attempts[0]).toMatchObject({ state: "accepted", sessionId: "session_1", receipt: { sequence: "7" } })
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "user_1" }, orderBy: { createdAt: "desc" }, take: 20,
      select: { clientMessageId: true, status: true, sessionId: true, inputId: true, turnId: true, acceptedSequence: true, createdAt: true, updatedAt: true },
    })
  })

  it("maps accepted receipts with deleted targets to unavailable without exposing a stale receipt", async () => {
    const agentSessionFindFirst = vi.fn().mockResolvedValue(null)
    const findMany = vi.fn().mockResolvedValue([{
      clientMessageId: "attempt_1", status: "accepted", sessionId: "session_1", inputId: "input_1", turnId: "turn_1",
      acceptedSequence: BigInt(7), createdAt: new Date("2026-11-12T10:00:00Z"), updatedAt: new Date("2026-11-12T10:00:00Z"),
    }])
    const db = {
      agentSession: { findFirst: agentSessionFindFirst },
      agentObjectiveStartAttempt: { findMany },
    } as unknown as PrismaClient

    await expect(stateWithAvailableReceiptTarget(db, "user_1", { state: "accepted", receipt })).resolves.toEqual({ state: "unavailable" })
    const result = await listObjectiveStartAttempts(db, "user_1", 20)
    expect(result.attempts[0]).toMatchObject({ state: "unavailable", clientMessageId: "attempt_1" })
    expect(result.attempts[0]).not.toHaveProperty("receipt")
    expect(result.accountScope).toBe(taskRecoveryAccountScope("user_1"))
  })
})
