import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocked = vi.hoisted(() => ({ getEffectiveEntitlements: vi.fn() }))
vi.mock("@/lib/entitlements", () => ({ getEffectiveEntitlements: mocked.getEffectiveEntitlements }))

import { admitAiUsage, admitAiUsageInTransaction, settleAiUsage, settleAiUsageInTransaction, startAiUsage, startAiUsageInTransaction,
  type UsageAdmissionInput, type UsageBrokerDatabase, type UsageBrokerQuery, type UsageStartInput } from "./usage-broker"
import { normalizeUsageOwner } from "./usage-owner-fence"

const input: UsageAdmissionInput = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", leaseOwnerId: "worker-1", leaseVersion: 4,
  featureKey: "agent", provider: "minimax", model: "MiniMax-M3", attemptId: "provider-attempt-1", credentialSource: "user",
}

function sqlText(query: unknown): string {
  return query && typeof query === "object" && "text" in query ? String((query as { text: unknown }).text) : ""
}

function database(
  query: (...args: unknown[]) => Promise<unknown>, serialize = false, admission: UsageAdmissionInput = input, childValid = true,
  root = { budgetSnapshot: {}, outputTokenReservationVersion: null as number | null },
) {
  const tx = { $queryRaw: vi.fn(query) }
  const owner = admission.executionOwner ?? { kind: "turn" as const, leaseOwnerId: admission.leaseOwnerId, leaseVersion: admission.leaseVersion }
  const rootTaskId = owner.kind === "task" ? owner.rootTaskId : "root-1"
  const typedTx: UsageBrokerQuery = {
    $queryRaw: async <T>(raw: Parameters<UsageBrokerQuery["$queryRaw"]>[0]): Promise<T> => {
      const text = sqlText(raw)
      if (text.includes('FROM "agent_sessions"')) return [{ id: admission.sessionId, status: "running" }] as T
      if (text.includes('FROM "agent_turns"')) return [{ id: admission.turnId, rootTaskId, status: "in_progress", leaseOwnerId: input.leaseOwnerId, leaseVersion: input.leaseVersion, leaseValid: true }] as T
      if (text.includes('FROM "sub_agent_tasks"') && text.includes('"budgetSnapshot"')) return [{
        id: rootTaskId, ...root, status: "running", interruptRequestedAt: null,
        attemptCount: 1, leaseOwner: input.leaseOwnerId, leaseValid: true,
      }] as T
      if (text.includes('FROM "sub_agent_tasks"') && owner.kind === "task") {
        if (!childValid) { await tx.$queryRaw(raw); return [] as T }
        return [{ id: owner.taskId, rootTaskId, turnId: admission.turnId, status: "running", interruptRequestedAt: null,
          attemptCount: owner.attemptCount, leaseOwner: owner.ownerId, leaseValid: true }] as T
      }
      if (text.includes('FROM "agent_steps"')) {
        await tx.$queryRaw(raw)
        return [{ id: admission.stepId, taskId: owner.kind === "task" ? owner.taskId : null,
          attempt: owner.kind === "task" ? owner.attemptCount : 1, status: "streaming" }] as T
      }
      if (text.includes("SUM(CASE WHEN")) return await tx.$queryRaw(raw) as T
      if (text.includes('FROM "agent_root_usage_reservations"')) return [] as T
      return await tx.$queryRaw(raw) as T
    },
  }
  let tail = Promise.resolve()
  const db: UsageBrokerDatabase = {
    $transaction: async <T>(work: (value: UsageBrokerQuery) => Promise<T>) => {
      if (!serialize) return work(typedTx)
      const previous = tail
      let unlock!: () => void
      tail = new Promise<void>(resolve => { unlock = resolve })
      await previous
      try { return await work(typedTx) } finally { unlock() }
    },
  }
  return { tx, db, typedTx }
}

function startInput(admission: UsageAdmissionInput = input): UsageStartInput {
  const owner = normalizeUsageOwner(admission)
  const ownerIdentity = owner.kind === "task" ? [owner.kind, owner.taskId, owner.rootTaskId, owner.ownerId, owner.attemptCount] : [owner.kind, owner.leaseOwnerId, owner.leaseVersion]
  const identity = [admission.userId, admission.sessionId, admission.turnId, admission.stepId, ...ownerIdentity,
    admission.attemptId ?? "1", admission.featureKey, admission.provider, admission.model, 1].join("\u001f")
  return { ...admission, startProtocolVersion: 1, operationId: `agent-usage-${createHash("sha256").update(identity).digest("hex")}` }
}

