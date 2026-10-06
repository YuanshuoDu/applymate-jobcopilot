import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"
import type { ObjectiveStartCommand } from "./types"

import { ObjectiveStartCommandService } from "./objective-start"

const command = (objective: string, source: "user" | "automation" = "user") => ({
  sessionId: "session_1", userId: "user_1", clientMessageId: "start_1", source,
  objective, content: [{ type: "text" as const, text: "Supporting context" }],
})

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
})
