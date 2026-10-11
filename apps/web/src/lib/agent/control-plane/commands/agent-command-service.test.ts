import { describe, expect, it, vi } from "vitest"

import type { PrismaClient } from "@prisma/client"

import { AgentCommandService } from "./agent-command-service"
import { ObjectiveStartCommandService } from "./objective-start"

type Row = Record<string, unknown>

function whereOf(args: unknown): Row {
  return ((args as { where?: Row }).where ?? {})
}

function makeDb(options: {
  ownerId?: string
  sessionExists?: boolean
  sessionStatus?: string
  sessionOwnerId?: string
  failOutbox?: boolean
  failDispatchOutbox?: boolean
  executionStatus?: string
  sessionSource?: string
  activeSource?: string
  activeTurnId?: string
  activeInput?: unknown
  activeRootTaskId?: string | null
  activeStatus?: string
  steeringRootTaskId?: string | null
  steeringInputRows?: Row[]
  initialInputs?: Row[]
  retryTarget?: Row & { revision: number }
} = {}) {
  const ownerId = options.ownerId ?? "user_1"
  const sessionExists = options.sessionExists ?? true
  const sessionOwnerId = options.sessionOwnerId ?? ownerId
  let active: (Row & { revision: number }) | null = options.activeSource
    ? { id: options.activeTurnId ?? "turn_1", source: options.activeSource, status: options.activeStatus ?? "in_progress", revision: 0, input: options.activeInput, rootTaskId: options.activeRootTaskId ?? null }
    : null
  let turns: (Row & { revision: number })[] = active ? [active] : []
  let execution: { id: string; sessionId: string; status: string } | null = options.executionStatus
    ? { id: "execution_1", sessionId: "session_1", status: options.executionStatus }
    : null
  let sessionStatus = options.sessionStatus ?? "active"
  const rawQueries: unknown[] = []
  let rollbacks = 0
  let sequence = BigInt(0)
  let inputs: Row[] = [...(options.initialInputs ?? [])]
  let items: Row[] = []
  let events: Row[] = []
  let outbox: Row[] = []
  let transactionQueue = Promise.resolve()

  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      rawQueries.push(query)
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      const sql = strings.join(" ")
      if (sql.includes('FROM "agent_sessions"')) {
        const openFence = sql.includes('"status" NOT IN')
        const available = sessionExists && sessionOwnerId === ownerId && (!openFence || !["aborted", "archived"].includes(sessionStatus))
        return available ? [{ id: "session_1", status: sessionStatus }] : []
      }
      if (sql.includes('SELECT "input", "rootTaskId" FROM "agent_turns"')) {
        return [{ input: options.activeInput ?? {}, rootTaskId: options.steeringRootTaskId ?? null }]
      }
      if (sql.includes('FROM "agent_inputs" AS input')) return options.steeringInputRows ?? []
      if (sql.includes("event.\"type\" = 'agent.plan.reconciliation'")) return []
      if (sql.includes("SELECT")) {
        return [{ id: "session_1" }]
      }
      sequence += BigInt(1)
      return [{ eventSequence: sequence }]
    }),
    $executeRaw: vi.fn(async () => 0),
    agentSession: {
      findFirst: vi.fn(async () => (options.sessionSource ? { source: options.sessionSource } : null)),
      updateMany: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        if (!options.sessionSource || where.id !== "session_1" || where.userId !== ownerId) return { count: 0 }
        sessionStatus = "aborted"
        return { count: 1 }
      }),
    },
    agentExecution: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        if (!execution || where.id !== execution.id || where.userId !== ownerId || (where.sessionId && where.sessionId !== execution.sessionId)) return null
        return { ...execution }
      }),
      updateMany: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        const statuses = (where.status as { in?: unknown[] } | undefined)?.in ?? []
        if (!execution || where.id !== execution.id || where.userId !== ownerId || where.sessionId !== execution.sessionId || !statuses.includes(execution.status)) return { count: 0 }
        execution = { ...execution, status: "cancelled" }
        return { count: 1 }
      }),
    },
    agentTurn: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        if (where.id) {
          const target = options.retryTarget
          return target && where.id === target.id && where.sessionId === "session_1" && where.userId === ownerId ? { ...target } : null
        }
        if (!active) return null
        if (where.status === "in_progress" && active.status !== "in_progress") return null
        const statuses = (where.status as { in?: unknown[] } | undefined)?.in
        if (statuses && !statuses.includes(active.status)) return null
        return active
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Row }).data
        active = { id: String(data.id), source: data.source, status: "queued", revision: 0, input: data.input }
        turns.push(active)
        return { id: active.id }
      }),
      updateMany: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        if (!active || where.id !== active.id || where.revision !== active.revision) return { count: 0 }
        const interrupted: Row & { revision: number } = { ...active, status: "interrupted", revision: active.revision + 1 }
        active = interrupted
        turns = turns.map((turn) => turn.id === interrupted.id ? interrupted : turn)
        return { count: 1 }
      }),
    },
    agentInput: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        return inputs.find((input) => input.sessionId === where.sessionId && input.clientMessageId === where.clientMessageId) ?? null
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Row }).data
        inputs.push(data)
        return data
      }),
      updateMany: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        const statuses = (where.status as { in?: unknown[] } | undefined)?.in ?? []
        const data = (args as { data: Row }).data
        let count = 0
        for (const input of inputs) {
          if (input.userId !== where.userId || input.sessionId !== where.sessionId || input.targetTurnId !== where.targetTurnId
            || input.delivery !== where.delivery || !statuses.includes(input.status)) continue
          Object.assign(input, data)
          count += 1
        }
        return { count }
      }),
    },
    agentItem: {
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Row }).data
        items.push(data)
        return data
      }),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentApproval: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentRunQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    agentEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        return events.find((event) => event.sessionId === where.sessionId && event.idempotencyKey === where.idempotencyKey) ?? null
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Row }).data
        const event = { ...data, createdAt: new Date() }
        events.push(event)
        return event
      }),
    },
    agentOutbox: {
      create: vi.fn(async (args: unknown) => {
        if (options.failOutbox || options.failDispatchOutbox) throw new Error("outbox unavailable")
        const data = (args as { data: Row }).data
        outbox.push(data)
        return data
      }),
      createMany: vi.fn(async (args: unknown) => {
        if (options.failOutbox) throw new Error("outbox unavailable")
        const data = (args as { data: Row[] }).data
        const inserted = data.filter((entry) => !outbox.some((existing) => existing.idempotencyKey === entry.idempotencyKey))
        outbox.push(...inserted)
        return { count: inserted.length }
      }),
    },
  }

  const transaction = vi.fn(<T>(work: (transaction: typeof tx) => Promise<T>) => {
    const run = transactionQueue.then(async () => {
      const before = {
        active,
        turns: turns.map((turn) => ({ ...turn })),
        execution,
        sessionStatus,
        sequence,
        inputs: inputs.map((input) => ({ ...input })),
        items: [...items],
        events: [...events],
        outbox: [...outbox],
      }
      try {
        return await work(tx)
      } catch (error: unknown) {
        rollbacks += 1
        active = before.active
        turns = before.turns
        execution = before.execution
        sessionStatus = before.sessionStatus
        sequence = before.sequence
        inputs = before.inputs
        items = before.items
        events = before.events
        outbox = before.outbox
        throw error
      }
    })
    transactionQueue = run.then(() => undefined, () => undefined)
    return run
  })

  const db = { $transaction: transaction } as unknown as PrismaClient
  return {
    db,
    tx,
    state: {
      rawQueries,
      get transactionCount() { return transaction.mock.calls.length },
      get rollbacks() { return rollbacks },
      get active() { return active },
      setActive(value: (Row & { revision: number }) | null) {
        active = value
        if (value) {
          const index = turns.findIndex((turn) => turn.id === value.id)
          if (index < 0) turns.push(value)
          else turns[index] = value
        }
      },
      get turns() { return turns },
      get execution() { return execution },
      get sessionStatus() { return sessionStatus },
      setSessionStatus(value: string) { sessionStatus = value },
      get inputs() { return inputs },
      get items() { return items },
      get events() { return events },
      get outbox() { return outbox },
    },
  }
}

