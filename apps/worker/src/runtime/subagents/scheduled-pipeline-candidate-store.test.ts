import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import { createScheduledPipelineCandidateStore, LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA, parseScheduledPipelineCandidatePayload,
  parseScheduledPipelineSourceReceipt, SCHEDULED_PIPELINE_CANDIDATE_EVENT, SCHEDULED_PIPELINE_CANDIDATE_SCHEMA,
  SCHEDULED_PIPELINE_SOURCE_RECEIPT_SCHEMA_VERSION, takeRecoveredScheduledPipelineCandidate, withScheduledPipelineCandidateModelOutput,
  type ScheduledPipelineSourceReceipt } from "./scheduled-pipeline-candidate-store.js"

const oldOwner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-old", leaseVersion: 8, leaseExpiresAt: new Date("2026-10-20T12:00:00.000Z"),
}
const newOwner: TurnExecutionOwnerFence = { ...oldOwner, ownerId: "worker-recovered", leaseVersion: 9,
  leaseExpiresAt: new Date("2026-10-20T12:05:00.000Z") }
const identity = { owner: oldOwner, rootAttemptCount: 2, finalStepId: "step-final-4", finalStepOrdinal: 4 }
const digest = `sha256:${"a".repeat(64)}`
const sourceReceipt: ScheduledPipelineSourceReceipt = { schemaVersion: SCHEDULED_PIPELINE_SOURCE_RECEIPT_SCHEMA_VERSION,
  scope: { userId: oldOwner.userId, sessionId: oldOwner.sessionId, turnId: oldOwner.turnId, taskId: oldOwner.rootTaskId, stepId: identity.finalStepId }, bindings: [
  { key: "E-job-a", observationId: "tool-result:call-1", toolCallId: "call-1", toolName: "jobs.search", sourceRef: "jobs/0", inputDigest: digest, resultDigest: digest },
  { key: "E-job-b", observationId: "tool-result:call-1", toolCallId: "call-1", toolName: "jobs.search", sourceRef: "jobs/1", inputDigest: digest, resultDigest: digest },
] }

function candidateEvent(owner = oldOwner, overrides: Record<string, unknown> = {}) {
  const schemaVersion = overrides.schemaVersion ?? SCHEDULED_PIPELINE_CANDIDATE_SCHEMA
  const payload = { schemaVersion, sessionId: owner.sessionId,
    turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: 2,
    finalStepId: "step-final-4", finalStepOrdinal: 4, stepAttempt: 1, candidateText: "Exact final answer.", finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.02 },
    ...(schemaVersion === LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA ? {} : { sourceReceipt }),
    ...overrides }
  return { sourceEventId: "candidate-event-1", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId,
    type: SCHEDULED_PIPELINE_CANDIDATE_EVENT, correlationId: "step-final-4", payload, stepId: "step-final-4",
    stepTaskId: owner.rootTaskId, stepAttempt: 1, stepOrdinal: 4, stepStatus: "streaming", stepInputThroughSequence: "10",
    stepConsumedInputIds: [], stepModelProfileSnapshot: { provider: "fixture" },
    stepFinishReason: null, stepInputTokens: 0, stepOutputTokens: 0, stepEstimatedCostUsd: 0 }
}

function withModelOutput<T>(owner: TurnExecutionOwnerFence, work: () => Promise<T>): Promise<T> {
  return withScheduledPipelineCandidateModelOutput({ owner, finalStepId: identity.finalStepId, finalStepOrdinal: identity.finalStepOrdinal,
    candidateText: "Exact final answer.", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.02 }, sourceReceipt }, work)
}

function poolFor(event: Record<string, unknown> | null, options: { rootAttempt?: number; recoverySteps?: Record<string, unknown>[]; unconsumedInput?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
    if (sql.includes('SELECT turn."id" FROM "agent_turns"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
    if (sql.includes('SELECT task."attemptCount"')) return { rows: [{ attemptCount: options.rootAttempt ?? 2 }], rowCount: 1 }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: event ? [event] : [], rowCount: event ? 1 : 0 }
    if (sql.includes('FROM "agent_steps"') && sql.includes('"ordinal" > $4')) return { rows: options.recoverySteps ?? [], rowCount: options.recoverySteps?.length ?? 0 }
    if (sql.includes('FROM "agent_events"') || sql.includes('FROM "agent_items"') || sql.includes('FROM "agent_wait_conditions"')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_inputs"')) return { rows: options.unconsumedInput ? [{ id: "input-1" }] : [], rowCount: options.unconsumedInput ? 1 : 0 }
    return { rows: [], rowCount: 0 }
  }), release: vi.fn() }
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">, calls, client }
}

