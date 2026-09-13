import { describe, expect, it, vi } from "vitest"

import type { CommandTransaction } from "./transaction"
import { cancelExecutionInTransaction } from "./execution-cancellation"

type State = {
  execution: { id: string; sessionId: string; userId: string; status: string } | null
  sessionSource: string | null
  sessionStatus: string
  active: { id: string; source: string; status: string; revision: number } | null
  inputs: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
}

function whereOf(args: unknown): Record<string, unknown> {
  return ((args as { where?: Record<string, unknown> }).where ?? {})
}

function makeTransaction(options: {
  executionStatus: string
  sessionSource: string | null
  activeSource?: string
  activeTurnId?: string
  userId?: string
}) {
  const state: State = {
    execution: {
      id: "execution_1",
      sessionId: "session_1",
      userId: options.userId ?? "user_1",
      status: options.executionStatus,
    },
    sessionSource: options.sessionSource,
    sessionStatus: "active",
    active: options.activeSource
      ? { id: options.activeTurnId ?? "turn_1", source: options.activeSource, status: "in_progress", revision: 0 }
      : null,
    inputs: [],
    events: [],
  }
  let sequence = BigInt(0)
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      if (strings.join(" ").includes("SELECT")) return [{ id: "session_1" }]
      sequence += BigInt(1)
      return [{ eventSequence: sequence }]
    }),
    agentExecution: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        if (!state.execution || where.id !== state.execution.id || where.userId !== state.execution.userId || (where.sessionId && where.sessionId !== state.execution.sessionId)) return null
        return { id: state.execution.id, sessionId: state.execution.sessionId, status: state.execution.status }
      }),
      updateMany: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        const statuses = (where.status as { in?: unknown[] } | undefined)?.in ?? []
        if (!state.execution || !statuses.includes(state.execution.status)) return { count: 0 }
        state.execution.status = "cancelled"
        return { count: 1 }
      }),
    },
    agentSession: {
      findFirst: vi.fn(async () => state.sessionSource ? { source: state.sessionSource } : null),
      updateMany: vi.fn(async () => {
        state.sessionStatus = "aborted"
        return { count: 1 }
      }),
    },
    agentTurn: {
      findFirst: vi.fn(async () => state.active),
      updateMany: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        if (!state.active || where.id !== state.active.id || where.revision !== state.active.revision) return { count: 0 }
        state.active = { ...state.active, status: "interrupted", revision: state.active.revision + 1 }
        return { count: 1 }
      }),
    },
    agentInput: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        return state.inputs.find((input) => input.sessionId === where.sessionId && input.clientMessageId === where.clientMessageId) ?? null
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data
        state.inputs.push(data)
        return data
      }),
    },
    agentItem: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async (args: unknown) => (args as { data: Record<string, unknown> }).data),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentApproval: { updateMany: vi.fn(async () => ({ count: 1 })) },
    agentEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        return state.events.find((event) => event.sessionId === where.sessionId && event.idempotencyKey === where.idempotencyKey) ?? null
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data
        const event = { ...data, sequence: data.sequence ?? BigInt(state.events.length + 1) }
        state.events.push(event)
        return event
      }),
    },
    agentOutbox: { create: vi.fn(async (args: unknown) => (args as { data: Record<string, unknown> }).data) },
  }
  return { tx: tx as unknown as CommandTransaction, state }
}

describe("execution cancellation transaction", () => {
  it("fails closed for an execution owned by another user", async () => {
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation", userId: "user_2" })

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(false)
    expect(fake.state.sessionStatus).toBe("active")
  })

  it("preserves terminal executions and safely cancels without an active Turn", async () => {
    for (const executionStatus of ["completed", "failed"]) {
      const terminal = makeTransaction({ executionStatus, sessionSource: "automation", activeSource: "automation" })
      await expect(cancelExecutionInTransaction(terminal.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(false)
      expect(terminal.state.active).toMatchObject({ status: "in_progress" })
    }

    const noTurn = makeTransaction({ executionStatus: "running", sessionSource: "automation" })
    await expect(cancelExecutionInTransaction(noTurn.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)
    expect(noTurn.state.execution).toMatchObject({ status: "cancelled" })
    expect(noTurn.state.sessionStatus).toBe("aborted")
    expect(noTurn.state.inputs).toHaveLength(0)
  })

  it("does not interrupt a user Turn or a non-automation session", async () => {
    const userTurn = makeTransaction({ executionStatus: "running", sessionSource: "automation", activeSource: "user" })
    await expect(cancelExecutionInTransaction(userTurn.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)
    expect(userTurn.state.active).toMatchObject({ status: "in_progress", revision: 0 })
    expect(userTurn.state.inputs).toHaveLength(0)

    const userSession = makeTransaction({ executionStatus: "running", sessionSource: "user", activeSource: "automation" })
    await expect(cancelExecutionInTransaction(userSession.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)
    expect(userSession.state.active).toMatchObject({ status: "in_progress", revision: 0 })
    expect(userSession.state.inputs).toHaveLength(0)
  })

  it("uses a new interrupt key when the same execution starts a new Turn", async () => {
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation", activeSource: "automation", activeTurnId: "turn_1" })
    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)

    fake.state.execution!.status = "running"
    fake.state.active = { id: "turn_2", source: "automation", status: "in_progress", revision: 0 }
    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)

    expect(fake.state.inputs.map((input) => input.clientMessageId)).toEqual([
      "agent-execution-cancel:execution_1:turn_1",
      "agent-execution-cancel:execution_1:turn_2",
    ])
  })

  it("repairs a previously cancelled execution once without duplicating its interrupt", async () => {
    const fake = makeTransaction({ executionStatus: "cancelled", sessionSource: "automation", activeSource: "automation" })

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)
    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)

    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.active).toMatchObject({ status: "interrupted", revision: 1 })
  })

  it("reports an execution status race separately from a Turn race", async () => {
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation" })
    vi.spyOn(fake.tx.agentExecution, "updateMany").mockResolvedValue({ count: 0 })

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).rejects.toMatchObject({
      code: "execution_changed",
      status: 409,
    })
  })

  it("propagates an execution write failure to the transaction owner", async () => {
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation" })
    vi.spyOn(fake.tx.agentExecution, "updateMany").mockRejectedValue(new Error("database unavailable"))

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).rejects.toThrow("database unavailable")
  })
})