const content = [{ type: "text", text: "Find backend roles" }] as const

function startCommand(clientMessageId: string, source: "user" | "automation" = "user") {
  return { sessionId: "session_1", userId: "user_1", clientMessageId, source, content: [...content] }
}

function acceptedSteeringRows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `steer-${index}`, clientMessageId = `client-${index}`, acceptedSequence = BigInt(index + 1)
    return {
      id, clientMessageId, delivery: "steer", status: index % 2 ? "queued" : "accepted", acceptedSequence,
      consumedByStepId: null, consumedAt: null, cancelledAt: null, acceptedType: "input.accepted", acceptedActor: "user",
      acceptedTaskId: null, acceptedCorrelationId: "turn_1", acceptedItemId: `${id}-item`, acceptedEventSequence: acceptedSequence,
      acceptedPayload: { inputId: id, clientMessageId, delivery: "steer", source: "user", disposition: "steered" },
      acceptedItemType: "user_message", acceptedItemTaskId: null, acceptedItemStatus: "completed",
      acceptedItemContent: { parts: [{ type: "text", text: "private" }], clientMessageId, source: "user", disposition: "steered" },
    }
  })
}

function retryTarget(status = "failed", input: unknown = { goal: "Find backend roles", content: [...content] }) {
  return { id: "turn_failed", sessionId: "session_1", userId: "user_1", status, source: "user", revision: 4, input }
}

function retryCommand(clientMessageId: string, expectedRevision: number | null = 4) {
  return { sessionId: "session_1", userId: "user_1", clientMessageId, source: "user" as const, targetTurnId: "turn_failed", expectedRevision }
}

function replacementCommand(clientMessageId: string, expectedTurnId: string, expectedRevision = 0, source: "user" | "automation" = "user") {
  return {
    ...startCommand(clientMessageId, source),
    content: [{ type: "text" as const, text: "Find senior backend roles in Dublin" }],
    expectedTurnId,
    expectedRevision,
  }
}

function objectiveStartCommand(clientMessageId: string, source: "user" | "automation" = "user") {
  return {
    sessionId: "session_1", userId: "user_1", clientMessageId, source,
    objective: "  Find senior backend roles in Dublin  ",
    content: [{ type: "text" as const, text: "\nReference: preserve this context exactly.\n" }],
  }
}

