import { describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, SELECTED_JOB_BATCH_PREPARATION_INTENT, VERIFIED_SHORTLIST_SELECTION_SCHEMA } from "@jobcopilot/agent-protocol"

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
    expect(agentTurn.create.mock.calls[0]?.[0]?.data).not.toHaveProperty("executionMode")
  })

  it("persists the objective task-graph intent with the root dispatch", async () => {
    const agentTurn = { create: vi.fn().mockResolvedValue({ id: "turn_objective" }) }
    const agentOutbox = { create: vi.fn().mockResolvedValue({}) }
    const tx = { agentTurn, agentOutbox } as unknown as CommandTransaction
    const command = { sessionId: "session_1", userId: "user_1", clientMessageId: "client_objective", source: "user" as const }

    await createRootTurn(
      tx, command, [{ type: "text", text: "Find and assess options" }], "Find and assess options", undefined,
      OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
    )

    expect(agentTurn.create.mock.calls[0]?.[0]?.data).toMatchObject({ executionMode: "canonical_task_graph" })
    expect(agentTurn.create.mock.calls[0]?.[0]?.data.input).toEqual(expect.objectContaining({
      goal: "Find and assess options", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
    }))
    expect(agentOutbox.create.mock.calls[0]?.[0]?.data).toEqual(expect.objectContaining({
      topic: "agent.turn.dispatch",
      aggregateId: command.sessionId,
      idempotencyKey: "turn-dispatch:turn_objective",
    }))
  })

  it("persists the gated Objective budget on the root Turn with its dispatch outbox", async () => {
    vi.stubEnv("ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES", "1")
    try {
      const agentTurn = { create: vi.fn().mockResolvedValue({ id: "turn_objective_budget" }) }
      const agentOutbox = { create: vi.fn().mockResolvedValue({}) }
      const command = { sessionId: "session_1", userId: "user_1", clientMessageId: "client_objective_budget", source: "user" as const }

      await createRootTurn({ agentTurn, agentOutbox } as unknown as CommandTransaction, command,
        [{ type: "text", text: "Complete the objective" }], undefined, undefined, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT)

      expect(agentTurn.create.mock.calls[0]?.[0]?.data.budgetSnapshot).toEqual({
        limits: { maxSteps: 96 }, objectiveTailorProfile: "agent-harness.v2.objective-tailor-execution-budget.v1",
      })
      expect(agentOutbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        topic: "agent.turn.dispatch", aggregateId: command.sessionId, idempotencyKey: "turn-dispatch:turn_objective_budget",
      }) }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("marks only the exact user batch intent and verified binding as canonical", async () => {
    const agentTurn = { create: vi.fn().mockResolvedValue({ id: "turn_batch" }) }
    const agentOutbox = { create: vi.fn().mockResolvedValue({}) }
    const tx = { agentTurn, agentOutbox } as unknown as CommandTransaction
    const command = { sessionId: "session_1", userId: "user_1", clientMessageId: "client_batch", source: "user" as const }
    const selection = { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source: {
      sessionId: command.sessionId, sourceTurnId: "source_turn", rootTaskId: "root_1", graphItemId: "task-graph-root_1", graphRevision: 3,
    }, selectedJobIds: ["job_1", "job_2"] }

    await createRootTurn(tx, command, [{ type: "text", text: "Prepare selected jobs" }], "Prepare selected jobs", undefined,
      SELECTED_JOB_BATCH_PREPARATION_INTENT, undefined, selection)

    const data = agentTurn.create.mock.calls[0]?.[0]?.data
    expect(data).toMatchObject({ executionMode: "canonical_task_graph" })
    expect(data.input).toEqual(expect.objectContaining({ intent: SELECTED_JOB_BATCH_PREPARATION_INTENT, verifiedShortlistSelection: selection }))
    expect(data.input).not.toHaveProperty("selectedJobPreparation")
    expect(agentOutbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      topic: "agent.turn.dispatch", aggregateId: command.sessionId, idempotencyKey: "turn-dispatch:turn_batch",
    }) }))
  })

  it("rejects a batch intent without the exact user binding before Turn or outbox writes", async () => {
    const agentTurn = { create: vi.fn() }, agentOutbox = { create: vi.fn() }
    const command = { sessionId: "session_1", userId: "user_1", clientMessageId: "client_batch_invalid", source: "automation" as const }
    const selection = { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source: {
      sessionId: "session_1", sourceTurnId: "source_turn", rootTaskId: "root_1", graphItemId: "task-graph-root_1", graphRevision: 3,
    }, selectedJobIds: ["job_1", "job_2"] }

    await expect(createRootTurn({ agentTurn, agentOutbox } as unknown as CommandTransaction, command,
      [{ type: "text", text: "Prepare selected jobs" }], undefined, undefined, SELECTED_JOB_BATCH_PREPARATION_INTENT))
      .rejects.toThrow("selected_job_batch_turn_binding_invalid")
    await expect(createRootTurn({ agentTurn, agentOutbox } as unknown as CommandTransaction,
      { ...command, source: "user" }, [{ type: "text", text: "Prepare selected jobs" }], undefined, undefined,
      SELECTED_JOB_BATCH_PREPARATION_INTENT, null, selection)).rejects.toThrow("selected_job_batch_turn_binding_invalid")
    expect(agentTurn.create).not.toHaveBeenCalled()
    expect(agentOutbox.create).not.toHaveBeenCalled()
  })

  it("does not pin canonical mode for a non-user Turn with the objective intent", async () => {
    const agentTurn = { create: vi.fn().mockResolvedValue({ id: "turn_automation_objective" }) }
    const agentOutbox = { create: vi.fn().mockResolvedValue({}) }
    const tx = { agentTurn, agentOutbox } as unknown as CommandTransaction
    const command = { sessionId: "session_1", userId: "user_1", clientMessageId: "client_automation", source: "automation" as const }

    await createRootTurn(tx, command, [{ type: "text", text: "Automate an objective" }], undefined, undefined,
      OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT)

    expect(agentTurn.create.mock.calls[0]?.[0]?.data).not.toHaveProperty("executionMode")
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