type StartFenceState = Partial<{
  sessionStatus: string; turnStatus: string; turnLeaseOwnerId: string; turnLeaseVersion: number; turnLeaseValid: boolean
  rootStatus: string; rootLeaseOwner: string; rootLeaseValid: boolean; rootInterruptRequestedAt: Date | null
  taskStatus: string; taskLeaseOwner: string; taskAttemptCount: number; taskLeaseValid: boolean; taskInterruptRequestedAt: Date | null
  stepStatus: string; stepAttempt: number
}>

function startDatabase(start: UsageStartInput, required = false, fence: StartFenceState = {}, includeReservation = true) {
  let eventStarted = false, reservationStatus = "reserved"
  const owner = normalizeUsageOwner(start)
  const rootTaskId = owner.kind === "task" ? owner.rootTaskId : "root-1"
  const taskId = owner.kind === "task" ? owner.taskId : rootTaskId
  const reservation = {
    id: start.operationId, userId: start.userId, sessionId: start.sessionId, turnId: start.turnId, rootTaskId, taskId,
    stepId: start.stepId, executionOwnerKind: owner.kind,
    executionOwnerId: owner.kind === "turn" ? owner.leaseOwnerId : owner.ownerId,
    executionOwnerVersion: owner.kind === "turn" ? owner.leaseVersion : owner.attemptCount,
    outputReservationRequired: required, attempt: owner.kind === "task" ? owner.attemptCount : fence.stepAttempt ?? 1,
    attemptId: start.attemptId ?? "1", provider: start.provider, model: start.model, reservedOutputTokens: 32,
    actualOutputTokens: null, status: reservationStatus, outcomeStatus: null, errorCode: null,
  }
  const tx = { $queryRaw: vi.fn(async (raw: unknown): Promise<unknown> => {
    const text = sqlText(raw)
    if (text.includes("set_config('app.user_id'")) return []
    if (text.includes('FROM "agent_sessions"')) return [{ id: start.sessionId, status: fence.sessionStatus ?? "running" }]
    if (text.includes('FROM "agent_turns"')) return [{
      id: start.turnId, rootTaskId, status: fence.turnStatus ?? "in_progress",
      leaseOwnerId: fence.turnLeaseOwnerId ?? (owner.kind === "turn" ? owner.leaseOwnerId : "turn-worker"),
      leaseVersion: fence.turnLeaseVersion ?? (owner.kind === "turn" ? owner.leaseVersion : 3), leaseValid: fence.turnLeaseValid ?? true,
    }]
    if (text.includes('FROM "sub_agent_tasks"') && text.includes('"budgetSnapshot"')) return [{
      id: rootTaskId, budgetSnapshot: required ? { limits: { maxOutputTokens: 64 } } : {},
      outputTokenReservationVersion: required ? 1 : null, status: fence.rootStatus ?? "running",
      interruptRequestedAt: fence.rootInterruptRequestedAt ?? null, attemptCount: 1,
      leaseOwner: fence.rootLeaseOwner ?? (owner.kind === "turn" ? owner.leaseOwnerId : "root-worker"), leaseValid: fence.rootLeaseValid ?? true,
    }]
    if (text.includes('FROM "sub_agent_tasks"') && owner.kind === "task") return [{
      id: owner.taskId, rootTaskId, turnId: start.turnId, status: fence.taskStatus ?? "running",
      interruptRequestedAt: fence.taskInterruptRequestedAt ?? null, attemptCount: fence.taskAttemptCount ?? owner.attemptCount,
      leaseOwner: fence.taskLeaseOwner ?? owner.ownerId, leaseValid: fence.taskLeaseValid ?? true,
    }]
    if (text.includes('FROM "sub_agent_tasks"')) return [{ id: rootTaskId }]
    if (text.includes('FROM "agent_steps"')) return [{
      id: start.stepId, taskId: owner.kind === "task" ? owner.taskId : null,
      attempt: fence.stepAttempt ?? (owner.kind === "task" ? owner.attemptCount : 1), status: fence.stepStatus ?? "streaming",
    }]
    if (text.includes('FROM "agent_root_usage_reservations"')) return includeReservation ? [{ ...reservation, status: reservationStatus }] : []
    if (text.includes("SELECT output_reservation_required")) return [{ outputReservationRequired: required,
      startProtocolVersion: 1, status: "reserved", credentialSource: start.credentialSource ?? "platform",
      providerStartedAt: eventStarted ? new Date("2026-11-13T00:00:00.000Z") : null }]
    if (text.includes('UPDATE "agent_root_usage_reservations"')) {
      if (reservationStatus !== "reserved") return []
      reservationStatus = "started"
      return [{ reservedOutputTokens: required ? 32 : 0 }]
    }
    if (text.includes("UPDATE ai_usage_events SET provider_started_at")) {
      if (eventStarted) return []
      eventStarted = true
      return [{ id: start.operationId }]
    }
    if (text.includes("FROM ai_usage_events")) return [{
      userId: start.userId, provider: start.provider, model: start.model, status: "reserved", errorCode: null, startProtocolVersion: 1,
      providerStartedAt: eventStarted ? new Date("2026-11-13T00:00:00.000Z") : null,
    }]
    return []
  }) }
  const db: UsageBrokerDatabase = { $transaction: async work => work(tx as unknown as UsageBrokerQuery) }
  return { tx, db }
}

