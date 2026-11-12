import { describe, expect, it, vi } from "vitest"
import {
  AgentSessionIdempotencyConflictError,
  createIdempotentAgentSession,
  reconcileIdempotentAgentSession,
} from "./agent-session-create-idempotency"

function delegate() {
  return {
    createMany: vi.fn(async (_args: { data: Record<string, unknown>; skipDuplicates: true }) => ({ count: 1 })),
    findUnique: vi.fn(async (): Promise<unknown> => null),
  }
}

const input = {
  userId: "user_1",
  goal: "  Apply to Berlin SWE roles  ",
  source: "chat",
  status: "running",
  memorySummary: "",
  idempotencyKey: "attempt-1",
}

function requestHash(value: unknown): string {
  if (typeof value !== "object" || value === null || !("creationIdempotencyRequestHash" in value)
    || typeof value.creationIdempotencyRequestHash !== "string") {
    throw new Error("Session idempotency result has no request hash")
  }
  return value.creationIdempotencyRequestHash
}

describe("agent session creation idempotency helper", () => {
  it("uses an atomic duplicate-safe insert and returns the existing normalized Session", async () => {
    const client = delegate()
    const existing = { id: "session_1", creationIdempotencyRequestHash: "" }
    client.createMany.mockImplementationOnce(async ({ data }: { data: Record<string, unknown>; skipDuplicates: true }) => {
      existing.creationIdempotencyRequestHash = String(data.creationIdempotencyRequestHash)
      return { count: 0 }
    })
    client.findUnique.mockResolvedValueOnce(existing)

    const session = await createIdempotentAgentSession(client, input)

    expect(session).toBe(existing)
    expect(client.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user_1",
        goal: "Apply to Berlin SWE roles",
        creationIdempotencyKey: "attempt-1",
        creationIdempotencyRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      skipDuplicates: true,
    })
    expect(client.findUnique).toHaveBeenCalledWith({
      where: { userId_creationIdempotencyKey: { userId: "user_1", creationIdempotencyKey: "attempt-1" } },
    })
  })

  it("rejects reuse of a key when its stored request hash differs", async () => {
    const client = delegate()
    client.createMany.mockResolvedValueOnce({ count: 0 })
    client.findUnique.mockResolvedValueOnce({ creationIdempotencyRequestHash: "different-request" })

    await expect(createIdempotentAgentSession(client, input)).rejects.toBeInstanceOf(AgentSessionIdempotencyConflictError)
  })

  it("keeps the original consent snapshot on replay and excludes it from the request hash", async () => {
    const client = delegate()
    let stored: Record<string, unknown> | null = null
    client.createMany.mockImplementation(async ({ data }: { data: Record<string, unknown>; skipDuplicates: true }) => {
      if (stored) return { count: 0 }
      stored = { id: "session_1", ...data }
      return { count: 1 }
    })
    client.findUnique.mockImplementation(async () => stored)

    const first = await createIdempotentAgentSession(client, {
      ...input,
      creationSnapshot: { enabled: true, version: 4 },
    })
    const replay = await createIdempotentAgentSession(client, {
      ...input,
      creationSnapshot: { enabled: false, version: 5 },
    })

    expect(first).toBe(stored)
    expect(replay).toBe(stored)
    expect(stored).toMatchObject({
      searchFootprintMemoryEnabledAtCreation: true,
      searchFootprintMemoryConsentVersionAtCreation: 4,
    })
    expect(client.createMany).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        creationIdempotencyRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        searchFootprintMemoryEnabledAtCreation: true,
        searchFootprintMemoryConsentVersionAtCreation: 4,
      }),
      skipDuplicates: true,
    })
    expect(client.createMany).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        creationIdempotencyRequestHash: requestHash(first),
        searchFootprintMemoryEnabledAtCreation: false,
        searchFootprintMemoryConsentVersionAtCreation: 5,
      }),
      skipDuplicates: true,
    })
  })

  it("fails closed when the database client lacks atomic create or lookup methods", async () => {
    await expect(createIdempotentAgentSession({ create: vi.fn() }, input)).rejects.toThrow("does not support idempotent creation")
  })

  it("rejects an unbounded or malformed key before database calls", async () => {
    const client = delegate()

    await expect(createIdempotentAgentSession(client, { ...input, idempotencyKey: "x".repeat(129) })).rejects.toThrow("1 to 128")
    expect(client.createMany).not.toHaveBeenCalled()
  })

  it("reconciles only by owner and create key under the consent transaction lock", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      user: { findUnique: vi.fn().mockResolvedValue({
        agentSearchFootprintMemoryEnabled: true,
        agentSearchFootprintMemoryConsentVersion: 4,
      }) },
      agentSession: { findUnique: vi.fn().mockResolvedValue({ id: "session_1", goal: "private goal" }) },
    }
    const client = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) }

    await expect(reconcileIdempotentAgentSession(client, "user_1", "create-key-1"))
      .resolves.toEqual({ state: "found", sessionId: "session_1" })
    expect((tx.$queryRaw.mock.calls[0]?.[0] as readonly string[]).join(" "))
      .toContain("applymate:agent-search-footprint-memory:")
    expect(tx.agentSession.findUnique).toHaveBeenCalledWith({
      where: { userId_creationIdempotencyKey: { userId: "user_1", creationIdempotencyKey: "create-key-1" } },
      select: { id: true },
    })
    expect(JSON.stringify(await reconcileIdempotentAgentSession({
      $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work({
        ...tx, agentSession: { findUnique: vi.fn().mockResolvedValue(null) },
      }),
    }, "user_1", "missing"))).toBe(JSON.stringify({ state: "unknown" }))
  })

  it("fails closed when reconciliation cannot open and verify the consent transaction", async () => {
    await expect(reconcileIdempotentAgentSession({ agentSession: { findUnique: vi.fn() } }, "user_1", "create-key-1"))
      .rejects.toThrow("interactive transaction client")
  })
})
