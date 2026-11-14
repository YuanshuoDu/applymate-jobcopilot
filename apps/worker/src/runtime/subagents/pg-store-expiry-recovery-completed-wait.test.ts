import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TerminalCallProjection } from "./pg-store-expiry-historical-wait-binding.js"
const projectionMocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("./pg-store-expiry-historical-wait-projections.js", () => ({ readChildWaitTerminalCallProjections: projectionMocks.read }))
import { hasProvenCompletedConsumedWait } from "./pg-store-expiry-recovery-completed-wait.js"

const now = new Date("2026-10-06T10:00:00Z")
const task = { id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", status: "running", leaseOwner: "worker-1", attemptCount: 4,
  leaseExpiresAt: new Date(now.getTime() - 1_000), interruptRequestedAt: null }
const sourceWait = { waitId: "wait-1", sourceStepId: "source-step", sourceAttempt: 4, sourceCallItemId: "source-call-item",
  sourceCallId: "source-call", projectedSourceCallId: "projected-source-call", sourceResultItemId: "source-result-item",
  sourceKeyDigest: "digest-source", sourceLifecycleRecoveryOwnerDigest: null, claimKeyDigest: null, sourceKind: "normal_waiting" as const,
  deadlineAt: "2026-10-06T10:00:00.000Z", status: "ready" as const, mode: "any" as const,
  targetTaskIds: ["target-1"], matchedTaskIds: ["target-1"], timeoutMs: 10_000 }
const sourceProjection: TerminalCallProjection = { startEventId: "source-start", rawCallId: "source-call", projectedCallId: "projected-source-call",
  callItemId: "source-call-item", stepId: "source-step", attempt: 4, sourceWait }
const claimProjection: TerminalCallProjection = { startEventId: "claim-start", rawCallId: "claim-call", projectedCallId: "projected-claim-call",
  callItemId: "claim-call-item", stepId: "continuation-step", attempt: 4, sourceWait: { ...sourceWait, claimKeyDigest: "digest-claim" },
  resultItemId: "claim-result-item", stepToolChain: { nextEventId: "step-completed" } }
const candidate = { waitId: "wait-1", sourceStepId: "source-step", sourceAttempt: 4, continuationStepId: "continuation-step",
  continuationOrdinal: 9, continuationWaitCallCount: 0 }

function fixture(rows: unknown[] = [candidate], accepted = true) {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values })
    if (sql.startsWith('SELECT wait."id"')) return { rows, rowCount: rows.length }
    return { rows: [{ accepted }], rowCount: 1 }
  }) }
  return { client, queries }
}

