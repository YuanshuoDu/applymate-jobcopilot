import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SELECTED_JOB_BATCH_PREPARATION_INTENT, VERIFIED_SHORTLIST_SELECTION_SCHEMA } from "@jobcopilot/agent-protocol"
import { GET } from "./route"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), sessionFindFirst: vi.fn(), turnFindMany: vi.fn(), turnFindFirst: vi.fn(), dbTurnFindFirst: vi.fn(), inputCount: vi.fn(),
  transaction: vi.fn(), queryRaw: vi.fn(), locationScope: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/agent/session/active-turn-location-scope", () => ({ readActiveTurnLocationScope: mocks.locationScope }))

vi.mock("@/lib/db", () => ({ db: { agentSession: { findFirst: mocks.sessionFindFirst }, agentTurn: { findMany: mocks.turnFindMany, findFirst: mocks.dbTurnFindFirst }, agentInput: { count: mocks.inputCount }, $transaction: mocks.transaction } }))

const params = { params: Promise.resolve({ id: "session_1" }) }

function request(path = "") {
  return new Request(`http://localhost/api/agent/sessions/session_1/turns${path}`)
}

function turn(id: string, index: number, status = "completed", goal = `Goal ${index}`) {
  return {
    id, sessionId: "session_1", source: "user", status, revision: index, input: { goal, content: [{ type: "text", text: "PRIVATE_CONTEXT" }] },
    createdAt: new Date(`2026-08-31T01:${String(index).padStart(2, "0")}:00.000Z`), updatedAt: new Date(`2026-08-31T01:${String(index).padStart(2, "0")}:01.000Z`), completedAt: new Date(`2026-08-31T01:${String(index).padStart(2, "0")}:01.000Z`),
    steps: [], items: [],
  }
}