describe("scheduled pipeline durable candidate", () => {
  it("stages exact text under the live lease and recovers it after lease rollover", async () => {
    const appended: Array<Record<string, unknown>> = []
    const accepted = new Map<string, Parameters<TurnEngineStore["appendEvent"]>[0]>()
    const eventStore = { appendEvent: vi.fn(async (input: Parameters<TurnEngineStore["appendEvent"]>[0]) => {
      appended.push(input as unknown as Record<string, unknown>)
      const existing = accepted.get(input.idempotencyKey)
      if (existing && (existing.owner.userId !== input.owner.userId || existing.owner.sessionId !== input.owner.sessionId
        || existing.owner.turnId !== input.owner.turnId || existing.owner.taskId !== input.owner.taskId
        || existing.type !== input.type || existing.itemId !== input.itemId || existing.correlationId !== input.correlationId
        || existing.causationId !== input.causationId || JSON.stringify(existing.payload) !== JSON.stringify(input.payload))) {
        throw new Error(`event ${input.idempotencyKey} identity`)
      }
      if (!existing) accepted.set(input.idempotencyKey, input)
      return { id: "event-1" }
    }) } as unknown as Pick<TurnEngineStore, "appendEvent">
    const fixture = poolFor(candidateEvent())
    const store = createScheduledPipelineCandidateStore(fixture.pool, eventStore)
    await withModelOutput(oldOwner, () => store.stage({ ...identity, candidateText: "Exact final answer." }))
    await withModelOutput(newOwner, () => store.stage({ ...identity, owner: newOwner, candidateText: "Exact final answer." }))

    const staged = appended[0]!
    expect(staged).toMatchObject({ owner: oldOwner, type: SCHEDULED_PIPELINE_CANDIDATE_EVENT, correlationId: "step-final-4",
      idempotencyKey: "scheduled-candidate:root-1:2:step-final-4",
      payload: { rootAttemptCount: 2, finalStepId: "step-final-4", finalStepOrdinal: 4, stepAttempt: 1,
        candidateText: "Exact final answer.", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.02 } } })
    expect(appended).toHaveLength(2)
    expect(appended[1]).toMatchObject({ owner: newOwner, idempotencyKey: staged.idempotencyKey, payload: staged.payload })
    expect((staged.payload as Record<string, unknown>).writerLeaseOwnerId).toBeUndefined()
    expect((staged.payload as Record<string, unknown>).writerLeaseVersion).toBeUndefined()
    expect(accepted).toHaveProperty("size", 1)

    await expect(store.read({ owner: newOwner, rootAttemptCount: 2 })).resolves.toEqual({
      candidateText: "Exact final answer.", finalStepId: "step-final-4", finalStepOrdinal: 4, finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.02 },
      sourceReceipt,
      recoverySource: { owner: { userId: newOwner.userId, sessionId: newOwner.sessionId, turnId: newOwner.turnId,
        rootTaskId: newOwner.rootTaskId }, sourceEventId: "candidate-event-1", sourceStepId: "step-final-4",
        sourceStepOrdinal: 4, rootAttemptCount: 2, inputThroughSequence: "10", consumedInputIds: [] }, recoveryTail: null,
    })
    expect(takeRecoveredScheduledPipelineCandidate({ owner: newOwner, candidateText: "Exact final answer." })).toMatchObject({ finishReason: "stop", usage: { inputTokens: 12 } })
    expect(takeRecoveredScheduledPipelineCandidate({ owner: newOwner, candidateText: "Exact final answer." })).toBeUndefined()
    const turnLock = fixture.calls.find(call => call.sql.includes('SELECT turn."id" FROM "agent_turns"'))
    expect(turnLock?.values).toContain("worker-recovered")
    expect(turnLock?.values).toContain(9)
    expect(fixture.calls.some(call => call.sql.includes('FROM "agent_events"') && call.sql.includes('JOIN "agent_steps"'))).toBe(true)

    const conflictingReceipt: ScheduledPipelineSourceReceipt = { ...sourceReceipt, bindings: sourceReceipt.bindings.map((binding, index) =>
      index === 0 ? { ...binding, sourceRef: "jobs/2" } : binding) }
    await expect(withScheduledPipelineCandidateModelOutput({ owner: newOwner, finalStepId: identity.finalStepId, finalStepOrdinal: identity.finalStepOrdinal,
      candidateText: "Exact final answer.", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.02 },
      sourceReceipt: conflictingReceipt }, () => store.stage({ ...identity, owner: newOwner, candidateText: "Exact final answer." })))
      .rejects.toThrow(/identity/)
    const wrongOwnerReceipt = { ...sourceReceipt, scope: { ...sourceReceipt.scope, userId: "user-other" } }
    await expect(withScheduledPipelineCandidateModelOutput({ owner: newOwner, finalStepId: identity.finalStepId, finalStepOrdinal: identity.finalStepOrdinal,
      candidateText: "Exact final answer.", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.02 },
      sourceReceipt: wrongOwnerReceipt }, async () => undefined)).rejects.toThrow("scheduled_candidate_model_receipt_invalid")
  })

  it("round-trips bounded multi-record source bindings and keeps legacy candidates citation-free", async () => {
    const stagedEvents: Array<Record<string, unknown>> = []
    const store = createScheduledPipelineCandidateStore(poolFor(candidateEvent()).pool, {
      appendEvent: vi.fn(async (input: Parameters<TurnEngineStore["appendEvent"]>[0]) => { stagedEvents.push(input as unknown as Record<string, unknown>); return { id: "event-1" } }),
    } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await withModelOutput(oldOwner, () => store.stage({ ...identity, candidateText: "Exact final answer." }))
    expect((stagedEvents[0]?.payload as Record<string, unknown>)?.sourceReceipt).toEqual(sourceReceipt)

    const legacy = candidateEvent(newOwner, { schemaVersion: LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA })
    const reader = createScheduledPipelineCandidateStore(poolFor(legacy).pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(reader.read({ owner: newOwner, rootAttemptCount: 2 })).resolves.toMatchObject({ candidateText: "Exact final answer.", sourceReceipt: null })

    const { scope: _scope, ...legacyReceipt } = sourceReceipt
    const unscoped = candidateEvent(newOwner, { sourceReceipt: legacyReceipt })
    const unscopedReader = createScheduledPipelineCandidateStore(poolFor(unscoped).pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(unscopedReader.read({ owner: newOwner, rootAttemptCount: 2 })).resolves.toMatchObject({
      candidateText: "Exact final answer.", sourceReceipt: null,
    })
  })

  it("rejects a candidate written for a different root attempt", async () => {
    const fixture = poolFor(candidateEvent(), { rootAttempt: 3 })
    const store = createScheduledPipelineCandidateStore(fixture.pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(store.read({ owner: newOwner, rootAttemptCount: 2 })).rejects.toThrow("scheduled_candidate_root_attempt_changed")
  })

  it("rejects a candidate from a different root or Worker step attempt", async () => {
    const event = candidateEvent(newOwner, { rootTaskId: "root-stale" })
    const fixture = poolFor({ ...event, taskId: "root-stale" })
    const store = createScheduledPipelineCandidateStore(fixture.pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(store.read({ owner: newOwner, rootAttemptCount: 2 })).rejects.toThrow("scheduled_candidate_identity_mismatch")

    const wrongReceipt = { ...sourceReceipt, scope: { ...sourceReceipt.scope, userId: "user-stale" } }
    const wrongOwner = createScheduledPipelineCandidateStore(poolFor(candidateEvent(newOwner, { sourceReceipt: wrongReceipt })).pool,
      { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(wrongOwner.read({ owner: newOwner, rootAttemptCount: 2 })).rejects.toThrow("scheduled_candidate_identity_mismatch")

    const wrongAttempt = poolFor({ ...candidateEvent(newOwner), stepAttempt: 2 })
    const second = createScheduledPipelineCandidateStore(wrongAttempt.pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(second.read({ owner: newOwner, rootAttemptCount: 2 })).rejects.toThrow("scheduled_candidate_step_mismatch")
  })

  it("does not require a staged candidate before the first Turn", async () => {
    const fixture = poolFor(null)
    const store = createScheduledPipelineCandidateStore(fixture.pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(store.read({ owner: newOwner, rootAttemptCount: 2 })).resolves.toBeUndefined()
    expect(fixture.calls.some(call => call.sql.includes('FROM "agent_steps"'))).toBe(false)
  })

  it("requires the exact finish receipt when staging and rejects an invalid recovered usage payload", async () => {
    const store = createScheduledPipelineCandidateStore(poolFor(null).pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(store.stage({ ...identity, candidateText: "Exact final answer." })).rejects.toThrow("scheduled_candidate_model_receipt_missing")
    const invalid = poolFor(candidateEvent(newOwner, { usage: { inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0, extra: true } }))
    const reader = createScheduledPipelineCandidateStore(invalid.pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(reader.read({ owner: newOwner, rootAttemptCount: 2 })).rejects.toThrow("scheduled_candidate_identity_mismatch")
  })

  it("rejects source receipt key, source, call-identity, and size conflicts", async () => {
    expect(parseScheduledPipelineSourceReceipt({ ...sourceReceipt, bindings: [sourceReceipt.bindings[0],
      { ...sourceReceipt.bindings[1]!, key: sourceReceipt.bindings[0]!.key }] })).toBeNull()
    expect(parseScheduledPipelineSourceReceipt({ ...sourceReceipt, bindings: [sourceReceipt.bindings[0],
      { ...sourceReceipt.bindings[1]!, resultDigest: `sha256:${"b".repeat(64)}` }] })).toBeNull()
    expect(parseScheduledPipelineSourceReceipt({ ...sourceReceipt, bindings: [{ ...sourceReceipt.bindings[0]!, toolName: "agent.apply" }] })).toBeNull()
    expect(parseScheduledPipelineSourceReceipt({ ...sourceReceipt, bindings: Array.from({ length: 9 }, (_, index) => ({
      ...sourceReceipt.bindings[0]!, key: `E-job-${index}`, sourceRef: `jobs/${index}`,
    })) })).toBeNull()
    const longSelector = ["a", "b", "c", "d"].map(segment => segment.repeat(31)).join("/")
    const oversized: ScheduledPipelineSourceReceipt = { ...sourceReceipt, bindings: Array.from({ length: 8 }, (_, index) => ({
      ...sourceReceipt.bindings[0]!, key: `E-${String(index).padEnd(126, "k")}`, observationId: `observation-${index}`.padEnd(256, "o"),
      toolCallId: `call-${index}`.padEnd(256, "c"), sourceRef: longSelector,
    })) }
    expect(parseScheduledPipelineSourceReceipt(oversized)).toBeNull()
    const currentPayload = candidateEvent().payload
    expect(parseScheduledPipelineCandidatePayload({ ...currentPayload, sourceReceipt: { ...sourceReceipt, extra: true } })).toBeNull()
  })

  it("marks a staged candidate invalid after a later root step or new unconsumed input", async () => {
    const laterStep = poolFor(candidateEvent(newOwner), { recoverySteps: [{ id: "step-after-final", taskId: "root-1", ordinal: 5,
      attempt: 1, status: "completed", errorCode: null, inputThroughSequence: "10", consumedInputIds: [], modelProfileSnapshot: {},
      inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01 }] })
    const first = createScheduledPipelineCandidateStore(laterStep.pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(first.read({ owner: newOwner, rootAttemptCount: 2 })).resolves.toBeNull()

    const pendingInput = poolFor(candidateEvent(newOwner), { unconsumedInput: true })
    const second = createScheduledPipelineCandidateStore(pendingInput.pool, { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">)
    await expect(second.read({ owner: newOwner, rootAttemptCount: 2 })).resolves.toBeNull()
    expect(pendingInput.calls.find(call => call.sql.includes('FROM "agent_inputs"'))?.values).toContain("10")
  })
})
