import type pg from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { readState } = vi.hoisted(() => ({ readState: vi.fn() }))
vi.mock("../subagents/steering-reconciliation-read.js", () => ({ readSteeringReconciliationState: readState }))

import { createStoredAgentInputMapper, loadUnresolvedSteeringContext, type HydrationScope } from "./steering-reconciliation-context.js"

const scope: HydrationScope = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a",
  turnLeaseOwner: "worker-a", turnLeaseVersion: 3, parentLeaseOwner: "worker-a", parentAttemptCount: 2, rootInputId: "original-a",
}
const parts = [
  { type: "text", text: "Keep Dublin.\t" },
  { type: "attachment_ref", attachmentId: "resume-a", mediaType: "application/pdf", filename: "resume.pdf" },
]

function acceptedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "steer-a", sessionId: "session-a", targetTurnId: "turn-a", userId: "user-a", clientMessageId: "client-a",
    delivery: "steer", status: "consumed", content: parts, acceptedSequence: "8", consumedByStepId: "step-zero",
    consumedAt: new Date("2026-10-01T10:00:00.000Z"), createdAt: new Date("2026-10-01T09:59:00.000Z"), cancelledAt: null,
    acceptedType: "input.accepted", acceptedActor: "user", acceptedTaskId: null, acceptedCorrelationId: "turn-a",
    acceptedEventSequence: "8", acceptedPayload: { inputId: "steer-a", clientMessageId: "client-a", delivery: "steer", source: "user", disposition: "user_statement" },
    acceptedItemId: "message-a", acceptedItemType: "user_message", acceptedItemTaskId: null, acceptedItemStatus: "completed",
    acceptedItemContent: { clientMessageId: "client-a", disposition: "user_statement", source: "user", parts },
    ...overrides,
  }
}

function fakeClient(rows: readonly Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values })
    return { rows }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query, calls }
}

const mapInput = createStoredAgentInputMapper(message => new Error(message))

describe("unresolved steering context hydration", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns no rows and does not issue a second query after a keep/revise receipt resolved the ledger", async () => {
    readState.mockResolvedValue({ unresolvedInputs: [], resolvedInputIds: ["steer-a"] })
    const fake = fakeClient()

    await expect(loadUnresolvedSteeringContext(fake.client, scope, mapInput, message => new Error(message))).resolves.toEqual([])
    expect(readState).toHaveBeenCalledWith(fake.client, scope)
    expect(fake.query).not.toHaveBeenCalled()
  })

  it("hydrates only the ledger-selected ID and preserves complete accepted multipart text as stored input", async () => {
    readState.mockResolvedValue({ unresolvedInputs: [{ id: "steer-a" }], resolvedInputIds: [] })
    const fake = fakeClient([acceptedRow()])

    const loaded = await loadUnresolvedSteeringContext(fake.client, scope, mapInput, message => new Error(message))

    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ id: "steer-a", sessionId: scope.sessionId, targetTurnId: scope.turnId, userId: scope.userId, delivery: "steer", content: parts })
    expect(fake.calls[0]?.values).toEqual([scope.sessionId, scope.turnId, scope.userId, ["steer-a"]])
    expect(fake.calls[0]?.sql).toContain('accepted_item."content" AS "acceptedItemContent"')
  })

  it("fails closed when immutable accepted item parts no longer match AgentInput content", async () => {
    readState.mockResolvedValue({ unresolvedInputs: [{ id: "steer-a" }], resolvedInputIds: [] })
    const fake = fakeClient([acceptedRow({ acceptedItemContent: { ...acceptedRow().acceptedItemContent, parts: [{ type: "text", text: "changed" }] } })])

    await expect(loadUnresolvedSteeringContext(fake.client, scope, mapInput, message => new Error(message))).rejects.toThrow("Accepted user steering content changed")
  })

  it("fails closed when an unresolved ID has no accepted item row", async () => {
    readState.mockResolvedValue({ unresolvedInputs: [{ id: "steer-a" }], resolvedInputIds: [] })
    const fake = fakeClient()

    await expect(loadUnresolvedSteeringContext(fake.client, scope, mapInput, message => new Error(message))).rejects.toThrow("Unresolved steering input is missing its accepted user item")
  })
})
