import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), transaction: vi.fn(), sessionFindFirst: vi.fn(), parentFindFirst: vi.fn(), clock: vi.fn(),
  turnFindFirst: vi.fn(), rootFindFirst: vi.fn(), stepFindFirst: vi.fn(), waitFindMany: vi.fn(), targetFindMany: vi.fn(),
  runWithTenantContext: vi.fn(),
}))
let rootTaskStatus = "running"

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }))
vi.mock("@/lib/db/tenant-store", () => ({ runWithTenantContext: mocks.runWithTenantContext }))

const transactionClient = {
  $queryRaw: mocks.clock,
  agentSession: { findFirst: mocks.sessionFindFirst },
  subAgentTask: {
    findFirst: async (args: { where?: { id?: unknown; status?: unknown } }) => {
      if (args.where?.id !== "root_1") return mocks.parentFindFirst(args)
      const root = await mocks.rootFindFirst(args)
      const statusFilter = args.where.status
      if (typeof statusFilter === "object" && statusFilter !== null && "notIn" in statusFilter) {
        const excluded = (statusFilter as { notIn?: unknown }).notIn
        if (Array.isArray(excluded) && (excluded as unknown[]).some((status: unknown) => status === rootTaskStatus)) return null
      }
      return root
    },
    findMany: mocks.targetFindMany,
  },
  agentTurn: { findFirst: mocks.turnFindFirst },
  agentStep: { findFirst: mocks.stepFindFirst },
  agentWaitCondition: { findMany: mocks.waitFindMany },
}

const params = { params: Promise.resolve({ id: "session_1", taskId: "parent_1" }) }
const now = new Date("2026-10-27T11:00:00.000Z")
const waitDeadline = new Date("2026-10-27T12:00:00.000Z")
const targetRows = [
  { id: "child_2", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "parent_1", role: "analyst", taskType: "analysis", status: "running" },
  { id: "child_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "parent_1", role: "scout", taskType: "job_search", status: "completed" },
]

function request(search = "") {
  return new Request(`http://localhost/api/agent/sessions/session_1/tasks/parent_1/waits${search}`) as never
}

function currentWait(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user_1", sessionId: "session_1", turnId: "turn_1", parentTaskId: "parent_1", stepId: "step_1",
    targetTaskIds: ["child_2", "child_1"], matchedTaskIds: [], mode: "all", status: "waiting",
    deadlineAt: waitDeadline, suspendedAt: new Date("2026-10-27T10:59:00.000Z"), consumedAt: null,
    ...overrides,
  }
}

