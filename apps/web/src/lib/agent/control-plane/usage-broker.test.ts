import { beforeEach, describe, expect, it, vi } from "vitest"

const mocked = vi.hoisted(() => ({ getEffectiveEntitlements: vi.fn() }))
vi.mock("@/lib/entitlements", () => ({ getEffectiveEntitlements: mocked.getEffectiveEntitlements }))

import { admitAiUsage, settleAiUsage, type UsageAdmissionInput, type UsageBrokerDatabase, type UsageBrokerQuery } from "./usage-broker"

const input: UsageAdmissionInput = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", leaseOwnerId: "worker-1", leaseVersion: 4,
  featureKey: "agent", provider: "minimax", model: "MiniMax-M3", attemptId: "provider-attempt-1", credentialSource: "user",
}

function database(query: (...args: unknown[]) => Promise<unknown>) {
  const tx = { $queryRaw: vi.fn(query) }
  const typedTx = tx as unknown as UsageBrokerQuery
  const db: UsageBrokerDatabase = {
    $transaction: async <T>(work: (value: UsageBrokerQuery) => Promise<T>) => work(typedTx),
  }
  return { tx, db }
}

describe("AI usage broker", () => {
  beforeEach(() => mocked.getEffectiveEntitlements.mockReset())

  it("atomically admits a fenced provider attempt and one monthly credit", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    let step = 0
    const { db, tx } = database(async () => {
      step += 1
      if (step === 2) return [{ id: input.stepId }]
      if (step === 6) return [{ used: 1 }]
      return []
    })

    const result = await admitAiUsage(db, input, new Date("2026-09-07T12:00:00.000Z"))
    expect(result.operationId).toMatch(/^agent-usage-[a-f0-9]{64}$/)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(6)
    expect(String(tx.$queryRaw.mock.calls[0]?.[0])).toBe("[object Object]")
  })

  it("rejects a repeated admission for a reserved or already settled attempt", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    const reserved = database(async () => {
      const count = reserved.tx.$queryRaw.mock.calls.length
      if (count === 2) return [{ id: input.stepId }]
      return [{ id: "agent-usage-existing", userId: input.userId, provider: input.provider, model: input.model, status: "reserved" }]
    })
    await expect(admitAiUsage(reserved.db, input)).rejects.toMatchObject({ code: "usage_attempt_in_flight", status: 409 })
    expect(reserved.tx.$queryRaw).toHaveBeenCalledTimes(3)

    const settled = database(async () => {
      const count = settled.tx.$queryRaw.mock.calls.length
      if (count === 2) return [{ id: input.stepId }]
      return [{ id: "agent-usage-existing", userId: input.userId, provider: input.provider, model: input.model, status: "success" }]
    })
    await expect(admitAiUsage(settled.db, input)).rejects.toMatchObject({ code: "usage_attempt_settled", status: 409 })
  })

  it("settles a reserved attempt idempotently and refuses a conflicting outcome", async () => {
    const operationId = "agent-usage-test"
    const settlement = { operationId, userId: input.userId, provider: input.provider, model: input.model, status: "success" as const, inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.01 }
    let status = "reserved"
    const { db, tx } = database(async () => {
      const count = tx.$queryRaw.mock.calls.length
      if (count === 2 || count === 5 || count === 7) return [{ userId: input.userId, provider: input.provider, model: input.model, status, inputTokens: status === "reserved" ? 0 : 10, outputTokens: status === "reserved" ? 0 : 4, estimatedCostUsd: status === "reserved" ? 0 : 0.01, errorCode: null }]
      if (count === 3) status = settlement.status
      return []
    })
    await settleAiUsage(db, settlement)
    await settleAiUsage(db, settlement)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(5)
    await expect(settleAiUsage(db, { ...settlement, status: "error", errorCode: "provider_error" })).rejects.toMatchObject({ code: "usage_attempt_settled", status: 409 })
  })

  it("rejects a repeated terminal settlement with different usage facts", async () => {
    const settlement = { operationId: "agent-usage-test-2", userId: input.userId, provider: input.provider, model: input.model, status: "success" as const, inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 }
    const { db } = database(async () => [{ userId: input.userId, provider: input.provider, model: input.model, status: "success", inputTokens: 9, outputTokens: 9, estimatedCostUsd: 0.09, errorCode: null }])
    await expect(settleAiUsage(db, settlement)).rejects.toMatchObject({ code: "usage_settlement_conflict", status: 409 })
  })
})
