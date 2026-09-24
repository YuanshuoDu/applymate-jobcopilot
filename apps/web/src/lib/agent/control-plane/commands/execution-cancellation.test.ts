import { describe, expect, it, vi } from "vitest"

import type { CommandTransaction } from "./transaction"
import { cancelExecutionInTransaction } from "./execution-cancellation"

type State = {
  execution: { id: string; sessionId: string; userId: string; status: string } | null
  sessionSource: string | null
  sessionStatus: string
  active: { id: string; source: string; status: string; revision: number } | null
  tasks: Array<{
    userId: string
    sessionId: string
    turnId: string
    status: string
    interruptRequestedAt: Date | null
    nextAttemptAt: Date | null
    completedAt: Date | null
    leaseOwner: string | null
    leaseExpiresAt: Date | null
  }>
  applicationTasks: Array<{
    id: string
    userId: string
    sessionId: string
    status: string
    checkpoint: string | null
    completedAt: Date | null
  }>
  approvals: Array<{
    userId: string
    sessionId: string
    turnId: string
    type: string
    status: string
    payload: Record<string, unknown>
  }>
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
  childTasks?: State["tasks"]
  applicationTasks?: State["applicationTasks"]
  approvals?: State["approvals"]
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
    tasks: options.childTasks ?? [],
    applicationTasks: options.applicationTasks ?? [],
    approvals: options.approvals ?? [],
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
    $executeRaw: vi.fn(async (query: unknown) => {
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      const sql = strings.join(" ")
      const values = (query as { values?: readonly unknown[] }).values ?? []
      if (sql.includes('UPDATE "application_tasks"')) {
        const requestedAt = values[0] instanceof Date ? values[0] : new Date(String(values[0]))
        const userId = String(values[1])
        const sessionId = String(values[2])
        const turnId = String(values[5])
        let count = 0
        for (const task of state.applicationTasks) {
          const authorized = state.approvals.some((approval) => approval.userId === userId
            && approval.sessionId === sessionId && approval.turnId === turnId
            && approval.type === "submit_application" && ["approved", "consumed"].includes(approval.status)
            && approval.payload.applicationTaskId === task.id)
          const beforeSubmit = (task.status === "filling" && task.checkpoint !== "submission_request_started")
            || (task.status === "waiting_for_authorization" && task.checkpoint === "form_filled")
          if (task.userId !== userId || task.sessionId !== sessionId || !beforeSubmit || !authorized) continue
          task.status = "cancelled"
          task.checkpoint = "turn_stopped_before_submit"
          task.completedAt = requestedAt
          count += 1
        }
        return count
      }
      const requestedAt = values[0] instanceof Date ? values[0] : new Date(String(values[0]))
      const sessionId = String(values[3])
      const turnId = String(values[4])
      const userId = String(values[5])
      let count = 0
      for (const task of state.tasks) {
        if (task.userId !== userId || task.sessionId !== sessionId || task.turnId !== turnId
          || !["queued", "running", "retrying", "waiting", "waiting_for_user"].includes(task.status)) continue
        count += 1
        task.interruptRequestedAt ??= requestedAt
        if (["queued", "retrying", "waiting", "waiting_for_user"].includes(task.status)) {
          task.status = "interrupted"
          task.nextAttemptAt = null
          task.completedAt = requestedAt
        }
      }
      return count
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

  it("interrupts only the exact user/session/Turn task tree and preserves running leases", async () => {
    const runningLeaseExpiresAt = new Date("2026-09-16T12:05:00.000Z")
    const runningNextAttemptAt = new Date("2026-09-16T12:01:00.000Z")
    const childTasks: State["tasks"] = [
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", status: "running", interruptRequestedAt: null, nextAttemptAt: runningNextAttemptAt, completedAt: null, leaseOwner: "child-owner", leaseExpiresAt: runningLeaseExpiresAt },
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", status: "queued", interruptRequestedAt: null, nextAttemptAt: runningNextAttemptAt, completedAt: null, leaseOwner: null, leaseExpiresAt: null },
      { userId: "user_1", sessionId: "session_1", turnId: "turn_2", status: "queued", interruptRequestedAt: null, nextAttemptAt: runningNextAttemptAt, completedAt: null, leaseOwner: null, leaseExpiresAt: null },
      { userId: "user_1", sessionId: "session_2", turnId: "turn_1", status: "queued", interruptRequestedAt: null, nextAttemptAt: runningNextAttemptAt, completedAt: null, leaseOwner: null, leaseExpiresAt: null },
      { userId: "user_2", sessionId: "session_1", turnId: "turn_1", status: "queued", interruptRequestedAt: null, nextAttemptAt: runningNextAttemptAt, completedAt: null, leaseOwner: null, leaseExpiresAt: null },
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", status: "completed", interruptRequestedAt: null, nextAttemptAt: null, completedAt: runningNextAttemptAt, leaseOwner: null, leaseExpiresAt: null },
    ]
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation", activeSource: "automation", childTasks })

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)

    expect(childTasks[0]).toMatchObject({ status: "running", nextAttemptAt: runningNextAttemptAt, completedAt: null, leaseOwner: "child-owner", leaseExpiresAt: runningLeaseExpiresAt })
    expect(childTasks[0]?.interruptRequestedAt).toBeInstanceOf(Date)
    expect(childTasks[1]).toMatchObject({ status: "interrupted", nextAttemptAt: null, completedAt: expect.any(Date) })
    expect(childTasks.slice(2).every((task) => task.interruptRequestedAt === null)).toBe(true)

    const query = (fake.tx.$executeRaw as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([value]) => value as { strings?: readonly string[] })
      .find((value) => (value.strings ?? []).join(" ").includes('UPDATE "sub_agent_tasks"'))
    expect(query).toBeDefined()
    const sql = query?.strings?.join(" ") ?? ""
    expect(sql).toContain('task."sessionId" =')
    expect(sql).toContain('task."turnId" =')
    expect(sql).toContain('session."userId" =')
    expect(sql).toContain('turn."userId" =')
    expect(sql).toContain('COALESCE(task."interruptRequestedAt"')
    expect(sql).toContain("'running'")
  })

  it("cancels approved and consumed application tasks before the submit checkpoint, after locking the Turn", async () => {
    const applicationTasks: State["applicationTasks"] = [
      { id: "application_approved", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active", completedAt: null },
      { id: "application_consumed", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: null, completedAt: null },
    ]
    const approvals: State["approvals"] = [
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", type: "submit_application", status: "approved", payload: { applicationTaskId: "application_approved" } },
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", type: "submit_application", status: "consumed", payload: { applicationTaskId: "application_consumed" } },
    ]
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation", activeSource: "automation", applicationTasks, approvals })

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)

    expect(applicationTasks).toEqual([
      expect.objectContaining({ status: "cancelled", checkpoint: "turn_stopped_before_submit", completedAt: expect.any(Date) }),
      expect.objectContaining({ status: "cancelled", checkpoint: "turn_stopped_before_submit", completedAt: expect.any(Date) }),
    ])
    const turnUpdateOrder = (fake.tx.agentTurn.updateMany as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const applicationUpdateOrder = (fake.tx.$executeRaw as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(turnUpdateOrder).toBeLessThan(applicationUpdateOrder)

    const query = (fake.tx.$executeRaw as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { strings?: readonly string[] }
    const sql = query.strings?.join(" ") ?? ""
    expect(sql).toContain('application."checkpoint" IS DISTINCT FROM \'submission_request_started\'')
    expect(sql).toContain('application."status" = \'waiting_for_authorization\'')
    expect(sql).toContain('application."checkpoint" = \'form_filled\'')
    expect(sql).toContain('approval."status" IN (\'approved\', \'consumed\')')
    expect(sql).toContain('approval."payload"->>\'applicationTaskId\' = application."id"')
    expect(sql).toContain('approval."turnId" =')
  })

  it("preserves application tasks that crossed the submit checkpoint and terminal tasks", async () => {
    const applicationTasks: State["applicationTasks"] = [
      { id: "application_started", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "submission_request_started", completedAt: null },
      { id: "application_submitted", userId: "user_1", sessionId: "session_1", status: "submitted", checkpoint: "submitted", completedAt: new Date("2026-09-16T12:00:00.000Z") },
    ]
    const approvals: State["approvals"] = applicationTasks.map((task) => ({
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", type: "submit_application", status: "consumed", payload: { applicationTaskId: task.id },
    }))
    const before = applicationTasks.map((task) => ({ ...task }))
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation", activeSource: "automation", applicationTasks, approvals })

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)

    expect(applicationTasks).toEqual(before)
  })

  it("cancels an approved filled task before its conditional queue transition", async () => {
    const applicationTasks: State["applicationTasks"] = [
      { id: "application_ready", userId: "user_1", sessionId: "session_1", status: "waiting_for_authorization", checkpoint: "form_filled", completedAt: null },
    ]
    const approvals: State["approvals"] = [
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", type: "submit_application", status: "approved", payload: { applicationTaskId: "application_ready" } },
    ]
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation", activeSource: "automation", applicationTasks, approvals })

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)

    // Models queueAutonomousApplication's conditional status/checkpoint update.
    const queuedTask = applicationTasks.find((task) => task.id === "application_ready"
      && task.status === "waiting_for_authorization" && task.checkpoint === "form_filled")
    if (queuedTask) {
      queuedTask.status = "filling"
      queuedTask.checkpoint = "submission_authorized"
    }
    expect(queuedTask).toBeUndefined()
    expect(applicationTasks[0]).toMatchObject({ status: "cancelled", checkpoint: "turn_stopped_before_submit", completedAt: expect.any(Date) })
  })

  it("scope-fences linked approvals and stays idempotent when Stop is retried", async () => {
    const applicationTasks: State["applicationTasks"] = [
      { id: "application_valid", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active", completedAt: null },
      { id: "application_wrong_user", userId: "user_2", sessionId: "session_1", status: "filling", checkpoint: "browser_active", completedAt: null },
      { id: "application_wrong_session", userId: "user_1", sessionId: "session_2", status: "filling", checkpoint: "browser_active", completedAt: null },
      { id: "application_wrong_turn", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active", completedAt: null },
      { id: "application_wrong_type", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active", completedAt: null },
      { id: "application_pending", userId: "user_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active", completedAt: null },
    ]
    const approvals: State["approvals"] = [
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", type: "submit_application", status: "approved", payload: { applicationTaskId: "application_valid" } },
      { userId: "user_2", sessionId: "session_1", turnId: "turn_1", type: "submit_application", status: "approved", payload: { applicationTaskId: "application_wrong_user" } },
      { userId: "user_1", sessionId: "session_2", turnId: "turn_1", type: "submit_application", status: "approved", payload: { applicationTaskId: "application_wrong_session" } },
      { userId: "user_1", sessionId: "session_1", turnId: "turn_2", type: "submit_application", status: "approved", payload: { applicationTaskId: "application_wrong_turn" } },
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", type: "other_action", status: "approved", payload: { applicationTaskId: "application_wrong_type" } },
      { userId: "user_1", sessionId: "session_1", turnId: "turn_1", type: "submit_application", status: "pending", payload: { applicationTaskId: "application_pending" } },
    ]
    const fake = makeTransaction({ executionStatus: "running", sessionSource: "automation", activeSource: "automation", applicationTasks, approvals })

    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)
    await expect(cancelExecutionInTransaction(fake.tx, { executionId: "execution_1", userId: "user_1" })).resolves.toBe(true)

    expect(applicationTasks[0]).toMatchObject({ status: "cancelled", checkpoint: "turn_stopped_before_submit" })
    expect(applicationTasks.slice(1).every((task) => task.status === "filling" && task.checkpoint === "browser_active")).toBe(true)
    const applicationUpdates = (fake.tx.$executeRaw as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([query]) => ((query as { strings?: readonly string[] }).strings ?? []).join(" ").includes('UPDATE "application_tasks"'))
    expect(applicationUpdates).toHaveLength(1)
    expect(fake.state.inputs).toHaveLength(1)
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
