import { describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { InputClaimQueryClient, TurnExecutionFence } from "./input-claim-store.js"
import { readRootTaskHistorySteerEvidence } from "./root-task-history-steer-evidence.js"

const scope: TenantScope = { userId: "user-a" }
const now = new Date("2026-09-01T16:00:00.000Z")
const request = { sessionId: "session-a", turnId: "turn-a", stepId: "step-a", lease: { ownerId: "worker-a", leaseVersion: 3, now } satisfies TurnExecutionFence }
type Row = Record<string, unknown>

function input(overrides: Row = {}): Row {
  return { id: "input-a", sessionId: request.sessionId, targetTurnId: request.turnId, userId: scope.userId, clientMessageId: "client-a",
    delivery: "steer", status: "accepted", content: [{ type: "text", text: "Use Dublin roles" }], acceptedSequence: "7",
    consumedByStepId: null, consumedAt: null, cancelledAt: null, createdAt: now, ...overrides }
}
function acceptedEvent(stored: Row, overrides: Row = {}): Row {
  const id = String(stored.id), clientMessageId = String(stored.clientMessageId), delivery = String(stored.delivery)
  const disposition = "steered", itemId = `item-${id}`
  return {
    acceptedEventId: `event-${id}`, acceptedEventSessionId: request.sessionId, acceptedEventTurnId: request.turnId,
    acceptedEventItemId: itemId, acceptedTaskId: null, acceptedEventSequence: stored.acceptedSequence, acceptedType: "input.accepted",
    acceptedActor: "user", acceptedCorrelationId: request.turnId, acceptedEventCausationId: null,
    acceptedEventIdempotencyKey: `input.accepted:${id}`,
    acceptedPayload: { inputId: id, clientMessageId, delivery, disposition, source: "user" }, acceptedEventCreatedAt: now,
    acceptedItemId: itemId, acceptedItemSessionId: request.sessionId, acceptedItemTurnId: request.turnId, acceptedItemStepId: null,
    acceptedItemTaskId: null, acceptedItemType: "user_message", acceptedItemStatus: "completed",
    acceptedItemContent: { clientMessageId, disposition, parts: stored.content, source: "user" }, acceptedItemCreatedAt: now, acceptedItemUpdatedAt: now,
    ...overrides,
  }
}
function fakeClient(options: { inputs?: Row[]; events?: Row[]; turnOwned?: boolean; rootRows?: Row[]; stepRows?: Row[] } = {}) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const client = { query: vi.fn(async (sql: unknown, values: readonly unknown[] = []) => {
    const text = String(sql); calls.push({ sql: text, values })
    if (text.includes('FROM "agent_sessions"')) return { rows: [{ id: request.sessionId }] }
    if (text.includes('FROM "agent_turns"') && text.includes("FOR UPDATE")) return { rows: options.turnOwned === false ? [] : [{ id: request.turnId }] }
    if (text.includes('FROM "sub_agent_tasks"')) return { rows: options.rootRows ?? [{ id: "root-a" }] }
    if (text.includes('FROM "agent_steps"')) return { rows: options.stepRows ?? [{ id: request.stepId }] }
    if (text.includes('FROM "agent_inputs"')) return { rows: options.inputs ?? [] }
    if (text.includes('FROM "agent_events"')) return { rows: options.events ?? [] }
    throw new Error(`Unexpected SQL: ${text}`)
  }) }
  return { client: client as unknown as InputClaimQueryClient, calls }
}

async function classify(inputs: Row[] = [], events: Row[] = [], options: Parameters<typeof fakeClient>[0] = {}) {
  const fake = fakeClient({ inputs, events, ...options })
  const result = await readRootTaskHistorySteerEvidence(fake.client, scope, request)
  return { result, calls: fake.calls }
}

