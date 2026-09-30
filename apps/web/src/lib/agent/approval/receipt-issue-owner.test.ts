import { describe, expect, it, vi } from "vitest"

import type { Prisma } from "@prisma/client"

import { AgentExecutionCancelledError } from "../execution-control"
import { ApprovalStoreError, type ApprovalScopeInput } from "./types"
import { prepareReceiptIssueInTransaction } from "./receipt-issue-owner"

const scope: ApprovalScopeInput = {
  userId: "user_1",
  sessionId: "session_1",
  turnId: "turn_1",
  jobId: "job_1",
  toolCallId: "call_1",
  action: "review_application",
  resourceHash: "a".repeat(64),
  materialHash: "b".repeat(64),
  answersHash: "c".repeat(64),
  revision: 3,
  expiresAt: new Date(Date.now() + 60_000),
}

function makeTransaction(options: { turnStatus?: string; revision?: number; executionActive?: boolean } = {}) {
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = (query as { strings?: readonly string[] }).strings?.join(" ") ?? ""
      if (sql.includes('FROM "agent_sessions"')) return [{ id: scope.sessionId }]
      return [{ id: scope.turnId, status: options.turnStatus ?? "in_progress", revision: options.revision ?? scope.revision }]
    }),
    agentExecution: {
      updateMany: vi.fn(async () => ({ count: options.executionActive === false ? 0 : 1 })),
    },
  }
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx }
}

describe("approval receipt issue owner fence", () => {
  it("locks the exact session and Turn before refreshing the execution attempt and preparing", async () => {
    const { tx, raw } = makeTransaction()
    const prepareInTransaction = vi.fn(async () => ({ scope, taskId: "task_1" }))

    const result = await prepareReceiptIssueInTransaction(tx, {
      scope,
      executionAttempt: { id: "execution_1", attemptCount: 4 },
      prepareInTransaction,
    })

    const [sessionQuery, turnQuery] = raw.$queryRaw.mock.calls.map(([query]) => (query as { strings?: readonly string[] }).strings?.join(" ") ?? "")
    expect(sessionQuery).toContain('FROM "agent_sessions"')
    expect(turnQuery).toContain('FROM "agent_turns"')
    expect(raw.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(raw.$queryRaw.mock.invocationCallOrder[1]!)
    expect(raw.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(raw.agentExecution.updateMany.mock.invocationCallOrder[0]!)
    expect(raw.agentExecution.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prepareInTransaction.mock.invocationCallOrder[0]!)
    expect(result).toMatchObject({ receiptScope: scope, prepared: { taskId: "task_1" } })
  })

  it("rejects an interrupted Turn before execution refresh or task preparation", async () => {
    const { tx, raw } = makeTransaction({ turnStatus: "interrupted" })
    const prepareInTransaction = vi.fn()

    await expect(prepareReceiptIssueInTransaction(tx, { scope, executionAttempt: { id: "execution_1", attemptCount: 4 }, prepareInTransaction }))
      .rejects.toMatchObject({ code: "approval_scope_mismatch" })

    expect(raw.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(prepareInTransaction).not.toHaveBeenCalled()
  })

  it("rejects a changed execution attempt before preparing receipt state", async () => {
    const { tx, raw } = makeTransaction({ executionActive: false })
    const prepareInTransaction = vi.fn()

    await expect(prepareReceiptIssueInTransaction(tx, { scope, executionAttempt: { id: "execution_1", attemptCount: 4 }, prepareInTransaction }))
      .rejects.toBeInstanceOf(AgentExecutionCancelledError)

    expect(prepareInTransaction).not.toHaveBeenCalled()
  })

  it("rejects receipt preparation that changes its fenced Turn identity", async () => {
    const { tx } = makeTransaction()
    const prepareInTransaction = vi.fn(async () => ({ scope: { ...scope, turnId: "turn_2" } }))

    await expect(prepareReceiptIssueInTransaction(tx, { scope, prepareInTransaction }))
      .rejects.toBeInstanceOf(ApprovalStoreError)
  })
})
