import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"

import {
  lockRootUsageAdmissionScope,
  releaseRootOutputReservation,
  reserveRootOutputTokens,
  RootUsageReservationError,
  settleRootOutputReservation,
  startRootOutputReservation,
  type RootUsageQuery,
  type RootUsageReservationRef,
  type RootUsageScope,
} from "./agent-root-usage-reservations"

const scope: RootUsageScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", rootTaskId: "root-1", taskId: "child-1",
  attempt: 2, budgetSnapshot: { limits: { maxOutputTokens: 100 } }, outputTokenReservationVersion: 1,
  executionOwnerKind: "task", executionOwnerId: "child-worker", executionOwnerVersion: 2,
}
const reservation: RootUsageReservationRef = {
  id: "reservation-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId: "child-1",
  stepId: "step-1", executionOwnerKind: "task", executionOwnerId: "child-worker", executionOwnerVersion: 2,
  outputReservationRequired: true, attempt: 2, attemptId: "attempt-1", provider: "minimax", model: "MiniMax-M3", reservedOutputTokens: 32,
  status: "reserved", actualOutputTokens: null, outcomeStatus: null, errorCode: null,
}

function query(resolver: (text: string, values: readonly unknown[]) => unknown): RootUsageQuery {
  return { $queryRaw: async <T>(raw: Prisma.Sql) => resolver(raw.text, raw.values) as T }
}

function lifecycle(initial: RootUsageReservationRef = reservation) {
  let row = { ...initial }
  const tx = query((text, values) => {
    if (text.includes('FROM "agent_root_usage_reservations"')) return [{ ...row }]
    if (text.includes("SET \"status\" = 'started'")) {
      if (row.status !== "reserved") return []
      row = { ...row, status: "started" }
      return [{ reservedOutputTokens: row.reservedOutputTokens }]
    }
    if (text.includes("SET \"status\" = 'released'")) {
      row = { ...row, status: "released" }
      return []
    }
    if (text.includes("SET \"outcomeStatus\"")) {
      row = { ...row, outcomeStatus: String(values[0]), errorCode: values[1] as string | null }
      return []
    }
    if (text.includes("SET \"status\" = 'settled'")) {
      row = { ...row, status: "settled", actualOutputTokens: Number(values[0]), outcomeStatus: String(values[1]), errorCode: values[2] as string | null }
      return []
    }
    return []
  })
  return { tx, get row() { return row } }
}

