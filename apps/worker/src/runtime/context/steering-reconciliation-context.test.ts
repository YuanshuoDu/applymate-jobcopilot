import type pg from "pg"
import { redactSensitiveText } from "@jobcopilot/shared"
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
    acceptedEventSequence: "8", acceptedEventCausationId: null,
    acceptedPayload: { inputId: "steer-a", clientMessageId: redactSensitiveText("client-a"), delivery: "steer", source: "user", disposition: "user_statement" },
    acceptedItemId: "message-a", acceptedItemType: "user_message", acceptedItemTaskId: null, acceptedItemStatus: "completed",
    acceptedItemStepId: null,
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

  it("accepts an exact redacted UUID and phone-shaped client ID projection while preserving the raw item ID", async () => {
    const id = "00004912-9422-5000-8000-000000000001", clientMessageId = "4912-9422-1234"
    readState.mockResolvedValue({ unresolvedInputs: [{ id }], resolvedInputIds: [] })
    for (const inputId of [id, redactSensitiveText(id)]) {
      const fake = fakeClient([acceptedRow({
        id, clientMessageId,
        acceptedPayload: { inputId, clientMessageId: redactSensitiveText(clientMessageId), delivery: "steer", source: "user", disposition: "user_statement" },
        acceptedItemContent: { clientMessageId, disposition: "user_statement", source: "user", parts },
      })])

      await expect(loadUnresolvedSteeringContext(fake.client, scope, mapInput, message => new Error(message)))
        .resolves.toMatchObject([{ id, clientMessageId }])
    }
  })

  it.each([
    ["caller projection", { acceptedPayload: { inputId: "steer-a", clientMessageId: "different", delivery: "steer", source: "user", disposition: "user_statement" } }],
    ["redacted non-UUID input ID", { acceptedPayload: { inputId: "[REDACTED_PHONE]", clientMessageId: redactSensitiveText("client-a"), delivery: "steer", source: "user", disposition: "user_statement" } }],
    ["event causation", { acceptedEventCausationId: "other-event" }],
    ["event task scope", { acceptedTaskId: "root-a" }],
    ["accepted item task scope", { acceptedItemTaskId: "child-a" }],
    ["item Step scope", { acceptedItemStepId: "step-a" }],
  ])("fails closed when accepted provenance has a mismatched %s", async (_label, patch) => {
    readState.mockResolvedValue({ unresolvedInputs: [{ id: "steer-a" }], resolvedInputIds: [] })
    const fake = fakeClient([acceptedRow(patch)])

    await expect(loadUnresolvedSteeringContext(fake.client, scope, mapInput, message => new Error(message)))
      .rejects.toThrow("Accepted user steering provenance is invalid")
  })

  it("fails closed when accepted input sequences are duplicated", async () => {
    readState.mockResolvedValue({ unresolvedInputs: [{ id: "steer-a" }, { id: "steer-b" }], resolvedInputIds: [] })
    const fake = fakeClient([acceptedRow(), acceptedRow({ id: "steer-b", clientMessageId: "client-b", acceptedPayload: {
      inputId: "steer-b", clientMessageId: "client-b", delivery: "steer", source: "user", disposition: "user_statement",
    }, acceptedItemContent: { clientMessageId: "client-b", disposition: "user_statement", source: "user", parts } })])

    await expect(loadUnresolvedSteeringContext(fake.client, scope, mapInput, message => new Error(message)))
      .rejects.toThrow("Unresolved steering input sequence is ambiguous")
  })
})
