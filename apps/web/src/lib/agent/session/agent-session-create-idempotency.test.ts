import { describe, expect, it, vi } from "vitest"
import { AgentSessionIdempotencyConflictError, createIdempotentAgentSession } from "./agent-session-create-idempotency"

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

  it("fails closed when the database client lacks atomic create or lookup methods", async () => {
    await expect(createIdempotentAgentSession({ create: vi.fn() }, input)).rejects.toThrow("does not support idempotent creation")
  })

  it("rejects an unbounded or malformed key before database calls", async () => {
    const client = delegate()

    await expect(createIdempotentAgentSession(client, { ...input, idempotencyKey: "x".repeat(129) })).rejects.toThrow("1 to 128")
    expect(client.createMany).not.toHaveBeenCalled()
  })
})
