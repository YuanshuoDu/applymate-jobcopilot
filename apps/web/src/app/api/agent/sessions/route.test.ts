import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { taskRecoveryAccountScope } from "@/lib/agent/control-plane/commands/objective-start-attempt-read-model"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  findUnique: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentSession: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
      create: mocks.create,
      createMany: mocks.createMany,
      findUnique: mocks.findUnique,
    },
  },
}))

function getRequest() {
  return new Request("http://localhost/api/agent/sessions")
}

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("agent sessions API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findMany.mockReset()
    mocks.findFirst.mockReset()
    mocks.updateMany.mockReset()
    mocks.create.mockReset()
    mocks.createMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.findUnique.mockReset().mockResolvedValue(null)
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.findMany.mockResolvedValue([])
    mocks.updateMany.mockResolvedValue({ count: 0 })
    mocks.findFirst.mockResolvedValue(null)
  })

  it("lists sessions and exempts only explicit pending chats from stale cleanup", async () => {
    const rows = [
      {
        id: "session_1",
        goal: "Apply to Berlin SWE roles",
        status: "running",
        source: "chat",
        memorySummary: "Berlin SWE, 85+, approval required",
        qualityScore: 87,
        currentTaskId: "task_1",
        createdAt: new Date("2026-06-18T08:00:00Z"),
        updatedAt: new Date("2026-06-18T08:03:00Z"),
        completedAt: null,
        userId: "user_1",
        eventSequence: BigInt(12),
        internalTraceId: "must-not-leak",
      },
    ]
    mocks.findMany.mockResolvedValueOnce(rows)
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      sessions: [
        {
          id: "session_1",
          goal: "Apply to Berlin SWE roles",
          status: "running",
          source: "chat",
          memorySummary: "Berlin SWE, 85+, approval required",
          qualityScore: 87,
          currentTaskId: "task_1",
          createdAt: "2026-06-18T08:00:00.000Z",
          updatedAt: "2026-06-18T08:03:00.000Z",
          completedAt: null,
        },
      ],
      lastOpenedSessionId: "session_1",
    })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        OR: [
          { source: { not: "automation" } },
          { source: "automation", automation: { isNot: null } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        goal: true,
        status: true,
        source: true,
        memorySummary: true,
        qualityScore: true,
        currentTaskId: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
      },
    })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        lastViewedAt: { not: null },
        OR: [
          { source: { not: "automation" } },
          { source: "automation", automation: { isNot: null } },
        ],
      },
      orderBy: { lastViewedAt: "desc" },
      select: { id: true },
    })
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        source: "chat",
        status: "running",
        updatedAt: { lt: expect.any(Date) },
        approvals: { none: { status: "pending" } },
        tasks: { none: { status: { in: ["queued", "running", "retrying", "waiting_for_user"] } } },
        turns: { none: {} },
        OR: [{ creationIdempotencyKey: null }, { tasks: { some: {} } }],
      },
      data: { status: "completed", completedAt: expect.any(Date) },
    })
    const cleanup = mocks.updateMany.mock.calls[0]?.[0] as unknown as {
      where: { updatedAt: { lt: Date } }
      data: { completedAt: Date }
    }
    expect(cleanup.where.updatedAt.lt.getTime()).toBe(cleanup.data.completedAt.getTime() - 30 * 60 * 1000)
  }, 20_000)

  it("returns the last viewed owned session even when a different conversation updated more recently", async () => {
    mocks.findMany.mockResolvedValueOnce([
      {
        id: "session_recent", goal: "Recently updated", status: "completed", source: "chat", memorySummary: "",
        qualityScore: null, currentTaskId: null, createdAt: new Date("2026-06-18T08:00:00Z"), updatedAt: new Date("2026-06-18T09:00:00Z"), completedAt: new Date("2026-06-18T09:00:00Z"),
      },
      {
        id: "session_last_opened", goal: "Resume this conversation", status: "completed", source: "chat", memorySummary: "",
        qualityScore: null, currentTaskId: null, createdAt: new Date("2026-06-18T07:00:00Z"), updatedAt: new Date("2026-06-18T08:00:00Z"), completedAt: new Date("2026-06-18T08:00:00Z"),
      },
    ])
    mocks.findFirst.mockResolvedValueOnce({ id: "session_last_opened" })
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ lastOpenedSessionId: "session_last_opened" })
  })

  it("creates a chat session with trimmed goal text", async () => {
    mocks.create.mockResolvedValueOnce({
      id: "session_1",
      userId: "user_1",
      goal: "Create Berlin SWE automation",
      status: "running",
      source: "chat",
      memorySummary: "",
      qualityScore: null,
      currentTaskId: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:00:00Z"),
      completedAt: null,
      eventSequence: BigInt(1),
      internalTraceId: "must-not-leak",
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest({ goal: "  Create Berlin SWE automation  " }) as never)

    expect(res.status).toBe(201)
    expect(res.headers.get("X-Account-Scope")).toBeNull()
    await expect(res.json()).resolves.toEqual({
      session: {
        id: "session_1",
        goal: "Create Berlin SWE automation",
        source: "chat",
        status: "running",
        memorySummary: "",
        qualityScore: null,
        currentTaskId: null,
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:00:00.000Z",
        completedAt: null,
      },
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Create Berlin SWE automation",
        source: "chat",
        status: "running",
        memorySummary: "",
      },
    })
  })

  it("creates a keyed recoverable session only for the authenticated account scope and echoes that scope", async () => {
    const scope = taskRecoveryAccountScope("user_1")
    const requestHash = createHash("sha256").update(JSON.stringify({
      userId: "user_1", goal: "Create a task", source: "chat", status: "running", memorySummary: "",
    })).digest("hex")
    mocks.createMany.mockResolvedValueOnce({ count: 1 })
    mocks.findUnique.mockResolvedValueOnce({
      id: "session_1", goal: "Create a task", status: "running", source: "chat", memorySummary: "",
      qualityScore: null, currentTaskId: null, createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:00:00Z"), completedAt: null,
      creationIdempotencyRequestHash: requestHash,
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest({ goal: "Create a task" }, {
      "Idempotency-Key": "recoverable-create-1", "X-Expected-Account-Scope": scope,
    }) as never)

    expect(res.status).toBe(201)
    expect(res.headers.get("X-Account-Scope")).toBe(scope)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user_1", goal: "Create a task", creationIdempotencyKey: "recoverable-create-1" }),
      skipDuplicates: true,
    })
  })

  it("rejects an account scope mismatch before session creation", async () => {
    const { POST } = await import("./route")
    const res = await POST(postRequest({ goal: "Create a task" }, { "X-Expected-Account-Scope": "b".repeat(64) }) as never)

    expect(res.status).toBe(409)
    expect(res.headers.get("X-Account-Scope")).toBe(taskRecoveryAccountScope("user_1"))
    await expect(res.json()).resolves.toEqual({ error: "Task recovery account scope changed" })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.createMany).not.toHaveBeenCalled()
  })

  it("rejects session creation without a goal", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest({ goal: "   " }) as never)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "Session goal is required" })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("rejects an oversized session idempotency key before writing", async () => {
    const { POST } = await import("./route")
    const res = await POST(postRequest({ goal: "Create a task" }, { "Idempotency-Key": "x".repeat(129) }) as never)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "Idempotency-Key must contain 1 to 128 visible ASCII characters" })
    expect(mocks.createMany).not.toHaveBeenCalled()
  })

  it("returns conflict when an authenticated key is reused with a different request", async () => {
    mocks.createMany.mockResolvedValueOnce({ count: 0 })
    mocks.findUnique.mockResolvedValueOnce({ creationIdempotencyRequestHash: "different-request" })
    const { POST } = await import("./route")

    const res = await POST(postRequest({ goal: "Create a task" }, { "Idempotency-Key": "attempt-1" }) as never)

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Idempotency-Key was already used for a different session request" })
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user_1", goal: "Create a task", creationIdempotencyKey: "attempt-1" }),
      skipDuplicates: true,
    })
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { userId_creationIdempotencyKey: { userId: "user_1", creationIdempotencyKey: "attempt-1" } },
    })
  })

  it("returns auth errors without querying sessions", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never)

    expect(res.status).toBe(401)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