describe("AgentCommandService", () => {
  it("starts a fresh root with a separate exact objective and preserved context", async () => {
    const fake = makeDb({ sessionStatus: "running" })
    const longContext = "x".repeat(20_000)
    const result = await new ObjectiveStartCommandService(fake.db).start({
      ...objectiveStartCommand("objective_start_1"), content: [{ type: "text", text: longContext }],
    })

    expect(result).toMatchObject({ disposition: "started", turnId: fake.state.active?.id })
    expect(fake.state.active?.input).toMatchObject({
      goal: "Find senior backend roles in Dublin",
      content: [{ type: "text", text: longContext }],
    })
    expect(fake.state.inputs[0]).toMatchObject({
      targetTurnId: result.turnId,
      delivery: "follow_up",
      content: [{ type: "text", text: longContext }],
    })
    expect(fake.state.events.map((event) => event.type)).toEqual(["turn.started", "input.accepted"])
    expect(fake.state.outbox.filter((entry) => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(fake.state.turns).toHaveLength(1)
  })

  it("replays the original fresh root before checking later Session state or active Turns", async () => {
    const fake = makeDb({ sessionStatus: "running" })
    const service = new ObjectiveStartCommandService(fake.db)
    const first = await service.start(objectiveStartCommand("objective_start_replay"))
    fake.state.setSessionStatus("archived")
    const readsBeforeReplay = fake.tx.agentTurn.findFirst.mock.calls.length
    const replay = await service.start(objectiveStartCommand("objective_start_replay"))

    expect(replay).toMatchObject({
      disposition: "duplicate", originalDisposition: "started", inputId: first.inputId, turnId: first.turnId,
    })
    expect(fake.tx.agentTurn.findFirst).toHaveBeenCalledTimes(readsBeforeReplay)
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.outbox.filter((entry) => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
  })

  it("rejects paused, closed, and active fresh admissions without writes", async () => {
    for (const status of ["paused", "completed", "aborted", "archived"]) {
      const fake = makeDb({ sessionStatus: status })
      await expect(new ObjectiveStartCommandService(fake.db).start(objectiveStartCommand(`status_${status}`)))
        .rejects.toMatchObject({ code: "objective_start_state_conflict", status: 409 })
      expect(fake.state.turns).toHaveLength(0)
      expect(fake.state.inputs).toHaveLength(0)
      expect(fake.state.outbox).toHaveLength(0)
    }

    const active = makeDb({ sessionStatus: "running", activeSource: "user" })
    await expect(new ObjectiveStartCommandService(active.db).start(objectiveStartCommand("active_root")))
      .rejects.toMatchObject({ code: "retry_active_conflict", status: 409 })
    expect(active.state.turns).toHaveLength(1)
    expect(active.state.inputs).toHaveLength(0)
    expect(active.state.outbox).toHaveLength(0)

    const foreign = makeDb({ sessionStatus: "running", sessionOwnerId: "user_2" })
    await expect(new ObjectiveStartCommandService(foreign.db).start(objectiveStartCommand("foreign_session")))
      .rejects.toMatchObject({ code: "agent_session_not_found", status: 404 })
    expect(foreign.state.turns).toHaveLength(0)
    expect(foreign.state.inputs).toHaveLength(0)
    expect(foreign.state.outbox).toHaveLength(0)
  })

  it("serializes concurrent same-key objective starts and rolls failed dispatch back", async () => {
    const concurrent = makeDb({ sessionStatus: "running" })
    const service = new ObjectiveStartCommandService(concurrent.db)
    const command = objectiveStartCommand("objective_start_race")
    const [first, second] = await Promise.all([service.start(command), service.start(command)])
    expect(new Set([first.turnId, second.turnId])).toHaveLength(1)
    expect([first.disposition, second.disposition].sort()).toEqual(["duplicate", "started"])
    expect(concurrent.state.inputs).toHaveLength(1)
    expect(concurrent.state.outbox.filter((entry) => entry.topic === "agent.turn.dispatch")).toHaveLength(1)

    const failing = makeDb({ sessionStatus: "running", failDispatchOutbox: true })
    await expect(new ObjectiveStartCommandService(failing.db).start(objectiveStartCommand("objective_start_rollback")))
      .rejects.toThrow("outbox unavailable")
    expect(failing.state.rollbacks).toBe(1)
    expect(failing.state.turns).toHaveLength(0)
    expect(failing.state.inputs).toHaveLength(0)
    expect(failing.state.events).toHaveLength(0)
    expect(failing.state.outbox).toHaveLength(0)
  })

  it("serializes concurrent starts to one active root Turn", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)

    const results = await Promise.all([
      service.start(startCommand("client_1")),
      service.start(startCommand("client_2")),
    ])

    expect(new Set(results.map((result) => result.turnId))).toHaveLength(1)
    expect(fake.state.active).not.toBeNull()
    expect(fake.state.items).toHaveLength(2)
    expect(fake.state.inputs).toHaveLength(2)
  })

  it("returns duplicate with the original disposition and no new facts", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const command = startCommand("client_duplicate")

    const first = await service.start(command)
    const second = await service.start(command)

    expect(first.disposition).toBe("started")
    expect(second).toMatchObject({ disposition: "duplicate", originalDisposition: "started", turnId: first.turnId, inputId: first.inputId })
    expect(fake.state.items).toHaveLength(1)
    expect(fake.state.inputs).toHaveLength(1)
  })

  it("collapses concurrent duplicate commands to one Turn and dispatch identity", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const command = startCommand("client_concurrent_duplicate")

    const [first, second] = await Promise.all([service.start(command), service.start(command)])

    expect(second.disposition).toBe("duplicate")
    expect(second.turnId).toBe(first.turnId)
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.items).toHaveLength(1)
    expect(fake.state.outbox.filter((entry) => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
  })

  it("writes one canonical Turn dispatch intent with the root in the command transaction", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)

    const first = await service.start(startCommand("client_dispatch"))
    await service.start(startCommand("client_dispatch"))

    const dispatches = fake.state.outbox.filter((outbox) => outbox.topic === "agent.turn.dispatch")
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]).toMatchObject({
      idempotencyKey: `turn-dispatch:${first.turnId}`,
      payload: { turnId: first.turnId, sessionId: "session_1", ownerId: `web:${first.turnId}` },
    })
    expect(dispatches[0]?.aggregateId).toBe("session_1")
    expect(dispatches[0]?.aggregateId).not.toBe(first.turnId)
  })

  it("persists the trusted discovery intent in the root Turn before its dispatch is committed", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)

    const result = await service.start({
      ...startCommand("client_task_graph_discovery"),
      intent: { kind: "interactive_discovery_shortlist", version: 1 },
    })

    expect(fake.state.active?.input).toMatchObject({
      goal: "Find backend roles",
      intent: { kind: "interactive_discovery_shortlist", version: 1 },
    })
    expect(fake.state.outbox).toContainEqual(expect.objectContaining({
      topic: "agent.turn.dispatch",
      idempotencyKey: `turn-dispatch:${result.turnId}`,
    }))
  })

  it("only continues an active Turn when its persisted intent matches the trusted command intent", async () => {
    const mismatched = makeDb({ activeSource: "user", activeInput: { goal: "ordinary chat" } })
    await expect(new AgentCommandService(mismatched.db).start({
      ...startCommand("client_mismatched_intent"),
      intent: { kind: "interactive_discovery_shortlist", version: 1 },
    })).rejects.toMatchObject({ code: "turn_intent_mismatch", status: 409 })
    expect(mismatched.state.inputs).toHaveLength(0)

    const matching = makeDb({
      activeSource: "user",
      activeInput: { intent: { kind: "interactive_discovery_shortlist", version: 1 } },
    })
    await expect(new AgentCommandService(matching.db).start({
      ...startCommand("client_matching_intent"),
      intent: { kind: "interactive_discovery_shortlist", version: 1 },
    })).resolves.toMatchObject({ disposition: "queued_follow_up", turnId: "turn_1" })
  })

  it("rejects stale expected Turn before writing a steer", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const started = await service.start(startCommand("client_start"))

    await expect(service.steer({
      ...startCommand("client_steer"),
      expectedTurnId: "stale_turn",
      content: [...content],
    })).rejects.toMatchObject({ code: "active_turn_changed", status: 409 })
    expect(fake.state.items).toHaveLength(1)
    expect(started.turnId).not.toBe("stale_turn")
  })

  it.each(["queued", "in_progress", "waiting_for_dependency"] as const)("queues a follow-up on a %s Turn", async (status) => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const started = await service.start(startCommand("client_start"))
    fake.state.setActive({ ...fake.state.active!, status })

    const result = await service.message({
      ...startCommand("client_follow_up"),
      delivery: "follow_up",
      expectedTurnId: null,
      expectedRevision: null,
    })

    expect(result).toMatchObject({ disposition: "queued_follow_up", turnId: started.turnId })
  })

  it("starts selected-job preparation as a new root Turn and keeps scope out of user content", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const result = await service.message({
      ...startCommand("client_prepare_job"),
      content: [{ type: "text", text: "Prepare a cover letter draft for the selected job." }],
      delivery: "follow_up",
      selectedJobPreparation: { jobId: "job_1" },
    })

    expect(result.disposition).toBe("started")
    expect(fake.state.active?.input).toMatchObject({ selectedJobPreparation: { jobId: "job_1" } })
    expect(JSON.stringify(fake.state.items[0]?.content)).not.toContain("job_1")
  })

  it("rejects selected-job preparation when a root Turn is active", async () => {
    const fake = makeDb({ activeSource: "user", activeStatus: "in_progress" })
    const service = new AgentCommandService(fake.db)

    await expect(service.message({
      ...startCommand("client_prepare_busy"),
      delivery: "follow_up",
      selectedJobPreparation: { jobId: "job_1" },
    })).rejects.toMatchObject({ code: "selected_job_turn_active", status: 409 })
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.items).toHaveLength(0)
  })

  it("starts a successor Turn when terminal completion won before follow-up acceptance", async () => {
    const fake = makeDb({ activeSource: "user", activeTurnId: "turn_completed", activeStatus: "completed" })
    const service = new AgentCommandService(fake.db)

    const result = await service.message({
      ...startCommand("client_after_completion"),
      delivery: "follow_up",
      expectedTurnId: null,
      expectedRevision: null,
    })

    expect(result.disposition).toBe("started")
    expect(result.turnId).not.toBe("turn_completed")
    expect(fake.state.active).toMatchObject({ id: result.turnId, status: "queued" })
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.inputs[0]).toMatchObject({ targetTurnId: result.turnId, userId: "user_1", sessionId: "session_1", delivery: "follow_up" })
    const dispatches = fake.state.outbox.filter(entry => entry.topic === "agent.turn.dispatch")
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]).toMatchObject({ aggregateId: "session_1", idempotencyKey: `turn-dispatch:${result.turnId}` })
  })

  it.each([
    ["waiting_for_user", "steer"],
    ["waiting_for_user", "follow_up"],
    ["waiting_for_approval", "steer"],
    ["waiting_for_approval", "follow_up"],
  ] as const)("rejects a %s Turn %s command before writing durable facts", async (status, delivery) => {
    const fake = makeDb({ activeSource: "user", activeStatus: status })
    const service = new AgentCommandService(fake.db)

    await expect(service.message({
      ...startCommand(`client_${status}_${delivery}`),
      delivery,
      expectedTurnId: "turn_1",
    })).rejects.toMatchObject({
      code: "turn_wait_requires_dedicated_action",
      status: 409,
      details: { turnId: "turn_1", status },
    })

    expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
    expect(fake.tx.agentInput.create).not.toHaveBeenCalled()
    expect(fake.tx.agentItem.create).not.toHaveBeenCalled()
    expect(fake.tx.agentEvent.create).not.toHaveBeenCalled()
    expect(fake.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.items).toHaveLength(0)
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("replays a duplicate message before applying the parked Turn guard", async () => {
    const fake = makeDb({ activeSource: "user", activeStatus: "in_progress" })
    const service = new AgentCommandService(fake.db)
    const command = { ...startCommand("client_waiting_duplicate"), delivery: "follow_up" as const }
    const accepted = await service.message(command)
    fake.state.setActive({ ...fake.state.active!, status: "waiting_for_user" })

    const duplicate = await service.message(command)

    expect(duplicate).toMatchObject({
      disposition: "duplicate",
      inputId: accepted.inputId,
      turnId: accepted.turnId,
    })
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.items).toHaveLength(1)
    expect(fake.state.events).toHaveLength(1)
  })

  it("does not let automation steer a user Turn", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const started = await service.start(startCommand("client_start"))

    await expect(service.steer({
      ...startCommand("client_automation", "automation"),
      expectedTurnId: started.turnId,
      content: [...content],
    })).rejects.toMatchObject({ code: "automation_cannot_steer_user_turn", status: 409 })
    expect(fake.state.inputs).toHaveLength(1)
  })

  it("checks the accepted-steer cap after the Session lock and before every acceptance write", async () => {
    const fake = makeDb({ activeSource: "user", steeringInputRows: acceptedSteeringRows(128) })
    const service = new AgentCommandService(fake.db)

    await expect(service.steer({ ...startCommand("client_at_capacity"), expectedTurnId: "turn_1", expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "invalid_command", status: 409, details: { capacity: 128, unresolvedCount: 128 } })

    expect(fake.state.transactionCount).toBe(1)
    expect(fake.state.rawQueries).toHaveLength(4)
    const firstQuery = (fake.state.rawQueries[0] as { strings?: readonly string[] }).strings?.join(" ") ?? ""
    expect(firstQuery).toContain("FOR UPDATE")
    expect(fake.state.rawQueries.slice(1).every(query => !((query as { strings?: readonly string[] }).strings?.join(" ") ?? "").includes("FOR UPDATE"))).toBe(true)
    expect(fake.tx.agentInput.create).not.toHaveBeenCalled()
    expect(fake.tx.agentItem.create).not.toHaveBeenCalled()
    expect(fake.tx.agentEvent.create).not.toHaveBeenCalled()
    expect(fake.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.items).toHaveLength(0)
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("returns an accepted duplicate at capacity before running the capacity reader", async () => {
    const duplicateInput = { id: "already-accepted", sessionId: "session_1", targetTurnId: "turn_1", clientMessageId: "client_duplicate_at_capacity",
      delivery: "steer", acceptedSequence: BigInt(7) }
    const fake = makeDb({ activeSource: "user", steeringInputRows: acceptedSteeringRows(128), initialInputs: [duplicateInput] })
    const result = await new AgentCommandService(fake.db).steer({ ...startCommand(duplicateInput.clientMessageId), expectedTurnId: "turn_1" })

    expect(result).toMatchObject({ disposition: "duplicate", inputId: duplicateInput.id, turnId: "turn_1" })
    expect(fake.state.rawQueries).toHaveLength(1)
    expect(fake.state.rawQueries[0]).toBeDefined()
    expect(fake.tx.agentInput.create).not.toHaveBeenCalled()
    expect(fake.tx.agentItem.create).not.toHaveBeenCalled()
  })

  it("rolls back Turn, Item, Event, Input and Outbox on transaction failure", async () => {
    const fake = makeDb({ failOutbox: true })
    const service = new AgentCommandService(fake.db)

    await expect(service.start(startCommand("client_rollback"))).rejects.toThrow("outbox unavailable")
    expect(fake.state.active).toBeNull()
    expect(fake.state.items).toHaveLength(0)
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("interrupts the expected active Turn atomically", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const started = await service.start(startCommand("client_start"))
    const followUp = await service.message({ ...startCommand("client_follow_up"), delivery: "follow_up" })
    const command = { ...startCommand("client_interrupt"), expectedTurnId: started.turnId }

    const result = await service.interrupt(command)
    const duplicate = await service.interrupt(command)

    expect(result).toMatchObject({ disposition: "interrupted", turnId: started.turnId })
    expect(duplicate).toMatchObject({ disposition: "duplicate", originalDisposition: "interrupted", turnId: started.turnId })
    expect(fake.state.active).toMatchObject({ status: "interrupted", revision: 1 })
    expect(fake.state.inputs.find((input) => input.id === followUp.inputId)).toMatchObject({ status: "cancelled", cancelledAt: expect.any(Date) })
    const stopIntents = fake.state.outbox.filter((entry) => entry.topic === "agent.task-graph.stop")
    expect(stopIntents).toHaveLength(1)
    expect(stopIntents[0]).toEqual({
      id: `task-graph-stop-${started.turnId}`,
      topic: "agent.task-graph.stop",
      aggregateId: "session_1",
      idempotencyKey: `agent-task-graph-stop:session_1:${started.turnId}`,
      payload: { sessionId: "session_1", turnId: started.turnId },
    })
    expect(fake.tx.agentOutbox.createMany).toHaveBeenCalledTimes(1)
    expect(fake.tx.agentOutbox.createMany).toHaveBeenCalledWith({
      data: [{
        id: `task-graph-stop-${started.turnId}`,
        topic: "agent.task-graph.stop",
        aggregateId: "session_1",
        idempotencyKey: `agent-task-graph-stop:session_1:${started.turnId}`,
        payload: { sessionId: "session_1", turnId: started.turnId },
      }],
      skipDuplicates: true,
    })
  })

  it("replaces an objective atomically while retaining the old Turn input and dispatching a fresh goal", async () => {
    const fake = makeDb({ sessionStatus: "running" })
    const service = new AgentCommandService(fake.db)
    const started = await service.start(startCommand("client_original"))
    const queuedFollowUp = await service.message({
      ...startCommand("client_queued_before_replace"),
      delivery: "follow_up",
      expectedTurnId: started.turnId,
      expectedRevision: 0,
    })
    const originalTurn = fake.state.turns.find((turn) => turn.id === started.turnId)
    const originalInput = structuredClone(originalTurn?.input)
    const transactionsBefore = fake.state.transactionCount

    const result = await service.replaceObjective(replacementCommand("client_replace", started.turnId))

    const oldTurn = fake.state.turns.find((turn) => turn.id === started.turnId)
    const successor = fake.state.turns.find((turn) => turn.id === result.turnId)
    expect(result).toMatchObject({ disposition: "started", turnId: successor?.id })
    expect(result.turnId).not.toBe(started.turnId)
    expect(oldTurn).toMatchObject({ status: "interrupted", revision: 1 })
    expect(oldTurn?.input).toEqual(originalInput)
    expect(successor).toMatchObject({
      source: "user",
      status: "queued",
      input: {
        goal: "Find senior backend roles in Dublin",
        content: [{ type: "text", text: "Find senior backend roles in Dublin" }],
      },
    })
    expect(fake.state.inputs.find((input) => input.clientMessageId === "client_replace")).toMatchObject({
      targetTurnId: result.turnId,
      delivery: "follow_up",
      status: "accepted",
    })
    expect(fake.state.inputs.find((input) => input.id === queuedFollowUp.inputId)).toMatchObject({
      status: "cancelled",
      cancelledAt: expect.any(Date),
    })
    const internalInterrupt = fake.state.inputs.find((input) => {
      const text = (input.content as Array<{ text?: string }> | undefined)?.[0]?.text
      return input.targetTurnId === started.turnId && text === "Interrupt requested"
    })
    expect(internalInterrupt?.clientMessageId).not.toBe("client_replace")
    expect(fake.state.outbox.filter((entry) => entry.topic === "agent.turn.dispatch")).toHaveLength(2)
    expect(fake.state.transactionCount - transactionsBefore).toBe(1)

    const locked = fake.tx.$queryRaw.mock.calls.findIndex((call) => {
      const sql = ((call[0] as { strings?: readonly string[] }).strings ?? []).join(" ")
      return sql.includes('SELECT "id", "status" FROM "agent_sessions"')
    })
    const duplicateLookup = fake.tx.agentInput.findFirst.mock.invocationCallOrder.at(-1) ?? 0
    const turnFence = fake.tx.agentTurn.updateMany.mock.invocationCallOrder[0] ?? 0
    expect(fake.tx.$queryRaw.mock.invocationCallOrder[locked]).toBeLessThan(duplicateLookup)
    expect(duplicateLookup).toBeLessThan(turnFence)
  })

  it.each(["paused", "archived"])(
    "replays a duplicate replacement while the Session is %s without new writes or an active-Turn check",
    async (sessionStatus) => {
      const fake = makeDb({ sessionStatus: "running" })
      const service = new AgentCommandService(fake.db)
      const started = await service.start(startCommand("client_duplicate_start"))
      const command = replacementCommand("client_replace_duplicate", started.turnId)
      const first = await service.replaceObjective(command)
      const turnLookups = fake.tx.agentTurn.findFirst.mock.calls.length
      const writes = {
        turnUpdates: fake.tx.agentTurn.updateMany.mock.calls.length,
        turnCreates: fake.tx.agentTurn.create.mock.calls.length,
        inputCreates: fake.tx.agentInput.create.mock.calls.length,
        itemCreates: fake.tx.agentItem.create.mock.calls.length,
        eventCreates: fake.tx.agentEvent.create.mock.calls.length,
        outboxCreates: fake.tx.agentOutbox.create.mock.calls.length,
        outboxCreateMany: fake.tx.agentOutbox.createMany.mock.calls.length,
        inputCount: fake.state.inputs.length,
        itemCount: fake.state.items.length,
        eventCount: fake.state.events.length,
        outboxCount: fake.state.outbox.length,
      }
      fake.state.setSessionStatus(sessionStatus)

      const duplicate = await service.replaceObjective(command)

      expect(duplicate).toMatchObject({
        disposition: "duplicate",
        originalDisposition: "started",
        turnId: first.turnId,
        inputId: first.inputId,
        sequence: first.sequence,
      })
      expect(fake.tx.agentTurn.findFirst).toHaveBeenCalledTimes(turnLookups)
      expect(fake.tx.agentTurn.updateMany).toHaveBeenCalledTimes(writes.turnUpdates)
      expect(fake.tx.agentTurn.create).toHaveBeenCalledTimes(writes.turnCreates)
      expect(fake.tx.agentInput.create).toHaveBeenCalledTimes(writes.inputCreates)
      expect(fake.tx.agentItem.create).toHaveBeenCalledTimes(writes.itemCreates)
      expect(fake.tx.agentEvent.create).toHaveBeenCalledTimes(writes.eventCreates)
      expect(fake.tx.agentOutbox.create).toHaveBeenCalledTimes(writes.outboxCreates)
      expect(fake.tx.agentOutbox.createMany).toHaveBeenCalledTimes(writes.outboxCreateMany)
      expect(fake.state.inputs).toHaveLength(writes.inputCount)
      expect(fake.state.items).toHaveLength(writes.itemCount)
      expect(fake.state.events).toHaveLength(writes.eventCount)
      expect(fake.state.outbox).toHaveLength(writes.outboxCount)
    },
  )

  it.each(["paused", "pausing", "resuming", "completed", "aborted", "archived"])(
    "rejects objective replacement in a %s Session before Turn writes",
    async (sessionStatus) => {
      const fake = makeDb({ sessionStatus, activeSource: "user" })
      await expect(new AgentCommandService(fake.db).replaceObjective(replacementCommand(`replace_${sessionStatus}`, "turn_1")))
        .rejects.toMatchObject({ code: "objective_replacement_state_conflict", status: 409, details: { status: sessionStatus } })
      expect(fake.state.rollbacks).toBe(1)
      expect(fake.tx.agentTurn.findFirst).not.toHaveBeenCalled()
      expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
      expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
      expect(fake.tx.agentItem.create).not.toHaveBeenCalled()
      expect(fake.state.inputs).toHaveLength(0)
      expect(fake.state.events).toHaveLength(0)
      expect(fake.state.outbox).toHaveLength(0)
    },
  )

  it("rejects a missing or foreign Session before objective replacement writes", async () => {
    for (const options of [{ sessionExists: false }, { sessionOwnerId: "user_2" }]) {
      const fake = makeDb({ ...options, sessionStatus: "running", activeSource: "user" })
      await expect(new AgentCommandService(fake.db).replaceObjective(replacementCommand("replace_foreign", "turn_1")))
        .rejects.toMatchObject({ code: "agent_session_not_found", status: 404 })
      expect(fake.tx.agentInput.findFirst).not.toHaveBeenCalled()
      expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
      expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
      expect(fake.state.inputs).toHaveLength(0)
    }
  })

  it.each([
    ["stale Turn", "turn_other", 0],
    ["stale revision", "turn_1", 1],
  ])("rejects a %s without interrupting or creating a successor", async (_label, expectedTurnId, expectedRevision) => {
    const fake = makeDb({ sessionStatus: "running", activeSource: "user" })
    await expect(new AgentCommandService(fake.db).replaceObjective(
      replacementCommand("replace_stale", String(expectedTurnId), Number(expectedRevision)),
    )).rejects.toMatchObject({ code: "active_turn_changed", status: 409 })
    expect(fake.state.rollbacks).toBe(1)
    expect(fake.state.active).toMatchObject({ id: "turn_1", status: "in_progress", revision: 0 })
    expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
    expect(fake.state.inputs).toHaveLength(0)
  })

  it("rejects replacement without an active Turn instead of silently starting a new one", async () => {
    const fake = makeDb({ sessionStatus: "running" })
    await expect(new AgentCommandService(fake.db).replaceObjective(replacementCommand("replace_absent", "turn_1")))
      .rejects.toMatchObject({ code: "active_turn_changed", status: 409 })
    expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("rejects replacement goals over 2,000 UTF-8 bytes before opening a transaction", async () => {
    const oversizedContent: Array<Array<{ type: "text"; text: string }>> = [
      [{ type: "text", text: "x".repeat(2_001) }],
      [{ type: "text", text: "你".repeat(667) }],
      [{ type: "text", text: "x".repeat(1_000) }, { type: "text", text: "y".repeat(1_000) }],
    ]

    for (const [index, content] of oversizedContent.entries()) {
      const fake = makeDb({ sessionStatus: "running", activeSource: "user" })
      await expect(new AgentCommandService(fake.db).replaceObjective({
        ...replacementCommand("replace_oversized_" + index, "turn_1"),
        content,
      })).rejects.toMatchObject({ code: "invalid_command", status: 422 })
      expect(fake.state.transactionCount).toBe(0)
      expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
      expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
      expect(fake.state.inputs).toHaveLength(0)
      expect(fake.state.outbox).toHaveLength(0)
    }
  })

  it("accepts exactly 2,000 UTF-8 bytes and persists that replacement goal", async () => {
    const fake = makeDb({ sessionStatus: "running", activeSource: "user" })
    const goal = "x".repeat(2_000)
    const result = await new AgentCommandService(fake.db).replaceObjective({
      ...replacementCommand("replace_exact_boundary", "turn_1"),
      content: [{ type: "text", text: goal }],
    })

    const successor = fake.state.turns.find((turn) => turn.id === result.turnId)
    expect(successor?.input).toMatchObject({ goal })
  })

  it("keeps the ordinary message text limit independent from replacement objectives", async () => {
    const fake = makeDb()
    const text = "x".repeat(20_000)
    const result = await new AgentCommandService(fake.db).message({
      ...startCommand("ordinary_long_message"),
      delivery: "follow_up",
      content: [{ type: "text", text }],
    })

    expect(result.disposition).toBe("started")
    expect(fake.state.turns[0]?.input).toMatchObject({ goal: text })
  })

  it("rejects automation and blank-text calls before opening a transaction", async () => {
    const fake = makeDb({ sessionStatus: "running", activeSource: "user" })
    const service = new AgentCommandService(fake.db)
    await expect(service.replaceObjective(replacementCommand("replace_automation", "turn_1", 0, "automation")))
      .rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.replaceObjective({
      ...replacementCommand("replace_blank", "turn_1"),
      content: [{ type: "text", text: "   " }],
    })).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.replaceObjective({
      ...replacementCommand("replace_missing_turn", "turn_1"),
      expectedTurnId: "",
    })).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.replaceObjective({
      ...replacementCommand("replace_bad_revision", "turn_1"),
      expectedRevision: -1,
    })).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    expect(fake.state.rawQueries).toHaveLength(0)
    expect(fake.state.rollbacks).toBe(0)
  })

  it("rolls back the interruption when successor dispatch admission fails", async () => {
    const originalInput = { goal: "Original objective", content: [{ type: "text", text: "Original objective" }] }
    const fake = makeDb({ sessionStatus: "running", activeSource: "user", activeInput: originalInput, failDispatchOutbox: true })

    await expect(new AgentCommandService(fake.db).replaceObjective(replacementCommand("replace_rollback", "turn_1")))
      .rejects.toThrow("outbox unavailable")

    expect(fake.state.rollbacks).toBe(1)
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.turns[0]).toMatchObject({ id: "turn_1", status: "in_progress", revision: 0, input: originalInput })
    expect(fake.state.active).toMatchObject({ id: "turn_1", status: "in_progress", revision: 0, input: originalInput })
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.items).toHaveLength(0)
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("uses the open session fence before command admission", async () => {
    const fake = makeDb()
    await new AgentCommandService(fake.db).start(startCommand("client_open_fence"))

    const sessionLock = fake.state.rawQueries
      .map((query) => ((query as { strings?: readonly string[] }).strings ?? []).join(" "))
      .find((sql) => sql.includes('FROM "agent_sessions"') && sql.includes('"status" NOT IN') && sql.includes("FOR UPDATE"))
    expect(sessionLock).toContain('"userId" =')
    expect(sessionLock).toContain('"status" NOT IN (\'aborted\', \'archived\')')
  })

  it.each([
    ["start", "aborted", { sessionStatus: "aborted" }],
    ["message", "archived", { sessionStatus: "archived" }],
    ["interrupt", "missing", { sessionExists: false }],
    ["start", "cross-user", { sessionOwnerId: "user_2" }],
    ["message", "aborted", { sessionStatus: "aborted" }],
    ["interrupt", "archived", { sessionStatus: "archived" }],
    ["start", "missing", { sessionExists: false }],
    ["message", "cross-user", { sessionOwnerId: "user_2" }],
    ["interrupt", "aborted", { sessionStatus: "aborted" }],
    ["start", "archived", { sessionStatus: "archived" }],
    ["message", "missing", { sessionExists: false }],
    ["interrupt", "cross-user", { sessionOwnerId: "user_2" }],
  ])("rejects %s on a %s session before durable mutations", async (action, _label, options) => {
    const fake = makeDb(options)
    const service = new AgentCommandService(fake.db)
    const clientMessageId = `client_closed_${action}_${_label}`
    const result: Promise<unknown> = action === "interrupt"
      ? service.interrupt({ ...startCommand(clientMessageId), expectedTurnId: "turn_1" })
      : action === "message"
        ? service.message({ ...startCommand(clientMessageId), delivery: "follow_up" as const })
        : service.start(startCommand(clientMessageId))

    await expect(result).rejects.toMatchObject({ code: "agent_session_not_found", status: 404 })
    expect(fake.state.rollbacks).toBe(1)
    expect(fake.tx.agentInput.findFirst).not.toHaveBeenCalled()
    expect(fake.tx.agentTurn.findFirst).not.toHaveBeenCalled()
    expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
    expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(fake.tx.agentItem.create).not.toHaveBeenCalled()
    expect(fake.tx.agentEvent.findFirst).not.toHaveBeenCalled()
    expect(fake.tx.agentEvent.create).not.toHaveBeenCalled()
    expect(fake.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.items).toHaveLength(0)
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
    expect(fake.state.rawQueries.length).toBe(1)
    const sql = ((fake.state.rawQueries[0] as { strings?: readonly string[] }).strings ?? []).join(" ")
    expect(sql).toContain('"status" NOT IN (\'aborted\', \'archived\')')
    expect(sql).toContain("FOR UPDATE")
    expect(sql).toContain('"userId" =')
  })

  it("cancels an automation execution and interrupts its active Turn in one transaction", async () => {
    const fake = makeDb({ executionStatus: "running", sessionSource: "automation", activeSource: "automation", activeTurnId: "turn_automation_1" })
    const service = new AgentCommandService(fake.db)

    await expect(service.cancelExecution({ executionId: "execution_1", userId: "user_1", sessionId: "session_1" })).resolves.toBe(true)

    expect(fake.state.execution).toMatchObject({ status: "cancelled" })
    expect(fake.state.active).toMatchObject({ status: "interrupted", revision: 1 })
    expect(fake.state.sessionStatus).toBe("aborted")
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.events.filter((event) => event.type === "turn.interrupted")).toHaveLength(1)
    expect(fake.state.inputs[0]).toMatchObject({ clientMessageId: "agent-execution-cancel:execution_1:turn_automation_1" })
  })

  it("cancels safely without an active Turn and does not interrupt a user-owned Turn", async () => {
    const noTurn = makeDb({ executionStatus: "running", sessionSource: "automation" })
    await expect(new AgentCommandService(noTurn.db).cancelExecution({ executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)
    expect(noTurn.state.execution).toMatchObject({ status: "cancelled" })
    expect(noTurn.state.inputs).toHaveLength(0)

    const userTurn = makeDb({ executionStatus: "running", sessionSource: "automation", activeSource: "user" })
    await expect(new AgentCommandService(userTurn.db).cancelExecution({ executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)
    expect(userTurn.state.active).toMatchObject({ status: "in_progress", revision: 0 })
    expect(userTurn.state.inputs).toHaveLength(0)
  })

  it("keeps cancellation idempotent while a restarted execution gets a new Turn key", async () => {
    const fake = makeDb({ executionStatus: "running", sessionSource: "automation", activeSource: "automation", activeTurnId: "turn_1" })
    const service = new AgentCommandService(fake.db)

    await service.cancelExecution({ executionId: "execution_1", userId: "user_1" })
    fake.tx.agentExecution.findFirst.mockImplementation(async () => ({ id: "execution_1", sessionId: "session_1", status: "running" }))
    fake.tx.agentExecution.updateMany.mockImplementation(async () => ({ count: 1 }))
    fake.state.setActive({ id: "turn_2", source: "automation", status: "in_progress", revision: 0 })
    await service.cancelExecution({ executionId: "execution_1", userId: "user_1" })

    expect(fake.state.inputs.map((input) => input.clientMessageId)).toEqual([
      "agent-execution-cancel:execution_1:turn_1",
      "agent-execution-cancel:execution_1:turn_2",
    ])
  })

  it("returns false for terminal executions and propagates cancellation write failures", async () => {
    const terminal = makeDb({ executionStatus: "completed", sessionSource: "automation", activeSource: "automation" })
    await expect(new AgentCommandService(terminal.db).cancelExecution({ executionId: "execution_1", userId: "user_1" })).resolves.toBe(false)
    expect(terminal.state.inputs).toHaveLength(0)

    const failed = makeDb({ executionStatus: "running", sessionSource: "automation" })
    failed.tx.agentExecution.updateMany.mockRejectedValue(new Error("database unavailable"))
    await expect(new AgentCommandService(failed.db).cancelExecution({ executionId: "execution_1", userId: "user_1" })).rejects.toThrow("database unavailable")
    expect(failed.state.execution).toMatchObject({ status: "running" })
  })

  it("retries a failed Turn atomically from its persisted input", async () => {
    const fake = makeDb({ retryTarget: { ...retryTarget("failed", { goal: "Canonical persisted retry objective", content: [...content] }), rootTaskId: "task-claimed" } })
    const result = await new AgentCommandService(fake.db).retry(retryCommand("retry_1"))

    expect(result).toMatchObject({ disposition: "started", sequence: "2" })
    expect(result.turnId).not.toBe("turn_failed")
    expect(fake.state.active).toMatchObject({ status: "queued", source: "user" })
    expect(fake.state.active).toMatchObject({ input: { goal: "Canonical persisted retry objective", content } })
    expect(fake.state.active?.input).not.toHaveProperty("intent")
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.inputs[0]).toMatchObject({ delivery: "follow_up", content })
    expect(fake.state.events.map(event => event.type)).toEqual(["turn.started", "input.accepted"])
    expect(fake.state.outbox.filter(entry => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
  })

  it("preserves server-owned discovery intent when retrying a failed Turn", async () => {
    const intent = { kind: "interactive_discovery_shortlist", version: 1 } as const
    const input = { goal: "Retry discovery", content: [...content], intent }
    const fake = makeDb({ retryTarget: retryTarget("failed", input) })

    await new AgentCommandService(fake.db).retry(retryCommand("retry_discovery"))

    expect(fake.state.active?.input).toMatchObject({ goal: "Retry discovery", content, intent })
  })

  it("returns the original result for a duplicate retry without new durable facts", async () => {
    const fake = makeDb({ retryTarget: retryTarget() })
    const service = new AgentCommandService(fake.db)
    const first = await service.retry(retryCommand("retry_duplicate"))
    const second = await service.retry(retryCommand("retry_duplicate", 999))

    expect(second).toMatchObject({ disposition: "duplicate", originalDisposition: "started", turnId: first.turnId, inputId: first.inputId, sequence: first.sequence })
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.events).toHaveLength(2)
    expect(fake.state.outbox.filter(entry => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
  })

  it("rejects an active conflict, invalid target, ownership mismatch, and malformed persisted input", async () => {
    const active = makeDb({ activeSource: "user", activeRootTaskId: "task-claimed", retryTarget: retryTarget() })
    await expect(new AgentCommandService(active.db).retry(retryCommand("retry_active"))).rejects.toMatchObject({ code: "retry_active_conflict", status: 409 })
    expect(active.state.inputs).toHaveLength(0)

    for (const target of [retryTarget("completed"), retryTarget("queued"), retryTarget("waiting_for_user")]) {
      const fake = makeDb({ retryTarget: target })
      await expect(new AgentCommandService(fake.db).retry(retryCommand(`retry_${target.status}`))).rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
      expect(fake.state.inputs).toHaveLength(0)
    }

    const foreign = makeDb({ sessionOwnerId: "user_2", retryTarget: retryTarget() })
    await expect(new AgentCommandService(foreign.db).retry(retryCommand("retry_foreign"))).rejects.toMatchObject({ code: "agent_session_not_found", status: 404 })

    const malformed = makeDb({ retryTarget: retryTarget("failed", { content: [{ type: "text", text: "ok", secret: "reject" }] }) })
    await expect(new AgentCommandService(malformed.db).retry(retryCommand("retry_malformed"))).rejects.toMatchObject({ code: "retry_input_invalid", status: 409 })
    expect(malformed.state.inputs).toHaveLength(0)

    for (const [label, input] of [
      ["missing", { content: [...content] }],
      ["empty", { goal: "", content: [...content] }],
      ["foreign", { goal: "\u0001", content: [...content] }],
    ] as const) {
      const fake = makeDb({ retryTarget: retryTarget("failed", input) })
      await expect(new AgentCommandService(fake.db).retry(retryCommand(`retry_goal_${label}`))).rejects.toMatchObject({ code: "retry_input_invalid", status: 409 })
      expect(fake.state.active).toBeNull()
      expect(fake.state.inputs).toHaveLength(0)
      expect(fake.state.items).toHaveLength(0)
      expect(fake.state.events).toHaveLength(0)
      expect(fake.state.outbox).toHaveLength(0)
    }
  })

  it("rolls back retry Turn, facts, and dispatch when the transaction fails", async () => {
    const fake = makeDb({ failOutbox: true, retryTarget: retryTarget() })
    await expect(new AgentCommandService(fake.db).retry(retryCommand("retry_rollback"))).rejects.toThrow("outbox unavailable")
    expect(fake.state.active).toBeNull()
    expect(fake.state.items).toHaveLength(0)
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
    expect(fake.state.rollbacks).toBe(1)
  })

  it("replays an accepted command after its active Turn advances without duplicate writes", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const command = startCommand("advanced_duplicate")
    const accepted = await service.start(command)
    fake.state.setActive({ ...fake.state.active!, status: "waiting_for_user" })

    const duplicate = await service.start(command)

    expect(duplicate).toMatchObject({ disposition: "duplicate", inputId: accepted.inputId, turnId: accepted.turnId, originalDisposition: "started" })
    expect(fake.state.inputs).toHaveLength(1)
  })
})
