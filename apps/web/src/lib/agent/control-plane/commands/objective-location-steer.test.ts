import { afterEach, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"
import { formatObjectiveLocationSteerMessage } from "@jobcopilot/agent-protocol"

const mocks = vi.hoisted(() => ({ accept: vi.fn(), append: vi.fn(), lock: vi.fn(), capacity: vi.fn() }))
vi.mock("./transaction", async () => {
  const actual = await vi.importActual<typeof import("./transaction")>("./transaction")
  return { ...actual, acceptInputFacts: mocks.accept, lockOpenSession: mocks.lock }
})
vi.mock("../../session/fact-store", () => ({ appendAgentEventWithOutboxInTransaction: mocks.append }))
vi.mock("./steering-capacity", () => ({ assertSteeringCapacity: mocks.capacity }))

import { acceptObjectiveLocationSteer } from "./objective-location-steer"

type Row = Record<string, unknown>
type Options = { userId?: string; turnRevision?: number; turnStatus?: string; rootStatus?: string; rootOwner?: string | null; existing?: boolean; failReceipt?: boolean }
const command = (locations: string[] = ["Dublin", "Berlin"], userId = "user-1", revision = 7) => ({
  schemaVersion: "agent-harness.v2.objective-location-steer.v1", clientMessageId: "client-1", expectedTurnId: "turn-1",
  expectedRevision: revision, locations, userId, sessionId: "session-1",
} satisfies Parameters<typeof acceptObjectiveLocationSteer>[1])
const locationText = formatObjectiveLocationSteerMessage

function setup(options: Options = {}) {
  const ownerId = options.userId ?? "user-1", expiry = new Date("2026-11-19T12:00:00Z")
  let inputs: Row[] = [], items: Row[] = [], events: Row[] = []
  const turn: Row = { id: "turn-1", sessionId: "session-1", userId: ownerId, source: "user", status: options.turnStatus ?? "in_progress",
    revision: options.turnRevision ?? 7, rootTaskId: "root-1", executionMode: "canonical_task_graph",
    input: { intent: { kind: "objective_task_graph_execution", version: 1 } }, leaseOwnerId: "worker-1", leaseExpiresAt: expiry }
  if (turn.status === "waiting_for_dependency") { turn.leaseOwnerId = null; turn.leaseExpiresAt = null }
  const root: Row = { id: "root-1", sessionId: "session-1", userId: ownerId, turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null,
    path: "/root-1", depth: 0, role: "orchestrator", taskType: "root", status: options.rootStatus ?? (turn.status === "waiting_for_dependency" ? "waiting" : "running"),
    interruptRequestedAt: null, leaseOwner: turn.status === "waiting_for_dependency" ? null : options.rootOwner ?? "worker-1",
    leaseExpiresAt: turn.status === "waiting_for_dependency" ? null : expiry }
  if (options.existing) {
    const parts = [{ type: "text", text: locationText(["berlin", "dublin"]) }]
    inputs.push({ id: "input-1", sessionId: "session-1", userId: ownerId, targetTurnId: "turn-1", clientMessageId: "client-1", delivery: "steer",
      status: "accepted", content: parts, acceptedSequence: BigInt(10) })
    items.push({ id: "item-1", sessionId: "session-1", turnId: "turn-1", taskId: null, stepId: null, type: "user_message", status: "completed",
      phase: "commentary", revision: 0, content: { clientMessageId: "client-1", disposition: "steered", parts, source: "user" } })
    events.push({ id: "input-event", sessionId: "session-1", turnId: "turn-1", itemId: "item-1", taskId: null, type: "input.accepted", actor: "user",
      correlationId: "turn-1", causationId: null, idempotencyKey: "agent-command:client-1", sequence: BigInt(10),
      payload: { inputId: "input-1", clientMessageId: "client-1", delivery: "steer", source: "user", disposition: "steered" } })
  }
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const q = query as { sql?: string; strings?: readonly string[] }, sql = q.sql ?? q.strings?.join(" ") ?? ""
      return sql.includes('FROM "agent_turns"') ? [turn] : sql.includes('FROM "sub_agent_tasks"') ? [root] : []
    }),
    agentInput: { findMany: vi.fn(async (args: unknown) => {
      const where = (args as { where: Row }).where
      return inputs.filter(row => row.sessionId === where.sessionId && row.clientMessageId === where.clientMessageId).slice(0, 2)
    }) },
    agentItem: { findFirst: vi.fn(async (args: unknown) => {
      const where = (args as { where: Row }).where
      return items.find(row => row.id === where.id && row.sessionId === where.sessionId && row.turnId === where.turnId) ?? null
    }) },
    agentEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: Row }).where
        return events.find(row => row.sessionId === where.sessionId && row.idempotencyKey === where.idempotencyKey) ?? null
      }),
      findMany: vi.fn(async (args: unknown) => {
        const where = (args as { where: Row }).where
        return events.filter(row => row.sessionId === where.sessionId && row.causationId === where.causationId)
      }),
    },
  }
  const db = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => {
    const before = { inputs: [...inputs], items: [...items], events: [...events] }
    try { return await work(tx) } catch (error) { inputs = before.inputs; items = before.items; events = before.events; throw error }
  }) } as unknown as PrismaClient
  mocks.lock.mockImplementation(async (_tx: unknown, _session: string, user: string) => { if (user !== ownerId) throw new Error("foreign session") })
  mocks.capacity.mockResolvedValue(undefined)
  mocks.accept.mockImplementation(async (_tx: unknown, identity: Row, parts: Row[]) => {
    const input = { id: "input-1", sessionId: String(identity.sessionId), userId: String(identity.userId), targetTurnId: "turn-1",
      clientMessageId: String(identity.clientMessageId), delivery: "steer", status: "accepted", content: parts, acceptedSequence: BigInt(10) }
    const item = { id: "item-1", sessionId: "session-1", turnId: "turn-1", taskId: null, stepId: null, type: "user_message", status: "completed",
      phase: "commentary", revision: 0, content: { clientMessageId: identity.clientMessageId, disposition: "steered", parts, source: "user" } }
    const event = { id: "input-event", sessionId: "session-1", turnId: "turn-1", itemId: "item-1", taskId: null, type: "input.accepted", actor: "user",
      correlationId: "turn-1", causationId: null, idempotencyKey: "agent-command:client-1", sequence: BigInt(10),
      payload: { inputId: input.id, clientMessageId: identity.clientMessageId, delivery: "steer", source: "user", disposition: "steered" } }
    inputs.push(input); items.push(item); events.push(event)
    return { inputId: input.id, turnId: "turn-1", sequence: "10" }
  })
  mocks.append.mockImplementation(async (_tx: unknown, value: Row) => {
    if (options.failReceipt) throw new Error("receipt outbox failed")
    const { outboxTopic: _outboxTopic, ...record } = value
    const event = { ...record, id: "receipt-event", sequence: BigInt(11) }
    events.push(event)
    return { event, duplicate: false }
  })
  return { db, tx, inputs: () => inputs, items: () => items, events: () => events }
}

