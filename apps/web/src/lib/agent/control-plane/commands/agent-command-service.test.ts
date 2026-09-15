import { describe, expect, it, vi } from "vitest"

import type { PrismaClient } from "@prisma/client"

import { AgentCommandService } from "./agent-command-service"

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
  executionStatus?: string
  sessionSource?: string
  activeSource?: string
  activeTurnId?: string
  activeRootTaskId?: string | null
  retryTarget?: Row & { revision: number }
} = {}) {
  const ownerId = options.ownerId ?? "user_1"
  const sessionExists = options.sessionExists ?? true
  const sessionOwnerId = options.sessionOwnerId ?? ownerId
  let active: (Row & { revision: number }) | null = options.activeSource
    ? { id: options.activeTurnId ?? "turn_1", source: options.activeSource, status: "in_progress", revision: 0, rootTaskId: options.activeRootTaskId ?? null }
    : null
  let execution: { id: string; sessionId: string; status: string } | null = options.executionStatus
    ? { id: "execution_1", sessionId: "session_1", status: options.executionStatus }
    : null
  let sessionStatus = options.sessionStatus ?? "active"
  const rawQueries: unknown[] = []
  let rollbacks = 0
  let sequence = BigInt(0)
  let inputs: Row[] = []
  let items: Row[] = []
  let events: Row[] = []
  let outbox: Row[] = []
  let transactionQueue = Promise.resolve()

  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      rawQueries.push(query)
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      const sql = strings.join(" ")
      if (sql.includes("SELECT")) {
        const openFence = sql.includes('"status" NOT IN')
        const available = sessionExists && sessionOwnerId === ownerId && (!openFence || !["aborted", "archived"].includes(sessionStatus))
        return available ? [{ id: "session_1" }] : []
      }
      sequence += BigInt(1)
      return [{ eventSequence: sequence }]
    }),
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
        return active
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Row }).data
        active = { id: String(data.id), source: data.source, status: "queued", revision: 0 }
        return { id: active.id }
      }),
      updateMany: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        if (!active || where.id !== active.id || where.revision !== active.revision) return { count: 0 }
        active = { ...active, status: "interrupted", revision: active.revision + 1 }
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
    agentApproval: { updateMany: vi.fn(async () => ({ count: 1 })) },
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
        if (options.failOutbox) throw new Error("outbox unavailable")
        const data = (args as { data: Row }).data
        outbox.push(data)
        return data
      }),
    },
  }

  const transaction = vi.fn(<T>(work: (transaction: typeof tx) => Promise<T>) => {
    const run = transactionQueue.then(async () => {
      const before = {
        active,
        execution,
        sessionStatus,
        sequence,
        inputs: [...inputs],
        items: [...items],
        events: [...events],
        outbox: [...outbox],
      }
      try {
        return await work(tx)
      } catch (error: unknown) {
        rollbacks += 1
        active = before.active
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
      get rollbacks() { return rollbacks },
      get active() { return active },
      setActive(value: (Row & { revision: number }) | null) { active = value },
      get execution() { return execution },
      get sessionStatus() { return sessionStatus },
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

function retryTarget(status = "failed", input: unknown = { goal: "Find backend roles", content: [...content] }) {
  return { id: "turn_failed", sessionId: "session_1", userId: "user_1", status, source: "user", revision: 4, input }
}

function retryCommand(clientMessageId: string, expectedRevision: number | null = 4) {
  return { sessionId: "session_1", userId: "user_1", clientMessageId, source: "user" as const, targetTurnId: "turn_failed", expectedRevision }
}

describe("AgentCommandService", () => {
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

  it("queues a follow-up when the caller intentionally leaves expected Turn empty", async () => {
    const fake = makeDb()
    const service = new AgentCommandService(fake.db)
    const started = await service.start(startCommand("client_start"))

    const result = await service.message({
      ...startCommand("client_follow_up"),
      delivery: "follow_up",
      expectedTurnId: null,
      expectedRevision: null,
    })

    expect(result).toMatchObject({ disposition: "queued_follow_up", turnId: started.turnId })
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

    const result = await service.interrupt({
      ...startCommand("client_interrupt"),
      expectedTurnId: started.turnId,
    })

    expect(result).toMatchObject({ disposition: "interrupted", turnId: started.turnId })
    expect(fake.state.active).toMatchObject({ status: "interrupted", revision: 1 })
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
    const fake = makeDb({ retryTarget: { ...retryTarget(), rootTaskId: "task-claimed" } })
    const result = await new AgentCommandService(fake.db).retry(retryCommand("retry_1"))

    expect(result).toMatchObject({ disposition: "started", sequence: "2" })
    expect(result.turnId).not.toBe("turn_failed")
    expect(fake.state.active).toMatchObject({ status: "queued", source: "user" })
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.inputs[0]).toMatchObject({ delivery: "follow_up", content })
    expect(fake.state.events.map(event => event.type)).toEqual(["turn.started", "input.accepted"])
    expect(fake.state.outbox.filter(entry => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
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
})
