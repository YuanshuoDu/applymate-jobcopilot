import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Prisma, PrismaClient } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"

import { cancelPendingWaitsInTransaction } from "../broker/interrupt"
import { consumeApproval, consumeApprovalAndReserve, issueApprovalReceipt, validateApproval, validatePendingApprovalReceipt } from "./store"
import { reissueApprovalNonce } from "./receipt-rotation"
import { protocolScope, ApprovalStoreError, type ApprovalScopeInput } from "./types"

const TEST_NOW_MS = Date.parse("2026-09-01T00:00:00.000Z")
const timeAt = (minutes: number): Date => new Date(TEST_NOW_MS + minutes * 60_000)

const scopeInput: ApprovalScopeInput = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "call_1", action: "submit_application",
  resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64), revision: 3,
  expiresAt: timeAt(60),
}

async function approvalRow(nonce = "nonce_1"): Promise<Prisma.AgentApprovalGetPayload<{}>> {
  const nonceHash = await hashApprovalNonce(nonce)
  const scopeHash = await hashApprovalScope(protocolScope(scopeInput, nonceHash))
  return {
    id: "approval_1", sessionId: scopeInput.sessionId, taskId: "task_1", userId: scopeInput.userId, turnId: scopeInput.turnId,
    toolCallId: scopeInput.toolCallId, jobId: scopeInput.jobId, type: scopeInput.action, status: "approved", title: "Submit",
    body: "Review", impact: null, payload: { jobId: scopeInput.jobId }, resourceHash: scopeInput.resourceHash,
    materialHash: scopeInput.materialHash, answersHash: scopeInput.answersHash, scopeHash, nonceHash, revision: scopeInput.revision,
    expiresAt: scopeInput.expiresAt, decidedAt: timeAt(-60), consumedAt: null,
    createdAt: timeAt(-24 * 60),
  }
}

type FreshnessState = {
  hasRequest?: boolean
  hasGoalRevision?: boolean
  sessionPresent?: boolean
  turnPresent?: boolean
  turnStatus?: string
  executionActive?: boolean
}