describe("authenticated current child-wait route", () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(mocks)) mock.mockReset()
    rootTaskStatus = "running"
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.runWithTenantContext.mockImplementation(async (_userId: string, callback: () => Promise<unknown>) => await callback())
    mocks.transaction.mockImplementation(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("expected interactive transaction")
      return (callback as (client: typeof transactionClient) => Promise<unknown>)(transactionClient)
    })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1", status: "running" })
    mocks.parentFindFirst.mockResolvedValue({
      id: "parent_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "root_parent",
      attemptCount: 2, status: "waiting", leaseOwner: null, leaseExpiresAt: null, absoluteDeadlineAt: null,
    })
    mocks.clock.mockResolvedValue([{ now }])
    mocks.turnFindFirst.mockResolvedValue({ id: "turn_1" })
    mocks.rootFindFirst.mockResolvedValue({ id: "root_1" })
    mocks.stepFindFirst.mockResolvedValue({
      id: "step_1", sessionId: "session_1", turnId: "turn_1", taskId: "parent_1", attempt: 2, ordinal: 4, status: "waiting_for_tool",
    })
    mocks.waitFindMany.mockResolvedValue([currentWait()])
    mocks.targetFindMany.mockResolvedValue(targetRows)
  })

  it("returns only a current same-scope wait projection in one RepeatableRead tenant transaction", async () => {
    const { GET } = await import("./route")
    const response = await GET(request(), params)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.runWithTenantContext).toHaveBeenCalledWith("user_1", expect.any(Function))
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(body).toEqual({ wait: {
      mode: "all", status: "waiting", deadlineAt: waitDeadline.toISOString(), parentDeadlineAt: null, targets: [
        { taskId: "child_2", label: "analyst", status: "running", matched: false },
        { taskId: "child_1", label: "scout", status: "completed", matched: true },
      ],
    } })
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" })
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" }, select: { id: true, status: true },
    })
    expect(mocks.parentFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "parent_1", sessionId: "session_1" } }))
    expect(mocks.stepFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", turnId: "turn_1", taskId: "parent_1", attempt: 2 }, orderBy: { ordinal: "desc" },
    }))
    expect(mocks.waitFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", parentTaskId: "parent_1", stepId: "step_1", status: "waiting", suspendedAt: { not: null }, consumedAt: null }),
      take: 2,
    }))
    expect(mocks.waitFindMany.mock.calls[0]?.[0]).not.toHaveProperty("select.idempotencyKey")
    expect(mocks.waitFindMany.mock.calls[0]?.[0]).not.toHaveProperty("select.result")
    expect(mocks.targetFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["child_2", "child_1"] }, sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "parent_1" },
      take: 8,
    }))
    expect(mocks.targetFindMany.mock.calls[0]?.[0]).toMatchObject({
      select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, role: true, taskType: true, status: true },
    })
    for (const forbidden of ["userId", "ownerId", "sessionId", "turnId", "rootTaskId", "parentTaskId", "stepId",
      "result", "failureReason", "goal", "context", "idempotencyKey", "matchedTaskIds", "waitId"]) {
      expect(body.wait).not.toHaveProperty(forbidden)
    }
  })

  it("does not drop a wait whose own deadline has passed while the resolver has not updated it", async () => {
    mocks.waitFindMany.mockResolvedValueOnce([currentWait({ deadlineAt: new Date("2026-10-27T10:59:59.000Z") })])
    const { GET } = await import("./route")
    const response = await GET(request(), params)
    expect((await response.json()).wait).toMatchObject({ status: "waiting", deadlineAt: "2026-10-27T10:59:59.000Z" })
  })

  it("returns no projection after the parent deadline, but retains exact resolver turn/root eligibility", async () => {
    mocks.parentFindFirst.mockResolvedValueOnce({
      id: "parent_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "root_parent",
      attemptCount: 2, status: "waiting", leaseOwner: null, leaseExpiresAt: null, absoluteDeadlineAt: new Date(now.getTime() - 1),
    })
    const { GET } = await import("./route")
    expect((await (await GET(request(), params)).json()).wait).toBeNull()
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.waitFindMany).not.toHaveBeenCalled()
  })

  it.each([
    ["earlier", new Date("2026-10-27T11:30:00.000Z")],
    ["later", new Date("2026-10-27T13:00:00.000Z")],
  ] as const)("preserves the %s parent deadline separately from the persisted wait deadline", async (_label, parentDeadlineAt) => {
    mocks.parentFindFirst.mockResolvedValueOnce({
      id: "parent_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "root_parent",
      attemptCount: 2, status: "waiting", leaseOwner: null, leaseExpiresAt: null, absoluteDeadlineAt: parentDeadlineAt,
    })
    const { GET } = await import("./route")
    const response = await GET(request(), params)
    expect((await response.json()).wait).toMatchObject({
      deadlineAt: waitDeadline.toISOString(), parentDeadlineAt: parentDeadlineAt.toISOString(),
    })
  })

  it("fails closed when a non-null parent deadline is invalid", async () => {
    mocks.parentFindFirst.mockResolvedValueOnce({
      id: "parent_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "root_parent",
      attemptCount: 2, status: "waiting", leaseOwner: null, leaseExpiresAt: null, absoluteDeadlineAt: new Date(Number.NaN),
    })
    const { GET } = await import("./route")
    expect((await (await GET(request(), params)).json()).wait).toBeNull()
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.waitFindMany).not.toHaveBeenCalled()
  })

  it.each([
    ["root task", { parentTaskId: null }],
    ["stale attempt", { attemptCount: 1 }],
    ["leased parent", { leaseOwner: "worker_1" }],
    ["non-waiting parent", { status: "running" }],
  ] as const)("returns no wait for an ineligible %s", async (_label, overrides) => {
    mocks.parentFindFirst.mockResolvedValueOnce({
      id: "parent_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "root_parent",
      attemptCount: 2, status: "waiting", leaseOwner: null, leaseExpiresAt: null, absoluteDeadlineAt: null, ...overrides,
    })
    const { GET } = await import("./route")
    expect((await (await GET(request(), params)).json()).wait).toBeNull()
    expect(mocks.waitFindMany).not.toHaveBeenCalled()
  })

  it("returns no projection for a non-current step or an ambiguous wait", async () => {
    mocks.stepFindFirst.mockResolvedValueOnce({ id: "step_1", attempt: 1, ordinal: 4, status: "waiting_for_tool" })
    let { GET } = await import("./route")
    expect((await (await GET(request(), params)).json()).wait).toBeNull()

    vi.resetModules()
    mocks.stepFindFirst.mockResolvedValueOnce({ id: "step_1", sessionId: "session_1", turnId: "turn_1", taskId: "parent_1", attempt: 2, ordinal: 4, status: "waiting_for_tool" })
    mocks.waitFindMany.mockResolvedValueOnce([currentWait(), currentWait()])
    ;({ GET } = await import("./route"))
    expect((await (await GET(request(), params)).json()).wait).toBeNull()
    expect(mocks.targetFindMany).not.toHaveBeenCalled()
  })

  it.each(["aborted session", "archived session", "terminal turn", "terminal root"])("returns no projection for a %s", async (reason) => {
    if (reason === "aborted session") mocks.sessionFindFirst.mockResolvedValueOnce({ id: "session_1", status: "aborted" })
    if (reason === "archived session") mocks.sessionFindFirst.mockResolvedValueOnce({ id: "session_1", status: "archived" })
    if (reason === "terminal turn") mocks.turnFindFirst.mockResolvedValueOnce(null)
    if (reason === "terminal root") rootTaskStatus = "completed"
    const { GET } = await import("./route")
    const response = await GET(request(), params)
    expect((await response.json()).wait).toBeNull()
    expect(mocks.waitFindMany).not.toHaveBeenCalled()
    if (reason === "terminal root") {
      expect(mocks.rootFindFirst).toHaveBeenCalledWith({
        where: { id: "root_1", sessionId: "session_1", turnId: "turn_1", status: { notIn: ["completed", "failed", "interrupted", "cancelled", "closed"] } },
        select: { id: true },
      })
    }
  })

  it("fails closed on malformed, oversized, or incomplete target sets", async () => {
    mocks.waitFindMany.mockResolvedValueOnce([currentWait({ targetTaskIds: Array.from({ length: 9 }, (_, index) => `child_${index}`) })])
    const { GET } = await import("./route")
    expect((await (await GET(request(), params)).json()).wait).toBeNull()
    expect(mocks.targetFindMany).not.toHaveBeenCalled()

    vi.resetModules()
    mocks.waitFindMany.mockResolvedValueOnce([currentWait()])
    mocks.targetFindMany.mockResolvedValueOnce([targetRows[0]])
    const second = await import("./route")
    expect((await (await second.GET(request(), params)).json()).wait).toBeNull()
  })

  it("uses non-enumerating not-found, auth, query and generic server-error responses", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")
    const notFound = await GET(request(), params)
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toMatchObject({ error: { code: "session_not_found" } })
    expect(notFound.headers.get("cache-control")).toBe("private, no-store")

    mocks.requireAuth.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
    mocks.runWithTenantContext.mockClear()
    expect((await GET(request(), params)).status).toBe(401)
    expect(mocks.runWithTenantContext).not.toHaveBeenCalled()

    const invalidQuery = await GET(request("?targetTaskId=foreign"), params)
    expect(invalidQuery.status).toBe(400)
    expect(await invalidQuery.json()).toMatchObject({ error: { code: "invalid_wait_query" } })

    mocks.transaction.mockRejectedValueOnce(new Error("secret database failure"))
    const unavailable = await GET(request(), params)
    expect(unavailable.status).toBe(500)
    const body = await unavailable.json()
    expect(body).toEqual({ error: { code: "wait_projection_unavailable", message: "Wait projection is unavailable", details: {} } })
    expect(JSON.stringify(body)).not.toContain("secret database failure")
  })
})