describe("Root output token reservations", () => {
  it("clamps a sibling request to the remaining Root allowance and counts holds plus settled actuals", async () => {
    const statements: Prisma.Sql[] = []
    const tx = query((text, values) => {
      if (text.includes("SUM(CASE WHEN")) return [{ used: 72 }]
      statements.push({ text, values } as Prisma.Sql)
      return []
    })

    await expect(reserveRootOutputTokens(tx, scope, {
      operationId: "op-1", attemptId: "attempt-1", provider: "minimax", model: "MiniMax-M3", requestedOutputTokens: 80, startProtocolVersion: 1,
    })).resolves.toEqual({ required: true, maxOutputTokens: 28 })
    expect(statements[0]?.text).toContain("INSERT INTO \"agent_root_usage_reservations\"")
    expect(statements[0]?.values).toContain(28)
  })

  it("fails closed for unmarked Roots, unknown ceilings, unsupported providers, and unsupported budget dimensions", async () => {
    const empty = query(() => [])
    await expect(reserveRootOutputTokens(empty, { ...scope, outputTokenReservationVersion: null }, {
      operationId: "op", attemptId: "a", provider: "minimax", model: "MiniMax-M3", requestedOutputTokens: 20, startProtocolVersion: 1,
    })).rejects.toMatchObject({ code: "root_usage_unmarked" })
    await expect(reserveRootOutputTokens(empty, scope, {
      operationId: "op", attemptId: "a", provider: "minimax", model: "MiniMax-M3", startProtocolVersion: 1,
    })).rejects.toMatchObject({ code: "output_reservation_unknown" })
    await expect(reserveRootOutputTokens(empty, scope, {
      operationId: "op", attemptId: "a", provider: "openai", model: "gpt-test", requestedOutputTokens: 20, startProtocolVersion: 1,
    })).rejects.toMatchObject({ code: "output_route_unsupported" })
    await expect(reserveRootOutputTokens(empty, { ...scope, budgetSnapshot: { limits: { maxOutputTokens: 100, maxCostUsd: 1 } } }, {
      operationId: "op", attemptId: "a", provider: "minimax", model: "MiniMax-M3", requestedOutputTokens: 20, startProtocolVersion: 1,
    })).rejects.toMatchObject({ code: "root_usage_budget_unsupported" })
  })

  it("leaves unmarked Roots without strict output limits on the legacy accounting path", async () => {
    await expect(reserveRootOutputTokens(query(() => []), {
      ...scope, budgetSnapshot: {}, outputTokenReservationVersion: null,
    }, { operationId: "op", attemptId: "a", provider: "minimax", model: "MiniMax-M3", startProtocolVersion: 0 }))
      .resolves.toEqual({ required: false, maxOutputTokens: null })
  })

  it("persists a zero-token marker for the new non-strict mandatory-start protocol", async () => {
    const statements: Prisma.Sql[] = []
    const tx = query((text, values) => { statements.push({ text, values } as Prisma.Sql); return [] })
    await expect(reserveRootOutputTokens(tx, { ...scope, budgetSnapshot: {}, outputTokenReservationVersion: null }, {
      operationId: "op-v1", attemptId: "a", provider: "minimax", model: "MiniMax-M3", startProtocolVersion: 1,
    })).resolves.toEqual({ required: false, maxOutputTokens: null })
    expect(statements[0]?.text).toContain('INSERT INTO "agent_root_usage_reservations"')
    expect(statements[0]?.values).toEqual(expect.arrayContaining([false, 0, "task", "child-worker", 2]))
  })

  it("locks Session, Turn, Root, owner task, and Step in order before admitting a child attempt", async () => {
    const lockOrder: string[] = []
    const tx = query(text => {
      if (text.includes('FROM "agent_sessions"')) { lockOrder.push("session"); return [{ id: "session-1", status: "running" }] }
      if (text.includes('FROM "agent_turns"')) { lockOrder.push("turn"); return [{ id: "turn-1", rootTaskId: "root-1", status: "in_progress", leaseValid: true }] }
      if (text.includes('FROM "sub_agent_tasks"') && text.includes('"budgetSnapshot"')) {
        lockOrder.push("root")
        return [{ id: "root-1", budgetSnapshot: scope.budgetSnapshot, outputTokenReservationVersion: 1, status: "running", interruptRequestedAt: null, leaseOwner: "root-worker", leaseValid: true }]
      }
      if (text.includes('FROM "sub_agent_tasks"')) { lockOrder.push("task"); return [{ id: "child-1", rootTaskId: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: null, attemptCount: 2, leaseOwner: "child-worker", leaseValid: true }] }
      if (text.includes('FROM "agent_steps"')) { lockOrder.push("step"); return [{ id: "step-1", taskId: "child-1", attempt: 2, status: "streaming" }] }
      return []
    })

    await expect(lockRootUsageAdmissionScope(tx, scope, {
      kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "child-worker", attemptCount: 2,
    })).resolves.toMatchObject({ attempt: 2, outputTokenReservationVersion: 1 })
    expect(lockOrder).toEqual(["session", "turn", "root", "task", "step"])
  })

  it("makes the start claim one-shot and never releases a started attempt", async () => {
    const fixture = lifecycle()
    await expect(startRootOutputReservation(fixture.tx, reservation)).resolves.toBe(32)
    await expect(startRootOutputReservation(fixture.tx, reservation)).rejects.toMatchObject({ code: "usage_start_replayed" })
    await expect(releaseRootOutputReservation(fixture.tx, reservation)).rejects.toMatchObject({ code: "usage_attempt_started" })
  })

  it("retains an unknown usage hold and allows only identical reconciliation facts", async () => {
    const fixture = lifecycle({ ...reservation, status: "started" })
    const unknown = { status: "error" as const, outputTokens: null, errorCode: "provider_error" }
    await settleRootOutputReservation(fixture.tx, reservation, unknown)
    await settleRootOutputReservation(fixture.tx, reservation, unknown)
    expect(fixture.row).toMatchObject({ status: "started", actualOutputTokens: null, outcomeStatus: "error", errorCode: "provider_error" })
    await expect(settleRootOutputReservation(fixture.tx, reservation, { ...unknown, errorCode: "different_error" }))
      .rejects.toBeInstanceOf(RootUsageReservationError)
  })

  it("settles known output idempotently and rejects conflicting usage", async () => {
    const fixture = lifecycle({ ...reservation, status: "started" })
    const outcome = { status: "success" as const, outputTokens: 9, errorCode: null }
    await settleRootOutputReservation(fixture.tx, reservation, outcome)
    await settleRootOutputReservation(fixture.tx, reservation, outcome)
    expect(fixture.row).toMatchObject({ status: "settled", actualOutputTokens: 9, outcomeStatus: "success" })
    await expect(settleRootOutputReservation(fixture.tx, reservation, { ...outcome, outputTokens: 10 }))
      .rejects.toMatchObject({ code: "usage_settlement_conflict" })
  })

  it("releases only confirmed pre-start holds and treats a replay as idempotent", async () => {
    const fixture = lifecycle()
    await releaseRootOutputReservation(fixture.tx, reservation)
    await releaseRootOutputReservation(fixture.tx, reservation)
    expect(fixture.row.status).toBe("released")
  })
})
