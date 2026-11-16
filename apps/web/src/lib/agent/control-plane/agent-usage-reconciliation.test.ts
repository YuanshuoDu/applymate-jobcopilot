import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"

import { reconcileAbandonedAgentUsage } from "./agent-usage-reconciliation"
import type { RootUsageQuery, RootUsageReservationRef } from "./agent-root-usage-reservations"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const turnReservation: RootUsageReservationRef = {
  id: "usage-1", ...scope, taskId: "root-1", stepId: "step-1", executionOwnerKind: "turn", executionOwnerId: "worker-1",
  executionOwnerVersion: 4, outputReservationRequired: true, attempt: 1, attemptId: "attempt-1", provider: "minimax",
  model: "MiniMax-M3", reservedOutputTokens: 24, status: "reserved", actualOutputTokens: null, outcomeStatus: null,
  errorCode: null,
}

type FixtureOptions = Partial<{
  reservation: RootUsageReservationRef
  protocolVersion: number
  eventStatus: string
  providerStartedAt: Date | null
  turnOwnerId: string
  turnLeaseVersion: number
  taskOwnerId: string
  taskAttemptCount: number
  refundReturnsRow: boolean
}>

function fixture(options: FixtureOptions = {}) {
  let row = { ...(options.reservation ?? turnReservation) }
  let eventStatus = options.eventStatus ?? "reserved"
  const calls: string[] = []
  const tx: RootUsageQuery = {
    $queryRaw: async <T>(query: Prisma.Sql): Promise<T> => {
      const text = query.text
      calls.push(text)
      if (text.includes('FROM "agent_root_usage_reservations" AS r')) {
        return (row.status === "reserved" && eventStatus === "reserved" && options.protocolVersion !== 0 && options.providerStartedAt == null
          ? [row] : []) as T
      }
      if (text.includes('FROM "agent_sessions"')) return [{ id: scope.sessionId, status: "running" }] as T
      if (text.includes('FROM "agent_turns"')) return [{
        id: scope.turnId, rootTaskId: scope.rootTaskId, status: "in_progress",
        leaseOwnerId: options.turnOwnerId ?? "worker-1", leaseVersion: options.turnLeaseVersion ?? 4, leaseValid: true,
      }] as T
      if (text.includes('FROM "sub_agent_tasks"') && text.includes('"budgetSnapshot"')) return [{
        id: scope.rootTaskId, budgetSnapshot: {}, outputTokenReservationVersion: 1, status: "running",
        interruptRequestedAt: null, leaseOwner: row.executionOwnerKind === "turn" ? row.executionOwnerId : "root-worker", leaseValid: true,
      }] as T
      if (text.includes('FROM "sub_agent_tasks"')) return [{
        id: row.taskId, rootTaskId: row.rootTaskId, turnId: row.turnId, status: "running", interruptRequestedAt: null,
        attemptCount: options.taskAttemptCount ?? row.executionOwnerVersion,
        leaseOwner: options.taskOwnerId ?? row.executionOwnerId, leaseValid: true,
      }] as T
      if (text.includes('FROM "agent_steps"')) return [{
        id: row.stepId, taskId: row.taskId === row.rootTaskId ? null : row.taskId, attempt: row.attempt, status: "streaming",
      }] as T
      if (text.includes('FROM "agent_root_usage_reservations"') && text.includes("FOR UPDATE")) return [row] as T
      if (text.includes("FROM ai_usage_events") && text.includes("FOR UPDATE")) return [{
        status: eventStatus, provider: row.provider, model: row.model, outputReservationRequired: row.outputReservationRequired,
        startProtocolVersion: options.protocolVersion ?? 1, providerStartedAt: options.providerStartedAt ?? null,
        errorCode: "credit_reserved_2026-11",
      }] as T
      if (text.includes('UPDATE "agent_root_usage_reservations" SET "status" = \'released\'')) {
        row = { ...row, status: "released" }
        return [] as T
      }
      if (text.includes("UPDATE ai_usage_events SET status = 'released'")) {
        eventStatus = "released"
        return [{ id: row.id }] as T
      }
      if (text.includes("UPDATE ai_budgets")) return (options.refundReturnsRow === false ? [] : [{ userId: row.userId }]) as T
      return [] as T
    },
  }
  return { tx, calls, get row() { return row }, get eventStatus() { return eventStatus } }
}

describe("abandoned agent usage reconciliation", () => {
  it("keeps a mandatory-start reservation while its recorded owner fence is still live", async () => {
    const state = fixture()
    await expect(reconcileAbandonedAgentUsage(state.tx, scope)).resolves.toBe(0)
    expect(state.row.status).toBe("reserved")
    expect(state.calls.some(text => text.includes("UPDATE ai_budgets"))).toBe(false)
  })

  it("releases an expired Turn reservation and refunds its finite credit in the same transaction", async () => {
    const state = fixture({ turnOwnerId: "reclaimed-worker", turnLeaseVersion: 5 })
    await expect(reconcileAbandonedAgentUsage(state.tx, scope)).resolves.toBe(1)
    expect(state.row.status).toBe("released")
    expect(state.eventStatus).toBe("released")
    expect(state.calls.some(text => text.includes("UPDATE ai_budgets") && text.includes("RETURNING user_id"))).toBe(true)
  })

  it("releases a reclaimed child Task reservation only after its owner fence fails", async () => {
    const child: RootUsageReservationRef = {
      ...turnReservation, taskId: "child-1", executionOwnerKind: "task", executionOwnerId: "child-old",
      executionOwnerVersion: 2, attempt: 2,
    }
    const state = fixture({ reservation: child, taskOwnerId: "child-new", taskAttemptCount: 3 })
    await expect(reconcileAbandonedAgentUsage(state.tx, scope)).resolves.toBe(1)
    expect(state.row.status).toBe("released")
    expect(state.eventStatus).toBe("released")
  })

  it.each([
    ["legacy protocol", { protocolVersion: 0 }],
    ["provider already started", { providerStartedAt: new Date("2026-11-13T10:00:00.000Z") }],
    ["event already settled", { eventStatus: "success" }],
  ] as const)("does not select a %s hold for recovery", async (_label, options) => {
    const state = fixture(options)
    await expect(reconcileAbandonedAgentUsage(state.tx, scope)).resolves.toBe(0)
    expect(state.row.status).toBe("reserved")
    expect(state.calls.some(text => text.includes("UPDATE ai_budgets"))).toBe(false)
  })

  it("fails closed when a finite credit reservation cannot be refunded", async () => {
    const state = fixture({ turnOwnerId: "reclaimed-worker", turnLeaseVersion: 5, refundReturnsRow: false })
    await expect(reconcileAbandonedAgentUsage(state.tx, scope)).rejects.toMatchObject({ code: "usage_credit_refund_unavailable", status: 503 })
  })
})