describe("agent turns query API", () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.stubEnv("AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED", "1")
    mocks.requireAuth.mockReset(); mocks.sessionFindFirst.mockReset(); mocks.turnFindMany.mockReset(); mocks.turnFindFirst.mockReset(); mocks.dbTurnFindFirst.mockReset(); mocks.inputCount.mockReset()
    mocks.transaction.mockReset().mockImplementation((callback: (tx: unknown) => unknown) => callback({ $queryRaw: mocks.queryRaw, agentTurn: { findFirst: mocks.turnFindFirst } }))
    mocks.queryRaw.mockReset().mockResolvedValue([])
    mocks.locationScope.mockReset().mockResolvedValue(null)
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.turnFindMany.mockResolvedValue([turn("turn_1", 1)])
    mocks.turnFindFirst.mockResolvedValue({ ...turn("turn_2", 2, "in_progress", "Current objective Bearer secret-token-123"), revision: 3 })
    mocks.inputCount.mockResolvedValue(2)
  })

  it("projects the owned active Turn goal independently of the chronological page", async () => {
    const response = await GET(request("?limit=1") as never, params)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      schemaVersion: "agent-harness.v2",
      turns: [{ id: "turn_1", goal: "Goal 1", activeStepId: null, finalItemId: null }],
      projection: { activeTurnId: "turn_2", activeTurn: { id: "turn_2", goal: "Current objective Bearer [REDACTED]", status: "in_progress", revision: 3 }, queuedInputCount: 2 },
    })
    expect(JSON.stringify(body)).not.toContain("PRIVATE_CONTEXT")
    expect(mocks.turnFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", userId: "user_1" }, take: 2,
      select: expect.objectContaining({ executionMode: true, input: true }),
    }))
    expect(mocks.turnFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", userId: "user_1", status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] } },
      select: expect.objectContaining({ input: true, executionMode: true, rootTaskId: true }),
    }))
    expect(mocks.inputCount).toHaveBeenCalledWith({ where: { sessionId: "session_1", userId: "user_1", status: "accepted", delivery: "follow_up" } })
  })

  it("projects the active batch marker independently when its Turn is beyond the chronological page", async () => {
    const goal = "Prepare draft materials for the selected Jobs from the verified shortlist. Do not submit applications."
    const binding = {
      schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA,
      source: { sessionId: "session_1", sourceTurnId: "private_source_turn", rootTaskId: "private_source_root",
        graphItemId: "private_source_graph", graphRevision: 3 },
      selectedJobIds: ["private_job_1", "private_job_2"],
    }
    const activeBatch = {
      ...turn("batch_turn", 2, "in_progress", goal), executionMode: "canonical_task_graph", rootTaskId: null,
      input: { clientMessageId: "message_1", goal, content: [{ type: "text", text: goal }],
        intent: SELECTED_JOB_BATCH_PREPARATION_INTENT, verifiedShortlistSelection: binding },
    }
    mocks.turnFindMany.mockResolvedValueOnce([turn("old_turn", 1)])
    mocks.turnFindFirst.mockResolvedValueOnce(activeBatch)

    const response = await GET(request("?limit=1") as never, params)
    const body = await response.json()
    expect(body.turns).toEqual([expect.objectContaining({ id: "old_turn" })])
    expect(body.turns[0]).not.toHaveProperty("selectedJobBatchPreparation")
    expect(body.projection.activeTurn).toMatchObject({ id: "batch_turn", selectedJobBatchPreparation: true })
    for (const privateValue of ["private_source_turn", "private_source_root", "private_source_graph", "private_job_1"]) {
      expect(JSON.stringify(body)).not.toContain(privateValue)
    }
  })

  it("exposes location steering only for an enabled canonical user TaskGraph Turn", async () => {
    const eligible = {
      ...turn("turn_2", 2, "in_progress"), executionMode: "canonical_task_graph", rootTaskId: "root_2",
      input: { goal: "Goal", intent: { kind: "objective_task_graph_execution", version: 1 } },
    }
    for (const row of [eligible, { ...eligible, status: "waiting_for_dependency" }]) {
      mocks.turnFindFirst.mockResolvedValueOnce(row)
      const response = await GET(request() as never, params)
      expect((await response.json()).projection.activeTurn.canSteerLocation).toBe(true)
    }
    const ineligible = [
      { ...eligible, source: "automation" },
      { ...eligible, status: "waiting_for_approval" },
      { ...eligible, executionMode: "legacy" },
      { ...eligible, rootTaskId: "  " },
      { ...eligible, input: { intent: { kind: "objective_task_graph_execution", version: 2 } } },
      { ...eligible, input: { intent: { kind: "objective_task_graph_execution", version: 1, extra: true } } },
    ]
    for (const row of ineligible) {
      mocks.turnFindFirst.mockResolvedValueOnce(row)
      const response = await GET(request() as never, params)
      expect((await response.json()).projection.activeTurn).not.toHaveProperty("canSteerLocation")
    }
  })

  it("returns only the durable safe location projection from one owner-scoped repeatable snapshot", async () => {
    const active = { ...turn("turn_2", 2, "in_progress"), executionMode: "canonical_task_graph", rootTaskId: "root_2",
      input: { intent: { kind: "objective_task_graph_execution", version: 1 } } }
    mocks.turnFindFirst.mockResolvedValueOnce(active)
    mocks.locationScope.mockResolvedValueOnce({ confirmed: { locations: ["dublin"], status: "pending" }, appliedLocations: ["berlin"] })
    const response = await GET(request() as never, params)
    const body = await response.json()
    expect(body.projection.activeTurn.locationScope).toEqual({
      confirmed: { locations: ["dublin"], status: "pending" }, appliedLocations: ["berlin"],
    })
    expect(mocks.turnFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: "session_1", userId: "user_1", status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] } } }))
    expect(mocks.dbTurnFindFirst).not.toHaveBeenCalled()
    expect(mocks.locationScope).toHaveBeenCalledWith(expect.anything(), {
      userId: "user_1", sessionId: "session_1", turnId: "turn_2", rootTaskId: "root_2",
    })
    expect(mocks.transaction.mock.calls[0]?.[1]).toMatchObject({ isolationLevel: "RepeatableRead" })
    expect(JSON.stringify(body)).not.toMatch(/inputId|receiptSequence|stepId|rootTaskId/)
  })

  it("reads the active Turn in the repeatable snapshot and does not reuse location scope when no Turn is active", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce(null)
    mocks.locationScope.mockResolvedValueOnce({ confirmed: { locations: ["dublin"], status: "adopted" }, appliedLocations: ["dublin"] })
    const response = await GET(request() as never, params)
    const body = await response.json()
    expect(body.projection).toMatchObject({ activeTurnId: null, activeTurn: null })
    expect(mocks.turnFindFirst).toHaveBeenCalledTimes(1)
    expect(mocks.dbTurnFindFirst).not.toHaveBeenCalled()
    expect(mocks.locationScope).not.toHaveBeenCalled()
    expect(mocks.transaction.mock.calls[0]?.[1]).toMatchObject({ isolationLevel: "RepeatableRead" })
  })
  it("hides location steering when the server feature flag is off", async () => {
    vi.stubEnv("AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED", "0")
    mocks.turnFindFirst.mockResolvedValueOnce({
      ...turn("turn_2", 2, "in_progress"), executionMode: "canonical_task_graph", rootTaskId: "root_2",
      input: { intent: { kind: "objective_task_graph_execution", version: 1 } },
    })
    const response = await GET(request() as never, params)
    expect((await response.json()).projection.activeTurn).not.toHaveProperty("canSteerLocation")
  })

  it("omits a missing active goal without fabricating a substitute or dropping controls", async () => {
    mocks.turnFindMany.mockResolvedValueOnce([])
    mocks.turnFindFirst.mockResolvedValueOnce({ ...turn("turn_2", 2, "in_progress"), input: { content: [{ type: "text", text: "PRIVATE_CONTEXT" }] } })
    const response = await GET(request("?limit=1") as never, params)
    const body = await response.json()
    expect(body.projection.activeTurn).toEqual({ id: "turn_2", status: "in_progress", revision: 2 })
    expect(JSON.stringify(body)).not.toContain("Process agent task")
    expect(JSON.stringify(body)).not.toContain("PRIVATE_CONTEXT")
  })

  it("keeps a listed active Turn out of the objective projection when its goal is missing or malformed", async () => {
    const inputs = [
      { content: [{ type: "text", text: "PRIVATE_CONTEXT" }] },
      { goal: 42, content: [{ type: "text", text: "PRIVATE_CONTEXT" }] },
    ]
    for (const input of inputs) {
      const active = { ...turn("turn_2", 2, "in_progress"), input }
      mocks.turnFindMany.mockResolvedValueOnce([active])
      mocks.turnFindFirst.mockResolvedValueOnce(active)
      const response = await GET(request("?limit=1") as never, params)
      const body = await response.json()
      expect(body.turns).toMatchObject([{ id: "turn_2", goal: "Process agent task" }])
      expect(body.projection.activeTurn).toEqual({ id: "turn_2", status: "in_progress", revision: 2 })
      expect(JSON.stringify(body)).not.toContain("PRIVATE_CONTEXT")
    }
  })

  it("omits blank or malformed active goals", async () => {
    for (const goal of ["   ", 42, { value: "not a canonical goal" }]) {
      mocks.turnFindMany.mockResolvedValueOnce([])
      mocks.turnFindFirst.mockResolvedValueOnce({ ...turn("turn_2", 2, "in_progress"), input: { goal } })
      const response = await GET(request("?limit=1") as never, params)
      const body = await response.json()
      expect(body.projection.activeTurn).toEqual({ id: "turn_2", status: "in_progress", revision: 2 })
    }
  })

  it("returns 404 for a foreign session and does not read turn state", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const response = await GET(request() as never, params)
    expect(response.status).toBe(404)
    expect(mocks.turnFindMany).not.toHaveBeenCalled()
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.inputCount).not.toHaveBeenCalled()
  })

  it("rejects invalid cursors before database access", async () => {
    const response = await GET(request("?cursor=invalid") as never, params)
    expect(response.status).toBe(400)
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
  })
})