function mockDb(row: Prisma.AgentApprovalGetPayload<{}>, freshness: FreshnessState = {}) {
  const tx = {
    $queryRaw: vi.fn(async (query?: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join(" ") ?? ""
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return freshness.sessionPresent === false ? [] : [{ id: row.sessionId }]
      if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) {
        return freshness.turnPresent === false ? [] : [{ id: row.turnId, status: freshness.turnStatus ?? "in_progress", revision: scopeInput.revision }]
      }
      if (sql.includes("WITH request")) return [{ hasRequest: freshness.hasRequest !== false, hasGoalRevision: freshness.hasGoalRevision === true }]
      return [{ eventSequence: BigInt(9) }]
    }),
    agentSession: { findFirst: vi.fn(async () => ({ id: row.sessionId })) },
    agentTurn: {
      findFirst: vi.fn(async () => freshness.turnPresent === false ? null : ({ id: row.turnId, status: freshness.turnStatus ?? "in_progress", revision: scopeInput.revision })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findFirst: vi.fn(async (): Promise<{ id: string; content: Prisma.JsonValue } | null> => null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    job: { findFirst: vi.fn(async () => ({ id: row.jobId })) },
    agentApproval: {
      findFirst: vi.fn(async () => row),
      create: vi.fn(async ({ data }: { data: Prisma.AgentApprovalCreateArgs["data"] }) => ({ ...row, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentActionReservation: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: "reservation_1" })) },
    agentExecution: { updateMany: vi.fn(async () => ({ count: freshness.executionActive === false ? 0 : 1 })) },
    applicationTask: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ ...create, id: "review_task_1" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ id: "review_task_1" })),
    },
    applicationTaskEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
    agentEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ ...row, id: "event_1", sequence: BigInt(9) })) },
    agentOutbox: { create: vi.fn(async () => ({ id: "outbox_1" })) },
  }
  const db = {
    ...tx,
    $transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient
  return { db, tx }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(timeAt(0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("Web approval receipt store", () => {
  it("issues a scoped receipt and emits only a safe audit payload", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row)
    const result = await issueApprovalReceipt(db, { approvalId: row.id, scope: scopeInput, title: "Submit", body: "Review", payload: { jobId: row.jobId!, sensitiveAnswer: "secret-answer" }, nonce: "nonce_1" })

    expect(result.nonce).toBe("nonce_1")
    expect(tx.agentApproval.create).toHaveBeenCalledWith({ data: expect.objectContaining({ scopeHash: row.scopeHash, nonceHash: row.nonceHash, turnId: row.turnId, jobId: row.jobId }) })
    expect(tx.agentEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "approval.requested", payload: { approvalId: row.id, action: row.type, scopeHash: row.scopeHash, revision: row.revision } }) })
    const auditCall = (tx.agentEvent.create.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as { data?: { payload?: unknown } } | undefined
    expect(JSON.stringify(auditCall?.data?.payload)).not.toContain("secret-answer")
  })

  it("rejects a Stop-first Gate receipt before preparing its task or writing approval state", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row, { turnStatus: "interrupted" })
    const prepareInTransaction = vi.fn(async () => ({ scope: scopeInput, taskId: "review_task_1", payload: { applicationTaskId: "review_task_1" } }))

    await expect(issueApprovalReceipt(db, {
      scope: scopeInput,
      title: "Review application",
      body: "Review materials",
      payload: { jobId: scopeInput.jobId },
      projectWait: false,
      executionAttempt: { id: "execution_1", attemptCount: 4 },
      prepareInTransaction,
    })).rejects.toMatchObject({ code: "approval_scope_mismatch", message: "Approval turn is no longer active" })

    const lockQueries = tx.$queryRaw.mock.calls.map(([query]) => query?.strings?.join(" ") ?? "")
    expect(lockQueries[0]).toContain('FROM "agent_sessions"')
    expect(lockQueries[1]).toContain('FROM "agent_turns"')
    expect(prepareInTransaction).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.applicationTask.upsert).not.toHaveBeenCalled()
    expect(tx.agentApproval.create).not.toHaveBeenCalled()
    expect(tx.agentItem.create).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
  })

  it("commits the Gate task and an unprojected receipt together when receipt issuance wins Stop", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row)
    const preparedScope = { ...scopeInput, action: "review_application" as const, materialHash: "d".repeat(64) }
    const prepareInTransaction = vi.fn(async (transaction: Prisma.TransactionClient) => {
      const identity = { userId: scopeInput.userId, jobId: scopeInput.jobId }
      await transaction.applicationTask.upsert({
        where: { userId_jobId: identity },
        create: { ...identity, sessionId: scopeInput.sessionId, status: "waiting_for_user", checkpoint: "materials_ready" },
        update: {},
      })
      return {
        scope: preparedScope,
        taskId: "review_task_1",
        payload: { applicationTaskId: "review_task_1", jobId: scopeInput.jobId },
      }
    })

    const result = await issueApprovalReceipt(db, {
      scope: { ...scopeInput, action: "review_application" },
      title: "Review application",
      body: "Review materials",
      payload: { jobId: scopeInput.jobId },
      projectWait: false,
      executionAttempt: { id: "execution_1", attemptCount: 4 },
      prepareInTransaction,
    })

    expect(result.approval).toMatchObject({ status: "pending", payload: { applicationTaskId: "review_task_1" } })
    expect(tx.agentExecution.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.applicationTask.upsert.mock.invocationCallOrder[0])
    expect(tx.applicationTask.upsert.mock.invocationCallOrder[0]).toBeLessThan(tx.agentApproval.create.mock.invocationCallOrder[0])
    expect(tx.agentApproval.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "pending", taskId: "review_task_1", turnId: scopeInput.turnId }) })
    expect(tx.agentItem.create).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "approval.requested", taskId: "review_task_1" }) })
  })

  it("does not prepare Gate task state when the exact execution attempt was fenced", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row, { executionActive: false })
    const prepareInTransaction = vi.fn(async () => ({ scope: scopeInput, taskId: "review_task_1", payload: { applicationTaskId: "review_task_1" } }))

    await expect(issueApprovalReceipt(db, {
      scope: scopeInput,
      title: "Review application",
      body: "Review materials",
      payload: { jobId: scopeInput.jobId },
      projectWait: false,
      executionAttempt: { id: "execution_1", attemptCount: 4 },
      prepareInTransaction,
    })).rejects.toMatchObject({ name: "AgentExecutionCancelledError" })

    expect(prepareInTransaction).not.toHaveBeenCalled()
    expect(tx.applicationTask.upsert).not.toHaveBeenCalled()
    expect(tx.agentApproval.create).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
  })

  it("rejects a cross-job validation attempt", async () => {
    const row = await approvalRow()
    const { db } = mockDb(row)
    await expect(validateApproval(db, row.id, { ...scopeInput, jobId: "job_2", nonce: "nonce_1" }, timeAt(1))).rejects.toMatchObject({ code: "approval_scope_mismatch" })
  })

  it("rejects stale revisions and expired receipts", async () => {
    const row = await approvalRow()
    const { db } = mockDb(row)
    await expect(validateApproval(db, row.id, { ...scopeInput, revision: 4, nonce: "nonce_1" }, timeAt(1))).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    await expect(validateApproval(db, row.id, { ...scopeInput, nonce: "nonce_1" }, timeAt(60))).rejects.toMatchObject({ code: "approval_expired" })
  })

  it("validates the nonce and scope while the receipt is still pending", async () => {
    const row = { ...(await approvalRow()), status: "pending", decidedAt: null }
    const { db } = mockDb(row)

    await expect(validatePendingApprovalReceipt(db, row.id, { ...scopeInput, nonce: "nonce_1" }, timeAt(1))).resolves.toMatchObject({ id: row.id, status: "pending" })
    await expect(validatePendingApprovalReceipt(db, row.id, { ...scopeInput, nonce: "wrong_nonce" }, timeAt(1))).rejects.toMatchObject({ code: "approval_nonce_mismatch" })
  })

  it("consumes exactly one approved receipt with its external reservation in one transaction", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row)
    const result = await consumeApprovalAndReserve(db, row.id, { ...scopeInput, nonce: "nonce_1" }, { idempotencyKey: "submit:task_1" }, timeAt(1))

    expect(result).toMatchObject({ approvalId: row.id, reservationId: expect.any(String) })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(tx.agentApproval.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ status: "approved", scopeHash: row.scopeHash, nonceHash: row.nonceHash }), data: expect.objectContaining({ status: "consumed" }) })
    expect(tx.agentActionReservation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ approvalId: row.id, idempotencyKey: "submit:task_1", status: "reserved" }) })
    expect(tx.agentEvent.create).toHaveBeenCalledTimes(2)
  })

  it("does not consume an approval after its Turn has been interrupted", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row, { turnStatus: "interrupted" })

    await expect(consumeApprovalAndReserve(db, row.id, { ...scopeInput, nonce: "nonce_1" }, { idempotencyKey: "submit:task_1" }, timeAt(1)))
      .rejects.toMatchObject({ code: "approval_scope_mismatch", message: "Approval turn is no longer active" })
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.agentTurn.findFirst.mock.invocationCallOrder[0])
    expect(tx.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(tx.agentActionReservation.create).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
  })

  it("rejects consumption after a durable goal revision event", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row, { hasGoalRevision: true })

    await expect(consumeApprovalAndReserve(db, row.id, { ...scopeInput, nonce: "nonce_1" }, { idempotencyKey: "submit:task_1" }, timeAt(1))).rejects.toMatchObject({ code: "approval_revision_mismatch" })
    expect(tx.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(tx.agentActionReservation.create).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
  })

  it("fails closed when consumption has no durable approval request event", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row, { hasRequest: false })

    await expect(consumeApproval(db, row.id, { ...scopeInput, nonce: "nonce_1" }, timeAt(1))).rejects.toMatchObject({ code: "approval_integrity_error" })
    expect(tx.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
  })

  it("preserves consumed receipt replay semantics without a freshness read", async () => {
    const row = { ...(await approvalRow()), status: "consumed", consumedAt: timeAt(1) }
    const { db, tx } = mockDb(row, { hasRequest: false, hasGoalRevision: true })

    await expect(consumeApproval(db, row.id, { ...scopeInput, nonce: "nonce_1" }, timeAt(2))).rejects.toMatchObject({ code: "approval_already_consumed" })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.agentApproval.updateMany).not.toHaveBeenCalled()
  })

  it("maps a conditional update race to an already-consumed error", async () => {
    const row = await approvalRow()
    const { db, tx } = mockDb(row)
    tx.agentApproval.updateMany.mockResolvedValue({ count: 0 })
    await expect(consumeApprovalAndReserve(db, row.id, { ...scopeInput, nonce: "nonce_1" }, { idempotencyKey: "submit:task_1" })).rejects.toBeInstanceOf(ApprovalStoreError)
    await expect(consumeApprovalAndReserve(db, row.id, { ...scopeInput, nonce: "nonce_1" }, { idempotencyKey: "submit:task_2" })).rejects.toMatchObject({ code: "approval_already_consumed" })
  })

  it("rotates a pending nonce and keeps the broker item scope synchronized", async () => {
    const row = { ...(await approvalRow()), status: "pending" }
    const { db, tx } = mockDb(row)
    tx.agentItem.findFirst.mockResolvedValue({ id: "agent-wait:approval:approval_1", content: { approvalId: row.id, scopeHash: row.scopeHash } })

    const result = await reissueApprovalNonce(db, { approvalId: row.id, sessionId: row.sessionId, userId: row.userId })

    expect(result).toMatchObject({ approvalId: row.id, receiptNonce: expect.any(String), scopeHash: expect.not.stringMatching(row.scopeHash!) })
    expect(tx.agentApproval.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: row.id, status: "pending", scopeHash: row.scopeHash, nonceHash: row.nonceHash }),
      data: { scopeHash: result.scopeHash, nonceHash: expect.any(String) },
    })
    expect(tx.agentItem.update).toHaveBeenCalledWith({
      where: { id: "agent-wait:approval:approval_1" },
      data: { content: { approvalId: row.id, scopeHash: result.scopeHash } },
    })
    expect(tx.agentEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "approval.receipt_rotated" }) })
  })

  it("serializes Gate receipt issuance and Stop in both Session-lock orders", async () => {
    function deferred() {
      let resolve!: () => void
      const promise = new Promise<void>(done => { resolve = done })
      return { promise, resolve }
    }
    function lockedHarness(pauseReceiptCommit = false) {
      const state = {
        turnStatus: "in_progress",
        tasks: [] as Array<Record<string, unknown>>,
        approvals: [] as Array<Record<string, unknown>>,
        events: [] as Array<Record<string, unknown>>,
        outbox: [] as Array<Record<string, unknown>>,
      }
      let tail = Promise.resolve()
      const gateQueued = deferred()
      const receiptWritesDone = deferred()
      const releaseReceiptCommit = deferred()
      const stopEntered = deferred()
      const releaseStop = deferred()
      const stopQueued = deferred()
      const withSessionLock = <T,>(work: () => Promise<T>) => {
        const previous = tail
        let release!: () => void
        tail = new Promise<void>(resolve => { release = resolve })
        return previous.then(async () => {
          try { return await work() } finally { release() }
        })
      }
      const tx = {
        $queryRaw: vi.fn(async (query: unknown) => {
          const sql = (query as { strings?: readonly string[] }).strings?.join(" ") ?? ""
          if (sql.includes('FROM "agent_sessions"')) return [{ id: "session_1" }]
          if (sql.includes('FROM "agent_turns"')) return [{ id: "turn_1", status: state.turnStatus, revision: 3 }]
          return [{ eventSequence: BigInt(7) }]
        }),
        agentExecution: { updateMany: vi.fn(async () => ({ count: 1 })) },
        job: { findFirst: vi.fn(async () => ({ id: "job_1" })) },
        applicationTask: {
          upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
            const task = { ...create, id: "task_gate" }
            state.tasks.push(task)
            return task
          }),
          findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
            const ids = (where.id as { in: string[] }).in
            const alternatives = where.OR as Array<{ status: string; checkpoint: string | { in: string[] } }>
            return state.tasks.filter(task => ids.includes(String(task.id)) && task.userId === where.userId && task.sessionId === where.sessionId
              && alternatives.some(clause => task.status === clause.status && (typeof clause.checkpoint === "string"
                ? task.checkpoint === clause.checkpoint : clause.checkpoint.in.includes(String(task.checkpoint)))))
              .map(task => ({ id: String(task.id) }))
          }),
          updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            const ids = (where.id as { in: string[] }).in
            const alternatives = where.OR as Array<{ status: string; checkpoint: string | { in: string[] } }>
            let count = 0
            for (const task of state.tasks) {
              const matches = ids.includes(String(task.id)) && task.userId === where.userId && task.sessionId === where.sessionId
                && alternatives.some(clause => task.status === clause.status && (typeof clause.checkpoint === "string"
                  ? task.checkpoint === clause.checkpoint : clause.checkpoint.in.includes(String(task.checkpoint))))
              if (matches) { Object.assign(task, data); count += 1 }
            }
            return { count }
          }),
        },
        agentApproval: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const row = { ...data, createdAt: new Date(), decidedAt: null, consumedAt: null }
            state.approvals.push(row)
            return row
          }),
          findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.approvals.filter(row => {
            if (where.sessionId && row.sessionId !== where.sessionId) return false
            if (where.userId && row.userId !== where.userId) return false
            if (where.turnId && row.turnId !== where.turnId) return false
            const type = where.type as { in?: string[]; notIn?: string[] } | string | undefined
            if (typeof type === "string" && row.type !== type) return false
            if (type && typeof type === "object" && type.in && !type.in.includes(String(row.type))) return false
            if (type && typeof type === "object" && type.notIn?.includes(String(row.type))) return false
            const status = where.status as { in?: string[] } | string | undefined
            if (typeof status === "string" && row.status !== status) return false
            if (status && typeof status === "object" && status.in && !status.in.includes(String(row.status))) return false
            return true
          })),
          updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0
            for (const row of state.approvals) {
              const ids = where.id as { in?: string[] } | string | undefined
              const idMatches = !ids || (typeof ids === "string" ? row.id === ids : ids.in?.includes(String(row.id)))
              const statuses = where.status as { in?: string[] } | string | undefined
              const statusMatches = !statuses || (typeof statuses === "string" ? row.status === statuses : statuses.in?.includes(String(row.status)))
              if (!idMatches || !statusMatches || (where.userId && row.userId !== where.userId)
                || (where.sessionId && row.sessionId !== where.sessionId) || (where.turnId && row.turnId !== where.turnId)
                || (typeof where.type === "string" && row.type !== where.type)) continue
              Object.assign(row, data)
              count += 1
            }
            return { count }
          }),
        },
        agentItem: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
        agentRunQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        agentEvent: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const event = { ...data, sequence: BigInt(state.events.length + 1) }
            state.events.push(event)
            return event
          }),
        },
        agentOutbox: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { state.outbox.push(data); return data }) },
      }
      const db = {
        ...tx,
        $transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => {
          gateQueued.resolve()
          return withSessionLock(async () => {
            const result = await work(tx)
            if (pauseReceiptCommit) {
              receiptWritesDone.resolve()
              await releaseReceiptCommit.promise
            }
            return result
          })
        }),
      } as unknown as PrismaClient
      const stop = (hold = false) => {
        stopQueued.resolve()
        return withSessionLock(async () => {
          state.turnStatus = "interrupted"
          stopEntered.resolve()
          if (hold) await releaseStop.promise
          await cancelPendingWaitsInTransaction(tx as unknown as Prisma.TransactionClient, {
            sessionId: "session_1", userId: "user_1", turnId: "turn_1", clientMessageId: "stop_gate_receipt",
          })
        })
      }
      return { db, tx, state, gateQueued, receiptWritesDone, releaseReceiptCommit, stopEntered, releaseStop, stopQueued, stop }
    }

    const stopFirst = lockedHarness()
    const stopFirstPromise = stopFirst.stop(true)
    await stopFirst.stopEntered.promise
    const blockedReceipt = issueApprovalReceipt(stopFirst.db, {
      approvalId: "receipt_stop_first", scope: { ...scopeInput, action: "review_application" },
      title: "Review", body: "Review materials", payload: { jobId: "job_1" }, projectWait: false,
      executionAttempt: { id: "execution_1", attemptCount: 4 },
      prepareInTransaction: async transaction => {
        await transaction.applicationTask.upsert({
          where: { userId_jobId: { userId: "user_1", jobId: "job_1" } },
          create: { userId: "user_1", sessionId: "session_1", jobId: "job_1", status: "waiting_for_user", checkpoint: "materials_ready" },
          update: {},
        })
        return { scope: { ...scopeInput, action: "review_application" }, taskId: "task_gate", payload: { applicationTaskId: "task_gate" } }
      },
    })
    await stopFirst.gateQueued.promise
    stopFirst.releaseStop.resolve()
    await stopFirstPromise
    await expect(blockedReceipt).rejects.toMatchObject({ message: "Approval turn is no longer active" })
    expect(stopFirst.state.tasks).toHaveLength(0)
    expect(stopFirst.state.approvals).toHaveLength(0)

    const receiptFirst = lockedHarness(true)
    const winningReceipt = issueApprovalReceipt(receiptFirst.db, {
      approvalId: "receipt_gate_first", scope: { ...scopeInput, action: "review_application" },
      title: "Review", body: "Review materials", payload: { jobId: "job_1" }, projectWait: false,
      executionAttempt: { id: "execution_1", attemptCount: 4 },
      prepareInTransaction: async transaction => {
        await transaction.applicationTask.upsert({
          where: { userId_jobId: { userId: "user_1", jobId: "job_1" } },
          create: { userId: "user_1", sessionId: "session_1", jobId: "job_1", status: "waiting_for_user", checkpoint: "materials_ready" },
          update: {},
        })
        return { scope: { ...scopeInput, action: "review_application" }, taskId: "task_gate", payload: { applicationTaskId: "task_gate" } }
      },
    })
    await receiptFirst.receiptWritesDone.promise
    const stopAfterReceipt = receiptFirst.stop()
    await receiptFirst.stopQueued.promise
    receiptFirst.releaseReceiptCommit.resolve()
    await winningReceipt
    await stopAfterReceipt

    expect(receiptFirst.state.turnStatus).toBe("interrupted")
    expect(receiptFirst.state.tasks).toMatchObject([expect.objectContaining({ id: "task_gate", status: "cancelled", checkpoint: "turn_stopped_before_submit" })])
    expect(receiptFirst.state.approvals).toMatchObject([expect.objectContaining({ id: "receipt_gate_first", status: "rejected" })])
    expect(receiptFirst.state.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "agent.session.event", payload: expect.objectContaining({ type: "approval.resolved", correlationId: "receipt_gate_first" }) }),
    ]))
  })
})
