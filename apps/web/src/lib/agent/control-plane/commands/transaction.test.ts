import { describe, expect, it, vi } from "vitest"

import { acceptInputFacts, assertExpectedTurn, commandEventKey, createRootTurn, fallbackDisposition, lockOpenSession, type CommandTransaction } from "./transaction"
import { activeTurnChanged } from "./errors"

describe("Agent command transaction helpers", () => {
  it("uses stable command event keys and original delivery for fallback idempotency", () => {
    expect(commandEventKey("client-1")).toBe("agent-command:client-1")
    expect(fallbackDisposition({ id: "input", targetTurnId: "turn", delivery: "follow_up", acceptedSequence: BigInt(1) }, "follow_up")).toBe("queued_follow_up")
  })

  it("writes root accepted input identity from the server-generated UUID", async () => {
    const eventCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...args.data, sequence: BigInt(12) }))
    const itemCreate = vi.fn(async (args: { data: Record<string, unknown> }) => args.data)
    const inputCreate = vi.fn(async (args: { data: Record<string, unknown> }) => args.data)
    const outboxCreate = vi.fn(async (args: { data: Record<string, unknown> }) => args.data)
    const tx = {
      $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(12) }]),
      agentItem: { create: itemCreate },
      agentInput: { create: inputCreate },
      agentEvent: { findFirst: vi.fn(async () => null), create: eventCreate },
      agentOutbox: { create: outboxCreate },
    } as unknown as CommandTransaction
    const clientMessageId = "request-415-555-0100"
    const turn = { id: "23456789-2345-4bcd-9bcd-234567890123", source: "user", status: "in_progress", revision: 1 }

    const result = await acceptInputFacts(tx,
      { sessionId: "34567890-3456-4cde-acde-345678901234", userId: "user_1", clientMessageId, source: "user" },
      [{ type: "text", text: "Find engineering jobs" }], turn, "steer", "steered", false)

    const item = itemCreate.mock.calls[0]?.[0]?.data
    const event = eventCreate.mock.calls[0]?.[0]?.data
    const storedInput = inputCreate.mock.calls[0]?.[0]?.data
    expect(result.inputId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(storedInput?.id).toBe(result.inputId)
    expect(event?.type).toBe("input.accepted")
    expect(event?.itemId).toBe(item?.id)
    expect(event?.payload).toEqual({ inputId: result.inputId, clientMessageId: "request-[REDACTED_PHONE]", delivery: "steer", source: "user", disposition: "steered" })
    expect((item?.content as { clientMessageId?: string }).clientMessageId).toBe(clientMessageId)
    expect((storedInput?.content as Array<{ text: string }>)[0]?.text).toBe("Find engineering jobs")
    expect((outboxCreate.mock.calls[0]?.[0]?.data.payload as { payload?: unknown }).payload).toEqual(event?.payload)
  })

  it("guards expected turn and revision together", async () => {
    await expect(assertExpectedTurn("stale", 2, { id: "current", source: "user", status: "in_progress", revision: 3 }))
      .rejects.toMatchObject(activeTurnChanged("stale", "current"))
  })

  it("locks an open session by user before command writes", async () => {
    const queryRaw = vi.fn(async (_query: unknown) => [{ id: "session_1" }])
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
      { jobId: "job_1" },
    )

    const turnData = agentTurn.create.mock.calls[0]?.[0]?.data
    expect(turnData.input).toEqual(expect.objectContaining({ goal: "Canonical goal", selectedJobPreparation: { jobId: "job_1" } }))
    expect(turnData.input).not.toHaveProperty("intent")
    const outboxData = agentOutbox.create.mock.calls[0]?.[0]?.data
    expect(outboxData).toEqual(expect.objectContaining({
      aggregateId: command.sessionId,
      idempotencyKey: "turn-dispatch:turn_1",
    }))
    expect(outboxData.aggregateId).not.toBe("turn_1")
  })

  it("persists a server-owned intent only when the caller explicitly supplies one", async () => {
    const agentTurn = { create: vi.fn().mockResolvedValue({ id: "turn_intent" }) }
    const agentOutbox = { create: vi.fn().mockResolvedValue({}) }
    const tx = { agentTurn, agentOutbox } as unknown as CommandTransaction
    const command = { sessionId: "session_1", userId: "user_1", clientMessageId: "client_intent", source: "user" as const }
    const intent = { kind: "interactive_discovery_shortlist", version: 1 } as const

    await createRootTurn(tx, command, [{ type: "text", text: "Discover roles" }], "Discovery goal", undefined, intent)

    const input = agentTurn.create.mock.calls[0]?.[0]?.data.input
    expect(input).toEqual(expect.objectContaining({ goal: "Discovery goal", intent }))
  })

  it("persists valid, invalid-sentinel, and absent objective requirements distinctly", async () => {
    const agentTurn = { create: vi.fn().mockResolvedValue({ id: "turn_requirements" }) }
    const agentOutbox = { create: vi.fn().mockResolvedValue({}) }
    const tx = { agentTurn, agentOutbox } as unknown as CommandTransaction
    const command = { sessionId: "session_1", userId: "user_1", clientMessageId: "client_requirements", source: "user" as const }
    const requirements = {
      schemaVersion: "agent-harness.v2.objective-requirements.v1",
      requirements: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } }],
    } as const

    await createRootTurn(tx, command, [{ type: "text", text: "Find roles" }], "Find roles", undefined, undefined, requirements)
    const validInput = agentTurn.create.mock.calls[0]?.[0]?.data.input
    expect(validInput).toHaveProperty("verificationRequirements", requirements)
    const roundTrippedRequirements: unknown = JSON.parse(JSON.stringify(validInput.verificationRequirements))
    expect(roundTrippedRequirements).toEqual(requirements)

    await createRootTurn(tx, command, [{ type: "text", text: "Find roles" }], "Find roles", undefined, undefined, null)
    const invalidInput = agentTurn.create.mock.calls[1]?.[0]?.data.input
    expect(invalidInput).toHaveProperty("verificationRequirements", null)

    await createRootTurn(tx, command, [{ type: "text", text: "Find roles" }], "Find roles")
    const absentInput = agentTurn.create.mock.calls[2]?.[0]?.data.input
    expect(absentInput).not.toHaveProperty("verificationRequirements")
  })
})
