import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"
import type { ObjectiveStartCommand } from "./types"
import * as transaction from "./transaction"

import { ObjectiveStartCommandService } from "./objective-start"

const command = (objective: string, source: "user" | "automation" = "user") => ({
  sessionId: "session_1", userId: "user_1", clientMessageId: "start_1", source,
  objective, content: [{ type: "text" as const, text: "Supporting context" }],
})
const validRequirements = {
  schemaVersion: "agent-harness.v2.objective-requirements.v1",
  requirements: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } }],
}

function unsafeCommand(overrides: Readonly<Record<string, unknown>>): ObjectiveStartCommand {
  return { ...command("Find Dublin roles"), ...overrides } as unknown as ObjectiveStartCommand
}

describe("ObjectiveStartCommandService validation", () => {
  it("trims the objective and accepts the exact 2,000-byte boundary", async () => {
    const transaction = vi.fn(async () => { throw new Error("transaction reached") })
    const service = new ObjectiveStartCommandService({ $transaction: transaction } as unknown as PrismaClient)

    await expect(service.start(command(`  ${"a".repeat(1_998)}é  `))).rejects.toThrow("transaction reached")
    expect(transaction).toHaveBeenCalledOnce()
  })

  it("rejects malformed or oversized direct-service values before transaction", async () => {
    const transaction = vi.fn(async () => { throw new Error("transaction must not run") })
    const service = new ObjectiveStartCommandService({ $transaction: transaction } as unknown as PrismaClient)

    await expect(service.start(command("  "))).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(command("界".repeat(667)))).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ objective: undefined }))).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ objective: 42 }))).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ content: [] }))).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ content: [{ type: "text", text: "x".repeat(20_001) }] })))
      .rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ content: Array.from({ length: 33 }, () => ({ type: "text", text: "ok" })) })))
      .rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ content: Array.from({ length: 9 }, (_, i) => ({ type: "attachment_ref", attachmentId: `resume_${i}`, mediaType: "application/pdf" })) })))
      .rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ content: Array.from({ length: 14 }, () => ({ type: "text", text: "x".repeat(20_000) })) })))
      .rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ content: [{ type: "text", text: "ok", unexpected: true }] })))
      .rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(unsafeCommand({ content: [{ type: "attachment_ref", attachmentId: "   ", mediaType: "application/pdf" }] })))
      .rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start(command("Find Dublin roles", "automation"))).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    expect(transaction).not.toHaveBeenCalled()
  })

  it("hands only parsed requirements to root creation and keeps absent distinct from invalid", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "session_1", status: "running" }]),
      agentInput: { findFirst: vi.fn().mockResolvedValue(null) },
      agentTurn: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const db = {
      $transaction: (work: (value: unknown) => Promise<unknown>) => work(tx),
    } as unknown as PrismaClient
    const createRootTurn = vi.spyOn(transaction, "createRootTurn").mockResolvedValue({
      id: "turn_1", source: "user", status: "queued", revision: 0,
    })
    const acceptInputFacts = vi.spyOn(transaction, "acceptInputFacts").mockResolvedValue({
      inputId: "input_1", turnId: "turn_1", sequence: "1",
    })
    const service = new ObjectiveStartCommandService(db)

    try {
      await service.start(command("Find Dublin roles"))
      expect(createRootTurn.mock.calls[0]?.[6]).toBeUndefined()
      expect(Object.hasOwn(createRootTurn.mock.calls[0]?.[1] ?? {}, "verificationRequirements")).toBe(false)

      createRootTurn.mockClear()
      await service.start(unsafeCommand({ ...command("Find Dublin roles"), verificationRequirements: validRequirements }))
      expect(createRootTurn.mock.calls[0]?.[6]).toEqual(validRequirements)

      createRootTurn.mockClear()
      const malformed = { raw: "must not escape" }
      await service.start(unsafeCommand({ ...command("Find Dublin roles"), verificationRequirements: malformed }))
      expect(createRootTurn.mock.calls[0]?.[6]).toBeNull()
      expect(createRootTurn.mock.calls[0]?.[1]).toMatchObject({ source: "user", verificationRequirements: null })
      expect(createRootTurn.mock.calls[0]?.[1]).not.toMatchObject({ verificationRequirements: malformed })
    } finally {
      createRootTurn.mockRestore()
      acceptInputFacts.mockRestore()
    }
  })

  it("replays the original Turn and input when the same message ID carries different requirements", async () => {
    const existingInput = {
      id: "input_1", targetTurnId: "turn_1", delivery: "follow_up", acceptedSequence: BigInt(1),
    }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "session_1", status: "running" }]),
      agentInput: { findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existingInput) },
      agentTurn: {
        create: vi.fn().mockResolvedValue({ id: "turn_1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      agentOutbox: { create: vi.fn().mockResolvedValue({}) },
      agentEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const db = {
      $transaction: (work: (value: unknown) => Promise<unknown>) => work(tx),
    } as unknown as PrismaClient
    const acceptInputFacts = vi.spyOn(transaction, "acceptInputFacts").mockResolvedValue({
      inputId: "input_1", turnId: "turn_1", sequence: "1",
    })
    const service = new ObjectiveStartCommandService(db)
    const replayRequirements = {
      schemaVersion: "agent-harness.v2.objective-requirements.v1",
      requirements: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 2 } }],
    }

    try {
      const original = await service.start(unsafeCommand({
        ...command("Find Dublin roles"), verificationRequirements: validRequirements,
      }))
      const persistedInput = tx.agentTurn.create.mock.calls[0]?.[0]?.data.input
      expect(persistedInput).toMatchObject({ verificationRequirements: validRequirements })

      const replay = await service.start(unsafeCommand({
        ...command("Find Dublin roles"), verificationRequirements: replayRequirements,
      }))

      expect(replay).toMatchObject({
        inputId: original.inputId, turnId: original.turnId, disposition: "duplicate",
      })
      expect(tx.agentInput.findFirst).toHaveBeenCalledTimes(2)
      expect(tx.agentTurn.create).toHaveBeenCalledOnce()
      expect(acceptInputFacts).toHaveBeenCalledOnce()
      expect(tx.agentTurn.create.mock.calls[0]?.[0]?.data.input).toEqual(persistedInput)
    } finally {
      acceptInputFacts.mockRestore()
    }
  })
})
