import { describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import type { PrismaClient } from "@prisma/client"

import {
  abandonObjectiveStartAttempt,
  getObjectiveStartAttempt,
  isValidAttemptKey,
  lockObjectiveStartAttempt,
  lookupAttemptForStart,
  objectiveStartRequestHash,
} from "./objective-start-attempt-ledger"
import type { CommandTransaction } from "./transaction"
import type { ObjectiveStartCommand } from "./types"

const content = [{ type: "text" as const, text: "Context stays byte-for-byte." }]
const command: ObjectiveStartCommand = {
  userId: "user_1", sessionId: "session_1", clientMessageId: "attempt_1", source: "user",
  objective: " Find Dublin roles ", content,
}

function legacyInput(overrides: Record<string, unknown> = {}, intent: unknown = OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT) {
  return {
    id: "input_1", userId: "user_1", sessionId: "session_1", clientMessageId: "attempt_1",
    targetTurnId: "turn_1", delivery: "follow_up", status: "accepted", content,
    acceptedSequence: BigInt(7), consumedByStepId: null, consumedAt: null, cancelledAt: null,
    session: { userId: "user_1" },
    targetTurn: {
      id: "turn_1", sessionId: "session_1", userId: "user_1", source: "user",
      input: { goal: "Find Dublin roles", content, clientMessageId: "attempt_1", intent },
    },
    ...overrides,
  }
}

function legacyEvent() {
  return {
    type: "input.accepted", actor: "user", turnId: "turn_1", sequence: BigInt(7),
    payload: { inputId: "input_1", clientMessageId: "attempt_1", source: "user", delivery: "follow_up", disposition: "started" },
  }
}

describe("objective start attempt ledger", () => {
  it("preserves the existing trimmed 256-character ObjectiveStart key contract", () => {
    expect(isValidAttemptKey("k".repeat(256))).toBe(true)
    expect(isValidAttemptKey("k".repeat(257))).toBe(false)
    expect(isValidAttemptKey(" attempt_1")).toBe(false)
    expect(isValidAttemptKey("   ")).toBe(false)
  })

  it("hashes normalized objective intent while distinguishing target, context, and omitted requirements", () => {
    const normalized = objectiveStartRequestHash({ ...command, objective: "Find Dublin roles" })
    expect(objectiveStartRequestHash(command)).toBe(normalized)
    expect(objectiveStartRequestHash({ ...command, sessionId: "session_2" })).not.toBe(normalized)
    expect(objectiveStartRequestHash({ ...command, content: [{ type: "text", text: "Other context" }] })).not.toBe(normalized)
    expect(objectiveStartRequestHash({ ...command, verificationRequirements: null })).not.toBe(normalized)
  })

  it("hashes JSON-persisted object keys canonically while preserving array order", () => {
    const ordered = {
      ...command,
      content: [
        { type: "attachment_ref" as const, attachmentId: "resume_1", mediaType: "application/pdf", filename: "cv.pdf" },
        { type: "text" as const, text: "Context stays byte-for-byte." },
      ],
    }
    const reorderedKeys = {
      ...command,
      content: [
        { filename: "cv.pdf", mediaType: "application/pdf", attachmentId: "resume_1", type: "attachment_ref" as const },
        { text: "Context stays byte-for-byte.", type: "text" as const },
      ],
    }
    const omittedOptionalFilename = {
      ...command,
      content: [
        { type: "attachment_ref" as const, attachmentId: "resume_1", mediaType: "application/pdf", filename: undefined },
        ordered.content[1],
      ],
    }
    const withoutFilename = {
      ...command,
      content: [
        { type: "attachment_ref" as const, attachmentId: "resume_1", mediaType: "application/pdf" },
        ordered.content[1],
      ],
    }

    expect(objectiveStartRequestHash(reorderedKeys)).toBe(objectiveStartRequestHash(ordered))
    expect(objectiveStartRequestHash(omittedOptionalFilename)).toBe(objectiveStartRequestHash(withoutFilename))
    expect(objectiveStartRequestHash({ ...ordered, content: [...ordered.content].reverse() })).not.toBe(objectiveStartRequestHash(ordered))
    expect(objectiveStartRequestHash({ ...ordered, content: [ordered.content[0], { type: "text", text: "Changed context" }] })).not.toBe(objectiveStartRequestHash(ordered))
  })

  it("uses one owner-and-key transaction advisory lock", async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    await lockObjectiveStartAttempt({ $queryRaw: queryRaw } as unknown as CommandTransaction, "user_1", "attempt_1")
    const query = queryRaw.mock.calls[0]?.[0] as { sql?: string; values?: unknown[] }
    expect(query.sql).toContain("pg_advisory_xact_lock(hashtextextended")
    expect(query.sql).toContain("::text AS lock_acquired")
    expect(query.values).toContain("user_1")
    expect(query.values).toContain("attempt_1")
  })

  it("replays only the same stored request and target", async () => {
    const requestHash = objectiveStartRequestHash({ ...command, objective: command.objective.trim() })
    const findUnique = vi.fn().mockResolvedValue({
      status: "accepted", sessionId: "session_1", requestHash, inputId: "input_1", turnId: "turn_1", acceptedSequence: BigInt(7),
    })
    const tx = { agentObjectiveStartAttempt: { findUnique } }

    await expect(lookupAttemptForStart(tx as unknown as CommandTransaction, { ...command, objective: command.objective.trim() }, requestHash))
      .resolves.toEqual({ sessionId: "session_1", inputId: "input_1", turnId: "turn_1", sequence: "7" })
    const changedCommand = { ...command, objective: "Other task" }
    await expect(lookupAttemptForStart(tx as unknown as CommandTransaction, changedCommand, objectiveStartRequestHash(changedCommand)))
      .rejects.toMatchObject({ code: "objective_start_idempotency_conflict", status: 409 })
  })

  it("reads a verified legacy Objective receipt without writing an adoption row", async () => {
    const ledgerFindUnique = vi.fn().mockResolvedValue(null)
    const findMany = vi.fn().mockResolvedValue([legacyInput()])
    const eventFindFirst = vi.fn().mockResolvedValue(legacyEvent())
    const create = vi.fn()
    const tx = {
      agentInput: { findMany }, agentEvent: { findFirst: eventFindFirst },
      agentObjectiveStartAttempt: { create },
      agentSession: { findFirst: vi.fn().mockResolvedValue({ id: "session_1" }) },
    }
    const db = {
      agentObjectiveStartAttempt: { findUnique: ledgerFindUnique },
      $transaction: (work: (value: unknown) => Promise<unknown>) => work(tx),
    } as unknown as PrismaClient

    await expect(getObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({
      state: "accepted", receipt: { sessionId: "session_1", inputId: "input_1", turnId: "turn_1", sequence: "7" },
    })
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ["consumed after execution", { status: "consumed", consumedByStepId: "step_1", consumedAt: new Date("2026-11-12T10:00:00Z") }],
    ["cancelled after stop", { status: "cancelled", cancelledAt: new Date("2026-11-12T10:00:00Z") }],
    ["cancelled after a consumed input", { status: "cancelled", consumedByStepId: "step_1", consumedAt: new Date("2026-11-12T10:00:00Z"), cancelledAt: new Date("2026-11-12T10:01:00Z") }],
  ])("still verifies an immutable accepted receipt when input is %s", async (_label, lifecycle) => {
    const db = {
      agentObjectiveStartAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: (work: (value: unknown) => Promise<unknown>) => work({
        agentInput: { findMany: vi.fn().mockResolvedValue([legacyInput(lifecycle)]) },
        agentEvent: { findFirst: vi.fn().mockResolvedValue(legacyEvent()) },
        agentSession: { findFirst: vi.fn().mockResolvedValue({ id: "session_1" }) },
      }),
    } as unknown as PrismaClient

    await expect(getObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({
      state: "accepted", receipt: { sessionId: "session_1", inputId: "input_1", turnId: "turn_1", sequence: "7" },
    })
  })

  it.each([
    ["unknown status", { status: "future_status" }],
    ["consumed without its consumer", { status: "consumed", consumedAt: new Date("2026-11-12T10:00:00Z") }],
    ["cancelled without cancellation time", { status: "cancelled" }],
  ])("fails closed for %s even when an accepted event exists", async (_label, lifecycle) => {
    const db = {
      agentObjectiveStartAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: (work: (value: unknown) => Promise<unknown>) => work({
        agentInput: { findMany: vi.fn().mockResolvedValue([legacyInput(lifecycle)]) },
        agentEvent: { findFirst: vi.fn().mockResolvedValue(legacyEvent()) },
      }),
    } as unknown as PrismaClient

    await expect(getObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({ state: "unknown" })
  })

  it("keeps absent and ambiguous legacy evidence unknown", async () => {
    const db = {
      agentObjectiveStartAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: (work: (value: unknown) => Promise<unknown>) => work({
        agentInput: { findMany: vi.fn().mockResolvedValue([legacyInput(), legacyInput({ id: "input_2" })]) },
        agentEvent: { findFirst: vi.fn().mockResolvedValue(legacyEvent()) },
      }),
    } as unknown as PrismaClient
    await expect(getObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({ state: "unknown" })
  })

  it("rejects a Task-like legacy receipt with an extra untrusted intent field", async () => {
    const db = {
      agentObjectiveStartAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: (work: (value: unknown) => Promise<unknown>) => work({
        agentInput: { findMany: vi.fn().mockResolvedValue([legacyInput({}, { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, ownerId: "user_2" })]) },
        agentEvent: { findFirst: vi.fn().mockResolvedValue(legacyEvent()) },
      }),
    } as unknown as PrismaClient
    await expect(getObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({ state: "unknown" })
  })

  it("writes an irreversible tombstone for an absent attempt and replays it idempotently", async () => {
    let row: Record<string, unknown> | null = null
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => { row = data; return data })
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentObjectiveStartAttempt: {
        findUnique: vi.fn(async () => row), create,
      },
      agentInput: { findMany: vi.fn().mockResolvedValue([]) },
    }
    const db = { $transaction: (work: (value: unknown) => Promise<unknown>) => work(tx) } as unknown as PrismaClient

    await expect(abandonObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({ state: "abandoned" })
    await expect(abandonObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({ state: "abandoned" })
    expect(create).toHaveBeenCalledOnce()
    expect(row).toMatchObject({ userId: "user_1", clientMessageId: "attempt_1", status: "abandoned" })
  })

  it("returns unavailable for a deleted accepted target and preserves the idempotency fence", async () => {
    const row = {
      status: "accepted", sessionId: "session_1", requestHash: "hash", inputId: "input_1", turnId: "turn_1", acceptedSequence: BigInt(7),
    }
    const findUnique = vi.fn().mockResolvedValue(row)
    const create = vi.fn()
    const agentSessionFindFirst = vi.fn().mockResolvedValue(null)
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      agentObjectiveStartAttempt: { findUnique, create },
      agentSession: { findFirst: agentSessionFindFirst },
    }
    const db = {
      agentObjectiveStartAttempt: { findUnique },
      agentSession: { findFirst: agentSessionFindFirst },
      $transaction: (work: (value: unknown) => Promise<unknown>) => work(tx),
    } as unknown as PrismaClient

    await expect(getObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({ state: "unavailable" })
    await expect(abandonObjectiveStartAttempt(db, "user_1", "attempt_1")).resolves.toEqual({ state: "unavailable" })
    expect(create).not.toHaveBeenCalled()
    expect(agentSessionFindFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1", turns: { some: { id: "turn_1", userId: "user_1" } } },
      select: { id: true },
    })
  })
})
