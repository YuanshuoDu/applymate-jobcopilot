import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), sessionFindFirst: vi.fn(), taskFindMany: vi.fn(), graphFindFirst: vi.fn(), graphFindMany: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {
  agentSession: { findFirst: mocks.sessionFindFirst }, subAgentTask: { findMany: mocks.taskFindMany }, agentItem: { findFirst: mocks.graphFindFirst, findMany: mocks.graphFindMany },
} }))

const params = { params: Promise.resolve({ id: "session_1" }) }

function request(path = "") {
  return new Request(`http://localhost/api/agent/sessions/session_1/tasks${path}`)
}

describe("agent task query API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset(); mocks.sessionFindFirst.mockReset(); mocks.taskFindMany.mockReset(); mocks.graphFindFirst.mockReset(); mocks.graphFindMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.graphFindFirst.mockResolvedValue(null)
    mocks.graphFindMany.mockResolvedValue([])
    mocks.taskFindMany.mockResolvedValue([{
      id: "task_1", sessionId: "session_1", role: "scout", taskType: "job_search", status: "passed", goal: "Find EU roles",
      confidence: 0.95, failureReason: null, result: { jobs: [{ id: "job_1" }], resumeText: "private" },
      createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }])
  })

  it("returns a safe task tree DTO without raw result/context", async () => {
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      tasks: [{ id: "task_1", role: "scout", hasResult: true }], page: { hasMore: false, nextCursor: null },
    })
    expect(body.tasks[0]).not.toHaveProperty("result")
    expect(body.tasks[0]).not.toHaveProperty("context")
  })

  it("projects durable completed status to the legacy passed UI status", async () => {
    mocks.taskFindMany.mockResolvedValueOnce([{
      id: "task_2", sessionId: "session_1", role: "scout", taskType: "job_search", status: "completed", goal: "Find EU roles",
      confidence: 1, failureReason: null, result: { jobs: [] },
      createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }])
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect((await response.json()).tasks[0].status).toBe("passed")
  })

  it("uses the authenticated owner guard and supports bounded pagination", async () => {
    const { GET } = await import("./route")
    const response = await GET(request("?limit=10") as never, params)
    expect(response.status).toBe(200)
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 11 }))
  })

  it("loads only a bounded referenced task set inside the owned session", async () => {
    const { GET } = await import("./route")
    const response = await GET(request("?taskId=task_1&taskId=task_2") as never, params)

    expect(response.status).toBe(200)
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", id: { in: ["task_1", "task_2"] } },
      take: 2,
    }))
    expect(await response.json()).toMatchObject({ tasks: [{ id: "task_1" }], page: { hasMore: false, nextCursor: null } })
  })

  it("returns the shared safe Plan Ledger only for the current persisted graph revision", async () => {
    const graph = {
      schemaVersion: "agent-harness.v2.task-graph",
      nodes: [{ key: "scout", templateId: "scout", goal: "Find EU roles", successCriteria: ["Collect evidence"], dependsOn: [], depth: 1, taskId: "child_1" }],
    }
    mocks.graphFindFirst.mockResolvedValueOnce({ id: "graph_1", sessionId: "session_1", turnId: "turn_1", taskId: "root_1", revision: 2, content: graph })
    mocks.taskFindMany.mockResolvedValueOnce([{
      id: "root_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: null, path: "root",
      role: "orchestrator", taskType: "root", status: "running", goal: "Review EU roles", confidence: null,
      failureReason: null, result: null, createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }, {
      id: "child_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "root_1", path: "0",
      role: "scout", taskType: "scout", status: "completed", goal: "Find EU roles", confidence: null,
      failureReason: null, result: {
        status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: "private-final", finalText: "PRIVATE_MODEL_TEXT",
        structuredResult: {
          schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", summary: "private summary",
          candidates: [{ jobId: "private-job", source: "greenhouse", url: "https://private.example", evidenceIds: ["private-evidence"] }],
          evidence: [{ id: "private-evidence", kind: "job", ref: "private-job", source: "greenhouse" }],
        },
      }, createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }])
    const { GET } = await import("./route")
    const response = await GET(request("?taskId=root_1&taskId=child_1&graphItemId=graph_1&graphTurnId=turn_1&rootTaskId=root_1&graphRevision=2") as never, params)
    const body = await response.json()

    expect(mocks.graphFindFirst).toHaveBeenCalledWith({
      where: { id: "graph_1", sessionId: "session_1", type: "task_graph" },
      select: { id: true, sessionId: true, turnId: true, taskId: true, revision: true, content: true },
    })
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", id: { in: ["root_1", "child_1"] } },
    }))
    expect(body.planLedger).toMatchObject({
      identity: { sessionId: "session_1", graphItemId: "graph_1", turnId: "turn_1", rootTaskId: "root_1", revision: 2 },
      projection: {
      schemaVersion: "agent-harness.v2.plan-ledger", sessionId: "session_1", revision: 2,
      nodes: [{ key: "scout", status: "completed", evidencePreview: { summary: "Scout completed: 1 candidate; 1 linked evidence item." } }],
      },
    })
    const serialized = JSON.stringify(body.planLedger)
    for (const secret of ["child_1", "private-job", "private-evidence", "private-final", "private.example", "PRIVATE_MODEL_TEXT"]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("selects the requested persisted root when two same-session graphs share a revision", async () => {
    const persistedGraphs = [
      {
        id: "graph_old", sessionId: "session_1", turnId: "turn_old", taskId: "root_old", revision: 1,
        content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [
          { key: "old", templateId: "scout", goal: "Old snapshot", successCriteria: ["criterion"], dependsOn: [], depth: 1, taskId: "child_old" },
        ] },
      },
      {
        id: "graph_new", sessionId: "session_1", turnId: "turn_new", taskId: "root_new", revision: 1,
        content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [
          { key: "new", templateId: "scout", goal: "NEW_ROOT_SECRET", successCriteria: ["criterion"], dependsOn: [], depth: 1, taskId: "child_new" },
        ] },
      },
    ]
    mocks.graphFindFirst.mockImplementationOnce((query) => Promise.resolve(
      persistedGraphs.find(graph => graph.id === query.where.id) ?? persistedGraphs[1],
    ))
    mocks.taskFindMany.mockResolvedValueOnce([{
      id: "root_old", sessionId: "session_1", turnId: "turn_old", rootTaskId: "root_old", parentTaskId: null, path: "root",
      role: "orchestrator", taskType: "root", status: "running", goal: "OLD_ROOT_PLAN", confidence: null,
      failureReason: null, result: null, createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }, {
      id: "child_old", sessionId: "session_1", turnId: "turn_old", rootTaskId: "root_old", parentTaskId: "root_old", path: "0",
      role: "scout", taskType: "scout", status: "queued", goal: "OLD_CHILD_PLAN", confidence: null,
      failureReason: null, result: null, createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }])
    const { GET } = await import("./route")
    const response = await GET(request("?taskId=root_old&taskId=child_old&graphItemId=graph_old&graphTurnId=turn_old&rootTaskId=root_old&graphRevision=1") as never, params)
    const body = await response.json()

    expect(mocks.graphFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "graph_old", sessionId: "session_1", type: "task_graph" },
    }))
    expect(body.planLedger.identity).toMatchObject({ graphItemId: "graph_old", turnId: "turn_old", rootTaskId: "root_old", revision: 1 })
    expect(body.planLedger.projection.goal).toBe("OLD_ROOT_PLAN")
    expect(body.planLedger.projection.nodes[0].goal).toBe("OLD_CHILD_PLAN")
    expect(JSON.stringify(body)).not.toContain("NEW_ROOT_SECRET")
  })

  it("resolves a legacy query only from its unique matching revision and task set", async () => {
    const persistedGraphs = [{
      id: "graph_old", sessionId: "session_1", turnId: "turn_old", taskId: "root_old", revision: 1,
      content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [
        { key: "old", templateId: "scout", goal: "Old snapshot", successCriteria: ["criterion"], dependsOn: [], depth: 1, taskId: "child_old" },
      ] },
    }]
    mocks.graphFindMany.mockResolvedValueOnce(persistedGraphs)
    mocks.taskFindMany.mockResolvedValueOnce([{
      id: "root_old", sessionId: "session_1", turnId: "turn_old", rootTaskId: "root_old", parentTaskId: null, path: "root",
      role: "orchestrator", taskType: "root", status: "running", goal: "OLD_ROOT_PLAN", confidence: null,
      failureReason: null, result: null, createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }, {
      id: "child_old", sessionId: "session_1", turnId: "turn_old", rootTaskId: "root_old", parentTaskId: "root_old", path: "0",
      role: "scout", taskType: "scout", status: "queued", goal: "OLD_CHILD_PLAN", confidence: null,
      failureReason: null, result: null, createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }])
    const { GET } = await import("./route")
    const response = await GET(request("?taskId=root_old&taskId=child_old&graphRevision=1") as never, params)
    const body = await response.json()

    expect(mocks.graphFindMany).toHaveBeenCalledWith({
      where: { sessionId: "session_1", type: "task_graph", revision: 1 },
      select: { id: true, sessionId: true, turnId: true, taskId: true, revision: true, content: true },
      take: 2,
    })
    expect(mocks.graphFindFirst).not.toHaveBeenCalled()
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", turnId: "turn_old", rootTaskId: "root_old", id: { in: ["root_old", "child_old"] } },
    }))
    expect(body.planLedger.identity).toMatchObject({ graphItemId: "graph_old", turnId: "turn_old", rootTaskId: "root_old", revision: 1 })
    expect(body.planLedger.projection.goal).toBe("OLD_ROOT_PLAN")
  })

  it("rejects a legacy query when two same-revision graphs exist even if only one task set matches", async () => {
    mocks.graphFindMany.mockResolvedValueOnce([
      {
        id: "graph_old", sessionId: "session_1", turnId: "turn_old", taskId: "root_old", revision: 1,
        content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [
          { key: "old", templateId: "scout", goal: "Old snapshot", successCriteria: ["criterion"], dependsOn: [], depth: 1, taskId: "child_old" },
        ] },
      },
      {
        id: "graph_new", sessionId: "session_1", turnId: "turn_new", taskId: "root_new", revision: 1,
        content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [
          { key: "new", templateId: "scout", goal: "NEW_ROOT_SECRET", successCriteria: ["criterion"], dependsOn: [], depth: 1, taskId: "child_new" },
        ] },
      },
    ])
    const { GET } = await import("./route")
    const response = await GET(request("?taskId=root_old&taskId=child_old&graphRevision=1") as never, params)

    expect(response.status).toBe(200)
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({ tasks: [], planLedger: null, page: { hasMore: false, nextCursor: null } })
  })

  it("does not return the newer root ledger for an old equal-revision query", async () => {
    const newerGraph = {
      id: "graph_new", sessionId: "session_1", turnId: "turn_new", taskId: "root_new", revision: 1,
      content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [
        { key: "new", templateId: "scout", goal: "NEW_ROOT_SECRET", successCriteria: ["criterion"], dependsOn: [], depth: 1, taskId: "child_new" },
      ] },
    }
    mocks.graphFindFirst.mockResolvedValueOnce(newerGraph)
    const { GET } = await import("./route")
    const response = await GET(request("?taskId=root_old&taskId=child_old&graphItemId=graph_old&graphTurnId=turn_old&rootTaskId=root_old&graphRevision=1") as never, params)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.graphFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "graph_old", sessionId: "session_1", type: "task_graph" },
    }))
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
    expect(body).toMatchObject({ tasks: [], planLedger: null, page: { hasMore: false, nextCursor: null } })
    expect(JSON.stringify(body)).not.toContain("NEW_ROOT_SECRET")
  })

  it("rejects more than nine task IDs and does not query task rows", async () => {
    const { GET } = await import("./route")
    const ids = Array.from({ length: 10 }, (_, index) => `task_${index}`).map(id => `taskId=${id}`).join("&")
    const response = await GET(request(`?${ids}`) as never, params)

    expect(response.status).toBe(400)
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
  })

  it("does not look up referenced rows when the session belongs to another tenant", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")
    const response = await GET(request("?taskId=other_session_task") as never, params)

    expect(response.status).toBe(404)
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
  })

  it("returns auth errors without querying tasks", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(401)
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
  })
})