afterEach(() => vi.clearAllMocks())

describe("acceptObjectiveLocationSteer", () => {
  it("accepts a canonical user steer and atomically binds its receipt to input.accepted", async () => {
    const fixture = setup()
    const result = await acceptObjectiveLocationSteer(fixture.db, command())
    expect(result).toMatchObject({ turnId: "turn-1", disposition: "steered", sequence: "10" })
    expect(fixture.events()).toHaveLength(2)
    expect(fixture.events()[1]).toMatchObject({ type: "agent.objective.locations_accepted", actor: "user", taskId: "root-1", itemId: null,
      correlationId: "turn-1", causationId: "input-event", payload: { acceptedInputSequence: 10, locations: ["berlin", "dublin"] } })
    expect(mocks.accept).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: "user" }),
      [{ type: "text", text: locationText(["berlin", "dublin"]) }], expect.anything(), "steer", "steered", false)
  })

  it("accepts a dependency-wait root only with its released lease", async () => {
    const fixture = setup({ turnStatus: "waiting_for_dependency" })
    await expect(acceptObjectiveLocationSteer(fixture.db, command())).resolves.toMatchObject({ disposition: "steered" })
  })

  it("fails closed for a foreign session owner, stale revision, or mismatched root status", async () => {
    const foreign = setup()
    await expect(acceptObjectiveLocationSteer(foreign.db, command(["Dublin"], "other-user"))).rejects.toThrow()
    expect(mocks.accept).not.toHaveBeenCalled()
    const stale = setup({ turnRevision: 8 })
    await expect(acceptObjectiveLocationSteer(stale.db, command())).rejects.toThrow()
    const wrongRoot = setup({ rootStatus: "waiting" })
    await expect(acceptObjectiveLocationSteer(wrongRoot.db, command())).rejects.toThrow()
  })

  it("rejects an unrelated duplicate input and a retry with a different revision scope", async () => {
    const unrelated = setup({ existing: true })
    unrelated.items()[0]!.content = { clientMessageId: "client-1", disposition: "started", parts: [], source: "user" }
    await expect(acceptObjectiveLocationSteer(unrelated.db, command())).rejects.toThrow()
    const scoped = setup()
    await acceptObjectiveLocationSteer(scoped.db, command())
    await expect(acceptObjectiveLocationSteer(scoped.db, command(["Berlin", "Dublin"], "user-1", 8))).rejects.toThrow()
  })

  it("replays a duplicate whose raw locations normalize to the same scope", async () => {
    const fixture = setup()
    await acceptObjectiveLocationSteer(fixture.db, command())
    const replay = await acceptObjectiveLocationSteer(fixture.db, command([" BERLIN ", "dublin"]))
    expect(replay).toMatchObject({ disposition: "duplicate", originalDisposition: "steered", sequence: "10" })
    expect(fixture.events()).toHaveLength(2)
  })

  it("rolls back the accepted input when its receipt cannot be written", async () => {
    const fixture = setup({ failReceipt: true })
    await expect(acceptObjectiveLocationSteer(fixture.db, command())).rejects.toThrow("receipt outbox failed")
    expect(fixture.inputs()).toHaveLength(0)
    expect(fixture.items()).toHaveLength(0)
    expect(fixture.events()).toHaveLength(0)
  })
})