describe("completed consumed wait proof", () => {
  beforeEach(() => projectionMocks.read.mockReset())

  it("reuses the exact source receipt and completed latest successor", async () => {
    projectionMocks.read.mockResolvedValueOnce([sourceProjection])
    const fake = fixture()
    await expect(hasProvenCompletedConsumedWait(fake.client as never, task, now)).resolves.toBe(true)
    expect(fake.queries).toHaveLength(2)
    const [candidateQuery, finalQuery] = fake.queries
    expect(candidateQuery?.sql).toContain('wait."consumedAt" IS NOT NULL')
    expect(candidateQuery?.sql).toContain('continuation."status" = \'completed\'')
    expect(candidateQuery?.sql).toContain(`completedEvent."idempotencyKey" = 'task:' || task."id" || ':event:step-completed:' || continuation."id"`)
    expect(candidateQuery?.sql).not.toContain(`completedEvent."idempotencyKey" = 'task:' || owner."id" || ':event:step-completed:' || continuation."id"`)
    expect(candidateQuery?.sql).toContain(`'taskId', task."id")`)
    expect(candidateQuery?.sql).toContain("AND ((SELECT COUNT(*) FROM \"agent_events\" AS completedEvent")
    expect(candidateQuery?.sql).toContain(`'taskId', task."id")))) = 1)`)
    expect(candidateQuery?.sql).not.toContain(`'taskId', task."id"))) = 1)`)
    expect(candidateQuery?.sql).toContain('task."leaseOwner" = $6')
    expect(candidateQuery?.sql).toContain('task."attemptCount" = $7')
    expect(candidateQuery?.sql).toContain('task."leaseExpiresAt" = $8')
    expect(finalQuery?.sql).toContain('owner."leaseOwner" = $5')
    expect(finalQuery?.sql).toContain('owner."attemptCount" = $6')
    expect(finalQuery?.sql).toContain('owner."leaseExpiresAt" = $7')
    expect(finalQuery?.sql).toContain('session."userId" = $8')
    expect(finalQuery?.sql).toContain('completedWait."consumedAt" IS NOT NULL')
    expect(finalQuery?.sql).toContain('continuation."status" = \'completed\'')
    expect(finalQuery?.sql).toContain(`completedEvent."idempotencyKey" = 'task:' || owner."id" || ':event:step-completed:' || continuation."id"`)
    expect(finalQuery?.sql).not.toContain(`completedEvent."idempotencyKey" = 'task:' || task."id" || ':event:step-completed:' || continuation."id"`)
    expect(finalQuery?.sql).toContain(`'taskId', owner."id")`)
    expect(finalQuery?.sql).toContain("AND ((SELECT COUNT(*) FROM \"agent_events\" AS completedEvent")
    expect(finalQuery?.sql).toContain(`'taskId', owner."id")))) = 1)`)
    expect(finalQuery?.sql).not.toContain(`'taskId', owner."id"))) = 1)`)
    expect(finalQuery?.sql).toContain('completedEvent."payload"')
    expect(finalQuery?.values).toEqual(["session-1", "child-1", "turn-1", "root-1", "worker-1", 4, task.leaseExpiresAt, "user-1", expect.any(String)])
  })

  it("checks JSON numeric types and exact int4/tool-call-count ranges without unsafe casts", async () => {
    projectionMocks.read.mockResolvedValueOnce([sourceProjection])
    const fake = fixture([{ ...candidate, continuationWaitCallCount: "0" }])
    await expect(hasProvenCompletedConsumedWait(fake.client as never, task, now)).resolves.toBe(true)
    const [candidateQuery, finalQuery] = fake.queries
    expect(candidateQuery?.sql).toContain("SELECT COUNT(*) FROM \"agent_items\" AS waitCall")
    expect(candidateQuery?.sql).not.toContain("COUNT(*)::int")
    expect(candidateQuery?.sql).toContain("CASE WHEN jsonb_typeof(completedEvent.\"payload\"->'toolCallCount') = 'number'")
    expect(candidateQuery?.sql).toContain("THEN completedEvent.\"payload\"->>'toolCallCount' ~ '^(0|[1-9]|[12][0-9]|3[0-2])$' ELSE FALSE END")
    expect(candidateQuery?.sql).not.toContain("toolCallCount')::integer")
    expect(finalQuery?.sql).toContain("jsonb_typeof(proof.value->'sourceWait'->'sourceAttempt') = 'number'")
    expect(finalQuery?.sql).toContain("('2147483647'::text COLLATE \"C\")")
    expect(finalQuery?.sql).toContain("THEN source.\"attempt\"::text = proof.value->'sourceWait'->>'sourceAttempt' ELSE FALSE END")
    expect(finalQuery?.sql).not.toContain("sourceAttempt')::integer")

    const countPattern = candidateQuery?.sql.match(/completedEvent\."payload"->>'toolCallCount' ~ '([^']+)'/)?.[1]
    expect(countPattern).toBe("^(0|[1-9]|[12][0-9]|3[0-2])$")
    const countAllowed = (jsonType: string, value: string) => jsonType === "number" && new RegExp(countPattern!).test(value)
    expect(countAllowed("number", "0")).toBe(true)
    expect(countAllowed("number", "32")).toBe(true)
    expect(countAllowed("number", "33")).toBe(false)
    expect(countAllowed("number", "99999999999999999999")).toBe(false)
    expect(countAllowed("number", "1.0")).toBe(false)
    expect(countAllowed("string", "1")).toBe(false)

    const attemptPattern = finalQuery?.sql.match(/proof\.value->'sourceWait'->>'sourceAttempt' ~ '([^']+)'/)?.[1]
    expect(attemptPattern).toBe("^[1-9][0-9]{0,9}$")
    const attemptAllowed = (jsonType: string, value: string, persisted: number) => jsonType === "number"
      && new RegExp(attemptPattern!).test(value)
      && (value.length < 10 || value <= "2147483647")
      && value === String(persisted)
    expect(attemptAllowed("number", "4", 4)).toBe(true)
    expect(attemptAllowed("number", "2147483647", 2147483647)).toBe(true)
    expect(attemptAllowed("number", "2147483648", 2147483647)).toBe(false)
    expect(attemptAllowed("number", "99999999999", 2147483647)).toBe(false)
    expect(attemptAllowed("string", "4", 4)).toBe(false)
  })

  it("accepts PostgreSQL bigint count strings and rejects counts outside the candidate contract", async () => {
    projectionMocks.read.mockResolvedValueOnce([sourceProjection])
    const zero = fixture([{ ...candidate, continuationWaitCallCount: "0" }])
    await expect(hasProvenCompletedConsumedWait(zero.client as never, task, now)).resolves.toBe(true)

    projectionMocks.read.mockResolvedValueOnce([sourceProjection, claimProjection])
    const one = fixture([{ ...candidate, continuationWaitCallCount: "1" }])
    await expect(hasProvenCompletedConsumedWait(one.client as never, task, now)).resolves.toBe(true)

    for (const count of ["2", "2147483648", "9007199254740993", "not-a-count"]) {
      const callsBefore = projectionMocks.read.mock.calls.length
      const invalid = fixture([{ ...candidate, continuationWaitCallCount: count }])
      await expect(hasProvenCompletedConsumedWait(invalid.client as never, task, now)).resolves.toBe(false)
      expect(projectionMocks.read).toHaveBeenCalledTimes(callsBefore)
    }
  })

  it("binds a continuation claim to the completed successor when it contains one wait call", async () => {
    projectionMocks.read.mockResolvedValueOnce([sourceProjection, claimProjection])
    const fake = fixture([{ ...candidate, continuationWaitCallCount: 1 }])
    await expect(hasProvenCompletedConsumedWait(fake.client as never, task, now)).resolves.toBe(true)
    expect(fake.queries.filter(query => query.sql.includes("FROM proof CROSS JOIN proofBundle"))).toHaveLength(2)
    expect(fake.queries.at(-1)?.values?.[8]).toContain('"claimKeyDigest":"digest-claim"')
  })

  it.each([
    { label: "ambiguous candidates", rows: [candidate, { ...candidate, waitId: "wait-2" }], projections: [sourceProjection], accepted: true },
    { label: "foreign source wait", rows: [candidate], projections: [{ ...sourceProjection, sourceWait: { ...sourceWait, waitId: "other-wait" } }], accepted: true },
    { label: "missing continuation claim", rows: [{ ...candidate, continuationWaitCallCount: 1 }], projections: [sourceProjection], accepted: true },
    { label: "duplicate continuation claims", rows: [{ ...candidate, continuationWaitCallCount: 1 }], projections: [sourceProjection, claimProjection, claimProjection], accepted: true },
    { label: "final SQL binding rejects", rows: [candidate], projections: [sourceProjection], accepted: false },
  ])("fails closed for $label", async ({ label, rows, projections, accepted }) => {
    projectionMocks.read.mockResolvedValueOnce(projections)
    const fake = fixture(rows, accepted)
    const result = await hasProvenCompletedConsumedWait(fake.client as never, task, now)
    expect(result).toBe(false)
    expect(fake.queries).toHaveLength(label === "final SQL binding rejects" ? 2 : 1)
  })

  it("does not query a task whose lease has not expired", async () => {
    const fake = fixture()
    await expect(hasProvenCompletedConsumedWait(fake.client as never,
      { ...task, leaseExpiresAt: new Date(now.getTime() + 1_000) }, now)).resolves.toBe(false)
    expect(fake.client.query).not.toHaveBeenCalled()
  })
})
