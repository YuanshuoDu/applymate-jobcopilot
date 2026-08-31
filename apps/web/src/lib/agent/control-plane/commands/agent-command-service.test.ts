import { describe, expect, it, vi } from "vitest"

import type { PrismaClient } from "@prisma/client"

import { AgentCommandService } from "./agent-command-service"

type Row = Record<string, unknown>

function whereOf(args: unknown): Row {
  return ((args as { where?: Row }).where ?? {})
}

function makeDb(options: { ownerId?: string; failOutbox?: boolean } = {}) {
  const ownerId = options.ownerId ?? "user_1"
  let active: (Row & { revision: number }) | null = null
  let sequence = BigInt(0)
  let inputs: Row[] = []
  let items: Row[] = []
  let events: Row[] = []
  let outbox: Row[] = []
  let transactionQueue = Promise.resolve()

  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      if (strings.join(" ").includes("SELECT")) return [{ id: "session_1" }]
      sequence += BigInt(1)
      return [{ eventSequence: sequence }]
    }),
    agentSession: { findFirst: vi.fn() },
    agentTurn: {
      findFirst: vi.fn(async () => active),
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
    },
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
      const before = { active, sequence, inputs: [...inputs], items: [...items], events: [...events], outbox: [...outbox] }
      try {
        return await work(tx)
      } catch (error: unknown) {
        active = before.active
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
      get active() { return active },
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
})