describe("root task history accepted-steer evidence", () => {
  it("locks the owned Session, Turn, root, and Step before bounded input reads", async () => {
    const { result, calls } = await classify()
    expect(result).toEqual({ kind: "no_accepted_steer" })
    const inputRead = calls.findIndex(call => call.sql.includes('FROM "agent_inputs"'))
    expect(inputRead).toBeGreaterThan(calls.findIndex(call => call.sql.includes('FROM "agent_steps"') && call.sql.includes("FOR UPDATE")))
    expect(calls.find(call => call.sql.includes('FROM "agent_inputs"'))?.sql).toContain('ORDER BY "acceptedSequence" ASC, "id" ASC LIMIT 65 FOR SHARE')
    expect(calls.find(call => call.sql.includes('FROM "agent_events"'))?.sql).toContain('LIMIT 65 FOR SHARE OF event')
  })

  it.each(["accepted", "queued", "consumed", "cancelled", "rejected"])("counts a valid %s steer as accepted history-changing input", async status => {
    const stored = input({ status,
      ...(status === "consumed" ? { consumedByStepId: "step-prior", consumedAt: now } : {}),
      ...(status === "cancelled" ? { cancelledAt: now } : {}),
    })
    const { result } = await classify([stored], [acceptedEvent(stored)])
    expect(result).toEqual({ kind: "accepted_steer" })
  })

  it("does not suppress history for a valid accepted non-steer input", async () => {
    const stored = input({ delivery: "follow_up" })
    const { result } = await classify([stored], [acceptedEvent(stored)])
    expect(result).toEqual({ kind: "no_accepted_steer" })
  })

  it.each([
    ["an input row without its accepted event", [input()], []],
    ["an orphan accepted event", [], [acceptedEvent(input())]],
    ["a sequence-only match with a wrong event identity", [input()], [acceptedEvent(input(), { acceptedPayload: { ...acceptedEvent(input()).acceptedPayload as object, inputId: "other-input" } })]],
    ["a mismatched accepted event sequence", [input()], [acceptedEvent(input(), { acceptedEventSequence: "8" })]],
    ["a changed accepted item part", [input()], [acceptedEvent(input(), { acceptedItemContent: { ...acceptedEvent(input()).acceptedItemContent as object, parts: [{ type: "text", text: "different" }] } })]],
    ["a duplicate input sequence", [input(), input({ id: "input-b", clientMessageId: "client-b" })], [acceptedEvent(input()), acceptedEvent(input({ id: "input-b", clientMessageId: "client-b" }))]],
    ["duplicate accepted event identity", [input(), input({ id: "input-b", clientMessageId: "client-b", acceptedSequence: "8" })],
      [acceptedEvent(input()), acceptedEvent(input({ id: "input-b", clientMessageId: "client-b", acceptedSequence: "8" }), { acceptedEventId: "event-input-a" })]],
    ["a missing accepted item", [input()], [acceptedEvent(input(), { acceptedItemContent: null, acceptedItemType: null })]],
  ])("fails closed for %s", async (_label, inputs, events) => {
    const { result } = await classify(inputs, events)
    expect(result).toEqual({ kind: "unsafe" })
  })

  it("fails closed when the bounded input evidence overflows", async () => {
    const inputs = Array.from({ length: 65 }, (_, index) => input({ id: `input-${index}`, clientMessageId: `client-${index}`, acceptedSequence: String(index + 1) }))
    const { result, calls } = await classify(inputs)
    expect(result).toEqual({ kind: "unsafe" })
    expect(calls.some(call => call.sql.includes('FROM "agent_events"'))).toBe(false)
  })

  it("fails closed when accepted-event evidence overflows", async () => {
    const inputs = Array.from({ length: 65 }, (_, index) => input({ id: `input-${index}`, clientMessageId: `client-${index}`, acceptedSequence: String(index + 1) }))
    const events = inputs.map(stored => acceptedEvent(stored))
    const { result } = await classify(inputs, events)
    expect(result).toEqual({ kind: "unsafe" })
  })

  it("does not read input evidence when the leased Turn owner fence fails", async () => {
    const fake = fakeClient({ turnOwned: false, inputs: [input()], events: [acceptedEvent(input())] })
    await expect(readRootTaskHistorySteerEvidence(fake.client, scope, request)).rejects.toMatchObject({ code: "owner_conflict" })
    expect(fake.calls.some(call => call.sql.includes('FROM "agent_inputs"'))).toBe(false)
  })
})