describe("AI usage broker", () => {
  beforeEach(() => mocked.getEffectiveEntitlements.mockReset())

  it("claims a non-output-reserved provider start once and refuses release after that claim", async () => {
    const start = startInput()
    const { db, tx } = startDatabase(start)
    await expect(startAiUsageInTransaction(tx as unknown as UsageBrokerQuery, start))
      .resolves.toEqual({ startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null })
    await expect(startAiUsage(db, start)).rejects.toMatchObject({ code: "usage_start_replayed", status: 409 })
    await expect(settleAiUsage(db, { ...start, status: "released" })).rejects.toMatchObject({ code: "usage_attempt_started", status: 409 })
  })

  it("uses the persisted BYOK authorization when the Worker start contract omits credential source", async () => {
    const authorized = startInput()
    const workerStart = { ...authorized }
    delete workerStart.credentialSource
    const { db } = startDatabase(authorized)

    await expect(startAiUsage(db, workerStart)).resolves.toEqual({
      startProtocolVersion: 1, outputReservationRequired: false, maxOutputTokens: null,
    })
  })

  it("fails closed when the credential source changes between admission and start", async () => {
    const start = startInput()
    const { db, tx } = startDatabase(start)

    await expect(startAiUsage(db, { ...start, credentialSource: "platform" }))
      .rejects.toMatchObject({ code: "usage_attempt_conflict", status: 409 })
    expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes('UPDATE "agent_root_usage_reservations"'))).toBe(false)
    expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes("UPDATE ai_usage_events SET provider_started_at"))).toBe(false)
  })

  it("keeps the started Root output hold when any usage dimension is unknown", async () => {
    const start = startInput()
    const { db, tx } = startDatabase(start, true)
    await startAiUsage(db, start)

    await expect(settleAiUsage(db, { ...start, status: "success", inputTokens: 8, outputTokens: 4,
      estimatedCostUsd: null })).resolves.toBeUndefined()

    expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes(`SET "status" = 'settled'`))).toBe(false)
    expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes("UPDATE ai_usage_events SET status"))).toBe(false)
  })

  it("settles known usage through the caller-owned transaction", async () => {
    const start = startInput()
    const { db, tx } = startDatabase(start, true)
    await startAiUsage(db, start)

    await expect(settleAiUsageInTransaction(tx as unknown as UsageBrokerQuery, { ...start, status: "success",
      inputTokens: 8, outputTokens: 4, estimatedCostUsd: 0.01 })).resolves.toBeUndefined()

    expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes(`SET "status" = 'settled'`))).toBe(true)
    expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes("UPDATE ai_usage_events SET status"))).toBe(true)
  })

  it("fails closed when the usage event requires an output hold but its hold is missing", async () => {
    const start = startInput()
    const { db } = startDatabase(start, true, {}, false)
    await expect(startAiUsage(db, start))
      .rejects.toMatchObject({ code: "usage_attempt_missing", status: 409 })
  })

  it("rejects a stale owner, expired lease, terminal turn, or terminal step before claiming a start", async () => {
    const start = startInput()
    const invalid: StartFenceState[] = [
      { turnLeaseOwnerId: "reclaimed-worker" }, { turnLeaseVersion: 5 }, { turnLeaseValid: false },
      { turnStatus: "completed" }, { stepStatus: "completed" },
    ]
    for (const fence of invalid) {
      const { db, tx } = startDatabase(start, true, fence)
      await expect(startAiUsage(db, start)).rejects.toMatchObject({ code: "usage_fence_rejected", status: 409 })
      expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes('UPDATE "agent_root_usage_reservations"'))).toBe(false)
      expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes("UPDATE ai_usage_events SET provider_started_at"))).toBe(false)
    }
  })

  it("rejects reclaimed, expired, or terminal child Task leases before a start", async () => {
    const { leaseOwnerId: _leaseOwnerId, leaseVersion: _leaseVersion, ...common } = input
    const child: UsageAdmissionInput = { ...common, executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "child-worker", attemptCount: 2 } }
    const start = startInput(child)
    const invalid: StartFenceState[] = [
      { taskLeaseOwner: "reclaimed-child" }, { taskAttemptCount: 3 }, { taskLeaseValid: false }, { taskStatus: "completed" },
    ]
    for (const fence of invalid) {
      const { db, tx } = startDatabase(start, true, fence)
      await expect(startAiUsage(db, start)).rejects.toMatchObject({ code: "usage_fence_rejected", status: 409 })
      expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes('UPDATE "agent_root_usage_reservations"'))).toBe(false)
    }
  })

  it("binds operation IDs to the original Turn owner and fences explicit non-strict starts too", async () => {
    const valid = startInput()
    const { db: staleDb, tx: staleTx } = startDatabase(valid)
    await expect(startAiUsage(staleDb, { ...valid, operationId: "another-owner-operation" })).rejects.toMatchObject({ code: "usage_attempt_conflict", status: 409 })
    expect(staleTx.$queryRaw).not.toHaveBeenCalled()

    const { db, tx } = startDatabase(valid, false, { turnLeaseValid: false })
    await expect(startAiUsage(db, valid)).rejects.toMatchObject({ code: "usage_fence_rejected", status: 409 })
    expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes("UPDATE ai_usage_events SET provider_started_at"))).toBe(false)
  })

  it("atomically admits a fenced provider attempt and one monthly credit", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    let step = 0
    const { db, tx } = database(async () => {
      step += 1
      if (step === 2) return [{ id: input.stepId }]
      if (step === 4) return [{ id: "agent-usage-inserted" }]
      if (step === 6) return [{ used: 1 }]
      return []
    })

    const result = await admitAiUsage(db, input, new Date("2026-09-07T12:00:00.000Z"))
    expect(result.operationId).toMatch(/^agent-usage-[a-f0-9]{64}$/)
    const inserted = tx.$queryRaw.mock.calls.map(([raw]) => raw).find(raw => sqlText(raw).includes("INSERT INTO ai_usage_events")) as { text: string; values: unknown[] }
    expect(inserted.text).toContain("usage_start_protocol_version")
    expect(inserted.values).toContain(0)
    expect(inserted.values).toEqual(expect.arrayContaining([input.userId, input.featureKey, input.provider, input.model]))
  })

  it("admits inside a caller-owned transaction without opening a nested transaction", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    let step = 0
    const { tx, typedTx } = database(async () => {
      step += 1
      if (step === 2) return [{ id: input.stepId }]
      if (step === 4) return [{ id: "agent-usage-inserted" }]
      if (step === 6) return [{ used: 1 }]
      return []
    })
    const scopedTx: UsageBrokerQuery = typedTx

    const result = await admitAiUsageInTransaction(scopedTx, input, new Date("2026-09-07T12:00:00.000Z"))

    expect(result.operationId).toMatch(/^agent-usage-[a-f0-9]{64}$/)
    expect(tx.$queryRaw.mock.calls.some(([raw]) => sqlText(raw).includes("INSERT INTO ai_usage_events"))).toBe(true)
  })

  it("returns the serialized Root output allowance and persists that admitted ceiling", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    const strictInput = { ...input, startProtocolVersion: 1 as const, requestedOutputTokens: 80 }
    const { db, tx } = database(async raw => {
      const text = sqlText(raw)
      if (text.includes("SUM(CASE WHEN")) return [{ used: 18 }]
      if (text.includes("INSERT INTO ai_usage_events")) return [{ id: "usage-event-1" }]
      if (text.includes("UPDATE ai_budgets SET used")) return [{ used: 1 }]
      return []
    }, false, strictInput, true, { budgetSnapshot: { limits: { maxOutputTokens: 50 } }, outputTokenReservationVersion: 1 })

    await expect(admitAiUsage(db, strictInput)).resolves.toMatchObject({ outputReservationRequired: true, maxOutputTokens: 32 })
    const rootInsert = tx.$queryRaw.mock.calls.map(([raw]) => raw).find(raw => sqlText(raw).includes('INSERT INTO "agent_root_usage_reservations"')) as { values: unknown[] }
    expect(rootInsert.values).toContain(32)
    const usageInsert = tx.$queryRaw.mock.calls.map(([raw]) => raw).find(raw => sqlText(raw).includes("INSERT INTO ai_usage_events")) as { text: string; values: unknown[] }
    expect(usageInsert.text).toContain("output_reservation_required")
    expect(usageInsert.values).toContain(true)
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

  it("admits a running child Task fence and distinguishes its captured attempts", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    const { leaseOwnerId: _leaseOwnerId, leaseVersion: _leaseVersion, ...common } = input
    const child = {
      ...common,
      executionOwner: { kind: "task" as const, taskId: "child-1", rootTaskId: "root-1", ownerId: "child-worker", attemptCount: 2 },
    }
    const admitChild = async (attemptCount: number) => {
      const ownerInput = { ...child, executionOwner: { ...child.executionOwner, attemptCount } }
      const { db, tx } = database(async () => {
        const count = tx.$queryRaw.mock.calls.length
        if (count === 2) return [{ id: child.stepId }]
        if (count === 4) return [{ id: "agent-usage-inserted" }]
        if (count === 6) return [{ used: 1 }]
        return []
      }, false, ownerInput)
      return admitAiUsage(db, ownerInput, new Date("2026-09-07T12:00:00.000Z"))
    }
    const first = await admitChild(2)
    const second = await admitChild(3)
    expect(first.operationId).not.toBe(second.operationId)
  })

  it("rejects an unowned or expired child fence before reserving credit", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    const { leaseOwnerId: _leaseOwnerId, leaseVersion: _leaseVersion, ...common } = input
    const child = {
      ...common,
      executionOwner: { kind: "task" as const, taskId: "child-1", rootTaskId: "root-1", ownerId: "child-worker", attemptCount: 2 },
    }
    const { db, tx } = database(async () => [], false, child, false)
    await expect(admitAiUsage(db, child)).rejects.toMatchObject({ code: "usage_fence_rejected", status: 409 })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it("settles a reserved attempt idempotently and refuses a conflicting outcome", async () => {
    const operationId = "agent-usage-test"
    const settlement = { operationId, userId: input.userId, provider: input.provider, model: input.model, status: "success" as const, inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.01 }
    let status = "reserved"
    const { db } = database(async raw => {
      const text = sqlText(raw)
      if (text.includes("usage_start_protocol_version")) return [{ startProtocolVersion: 0, providerStartedAt: null, status }]
      if (text.includes("input_tokens AS")) return [{ userId: input.userId, provider: input.provider, model: input.model, status,
        inputTokens: status === "reserved" ? 0 : 10, outputTokens: status === "reserved" ? 0 : 4,
        estimatedCostUsd: status === "reserved" ? 0 : 0.01, errorCode: null }]
      if (text.includes("UPDATE ai_usage_events SET status")) status = settlement.status
      return []
    })
    await settleAiUsage(db, settlement)
    await settleAiUsage(db, settlement)
    await expect(settleAiUsage(db, { ...settlement, status: "error", errorCode: "provider_error" })).rejects.toMatchObject({ code: "usage_attempt_settled", status: 409 })
  })

  it("rejects a repeated terminal settlement with different usage facts", async () => {
    const settlement = { operationId: "agent-usage-test-2", userId: input.userId, provider: input.provider, model: input.model, status: "success" as const, inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 }
    const { db } = database(async raw => sqlText(raw).includes("usage_start_protocol_version")
      ? [{ startProtocolVersion: 0, providerStartedAt: null, status: "success" }]
      : [{ userId: input.userId, provider: input.provider, model: input.model, status: "success", inputTokens: 9, outputTokens: 9, estimatedCostUsd: 0.09, errorCode: null }])
    await expect(settleAiUsage(db, settlement)).rejects.toMatchObject({ code: "usage_settlement_conflict", status: 409 })
  })

  it("refunds a finite-credit reservation once across concurrent and replayed releases", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    const release = { ...input, status: "released" as const }
    let status = "reserved", refunds = 0
    const { db } = database(async raw => {
      const text = sqlText(raw)
      if (text.includes("usage_start_protocol_version")) return [{ userId: input.userId, provider: input.provider, model: input.model, startProtocolVersion: 0, providerStartedAt: null, status,
        errorCode: status === "reserved" ? "credit_reserved_2026-09" : "cancelled_before_provider" }]
      if (text.includes("UPDATE ai_budgets")) { refunds += 1; return [{ userId: input.userId }] }
      if (text.includes("UPDATE ai_usage_events SET status = 'released'")) { status = "released"; return [{ id: "event-1" }] }
      return []
    }, true)

    await Promise.all([settleAiUsage(db, release), settleAiUsage(db, release)])
    await settleAiUsage(db, release)
    expect(status).toBe("released")
    expect(refunds).toBe(1)
  })

  it("does not decrement finite credits for an unlimited-budget reservation", async () => {
    const release = { ...input, status: "released" as const }
    let status = "reserved"
    const { db } = database(async raw => {
      const text = sqlText(raw)
      if (text.includes("usage_start_protocol_version")) return [{ userId: input.userId, provider: input.provider, model: input.model, startProtocolVersion: 0, providerStartedAt: null, status, errorCode: null }]
      if (text.includes("UPDATE ai_usage_events SET status = 'released'")) { status = "released"; return [{ id: "event-1" }] }
      return []
    })

    await settleAiUsage(db, release)
    expect(status).toBe("released")
  })

  it("does not refund a provider-started or terminal operation", async () => {
    const release = { ...input, status: "released" as const }
    const { db } = database(async raw => {
      if (sqlText(raw).includes("usage_start_protocol_version")) return [{ userId: input.userId, provider: input.provider, model: input.model, startProtocolVersion: 0, providerStartedAt: null, status: "success", errorCode: null }]
      return []
    })
    await expect(settleAiUsage(db, release)).rejects.toMatchObject({ code: "usage_attempt_settled", status: 409 })
  })

  it("leaves a deterministic release tombstone when release beats admission", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    let row: { id: string; userId: string; provider: string; model: string; status: string; startProtocolVersion: number; providerStartedAt: Date | null; errorCode: string | null } | null = null
    const { db, tx } = database(async () => {
      const calls = tx.$queryRaw.mock.calls
      const text = sqlText(calls.at(-1)?.[0])
      if (text.includes('SELECT user_id AS "userId"') && text.includes("usage_start_protocol_version")) return row ? [{ ...row, errorCode: row.errorCode }] : []
      if (text.includes("INSERT INTO ai_usage_events")) { row = { id: "released-tombstone", userId: input.userId, provider: input.provider,
        model: input.model, status: "released", startProtocolVersion: 0, providerStartedAt: null, errorCode: "cancelled_before_provider" }; return [{ id: row.id }] }
      if (text.includes("FROM ai_usage_events") && row) return [{ ...row }]
      return []
    })

    await settleAiUsage(db, { ...input, status: "released" })
    const tombstone = tx.$queryRaw.mock.calls[2]?.[0] as { text: string; values: unknown[] }
    expect(tombstone.text).toContain("usage_start_protocol_version")
    expect(tombstone.text).toContain("'released', 'cancelled_before_provider'")
    expect(tombstone.values).toEqual(expect.arrayContaining([input.userId, input.featureKey, input.provider, input.model]))
    await expect(admitAiUsage(db, input)).rejects.toMatchObject({ code: "usage_attempt_released", status: 409 })
  })

  it("classifies an insert race against a release tombstone without reserving another credit", async () => {
    mocked.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 2 } })
    let count = 0
    const { db, tx } = database(async () => {
      count += 1
      if (count === 2) return [{ id: input.stepId }]
      if (count === 4) return []
      if (count === 5) return [{ id: "released-tombstone", userId: input.userId, provider: input.provider, model: input.model, status: "released" }]
      return []
    })
    await expect(admitAiUsage(db, input)).rejects.toMatchObject({ code: "usage_attempt_released", status: 409 })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(5)
  })
})
