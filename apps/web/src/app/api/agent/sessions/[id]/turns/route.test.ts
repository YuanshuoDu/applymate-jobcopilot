import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), sessionFindFirst: vi.fn(), turnFindMany: vi.fn(), turnFindFirst: vi.fn(), inputCount: vi.fn(),
  executionFindFirst: vi.fn(), rootFindFirst: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {
  agentSession: { findFirst: mocks.sessionFindFirst },
  agentTurn: { findMany: mocks.turnFindMany, findFirst: mocks.turnFindFirst },
  agentInput: { count: mocks.inputCount },
  agentExecution: { findFirst: mocks.executionFindFirst },
  subAgentTask: { findFirst: mocks.rootFindFirst },
} }))

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

const recoveryOwner = {
  userId: "user_1", sessionId: "session_1", turnId: "blocked_turn", rootTaskId: "root_1",
  rootAttemptCount: 3, executionId: "execution_1", executionAttemptCount: 5,
}

function sourceChangeState(owner: Record<string, unknown> = recoveryOwner, markerExtras: Record<string, unknown> = {}) {
  return {
    privateExecutionState: "PRIVATE_EXECUTION_STATE",
    scheduledTaskGraphSourceChangeTerminal: {
      schemaVersion: "agent-harness.v2.scheduled-pipeline-source-change-terminal.v1",
      owner,
      ...markerExtras,
    },
  }
}

const materialDriftOwner = { ...recoveryOwner, turnLeaseOwnerId: "historical_turn_lease", turnLeaseVersion: 4 }
const materialDriftGate = { taskId: "gate_1", leaseOwnerId: "historical_gate_lease", attemptCount: 2 }
function materialDriftState(markerExtras: Record<string, unknown> = {}) {
  return {
    privateExecutionState: "PRIVATE_EXECUTION_STATE",
    scheduledTaskGraphMaterialDriftTerminal: {
      schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1",
      reason: "scheduled_prepare_material_source_changed",
      owner: materialDriftOwner,
      gate: materialDriftGate,
      analyzeFingerprintDigest: `sha256:${"a".repeat(64)}`,
      prepareProofDigest: `sha256:${"b".repeat(64)}`,
      artifactDigest: `sha256:${"c".repeat(64)}`,
      currentMaterialDigest: `sha256:${"d".repeat(64)}`,
      proofDigest: `sha256:${"e".repeat(64)}`,
      ...markerExtras,
    },
  }
}

function configureMaterialDriftRecovery(options: {
  turnStatus?: string; gateStatus?: string; activeTurn?: unknown | null; latestTurnId?: string
  executionStatus?: string; error?: string; state?: unknown; rootAttemptCount?: number; gateAttemptCount?: number
  turnOverrides?: Record<string, unknown>; gateOverrides?: Record<string, unknown>; rootOverrides?: Record<string, unknown>
} = {}) {
  const status = options.turnStatus ?? "waiting_for_dependency"
  const currentTurn = {
    ...turn("blocked_turn", 3, status), userId: "user_1", sessionId: "session_1", source: "automation",
    executionMode: "canonical_task_graph", rootTaskId: "root_1", input: { automationRunMode: "scheduled" },
    leaseVersion: 4, ...options.turnOverrides,
  }
  const activeTurn = "activeTurn" in options
    ? options.activeTurn
    : status === "waiting_for_dependency" ? currentTurn : null
  mocks.executionFindFirst.mockResolvedValue({
    id: "execution_1", userId: "user_1", sessionId: "session_1", status: options.executionStatus ?? "failed",
    error: options.error ?? "scheduled_prepare_material_source_changed", attemptCount: 5,
    state: options.state ?? materialDriftState(),
  })
  mocks.turnFindFirst.mockImplementation(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
    if ("status" in where) return activeTurn
    if (orderBy) return { ...currentTurn, id: options.latestTurnId ?? "blocked_turn" }
    if ("id" in where) return currentTurn
    return null
  })
  mocks.rootFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.id === "root_1") return {
      id: "root_1", sessionId: "session_1", turnId: "blocked_turn", rootTaskId: "root_1", parentTaskId: null,
      depth: 0, role: "orchestrator", taskType: "root", status: "waiting", attemptCount: options.rootAttemptCount ?? 3,
      ...options.rootOverrides,
    }
    if (where.id === "gate_1") return {
      id: "gate_1", sessionId: "session_1", turnId: "blocked_turn", rootTaskId: "root_1", parentTaskId: "root_1",
      depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: options.gateStatus ?? "failed",
      attemptCount: options.gateAttemptCount ?? 2, ...options.gateOverrides,
    }
    return null
  })
}

function configureSourceChangeRecovery(options: {
  turnStatus?: string
  latestTurnId?: string
  activeTurn?: unknown | null
  markerOwner?: Record<string, unknown>
  markerExtras?: Record<string, unknown>
  state?: unknown
  executionStatus?: string
  error?: string
  rootAttemptCount?: number
  turnOverrides?: Record<string, unknown>
} = {}) {
  const status = options.turnStatus ?? "waiting_for_dependency"
  const blockedTurn = {
    ...turn("blocked_turn", 3, status), source: "automation", executionMode: "canonical_task_graph",
    rootTaskId: "root_1", input: { automationRunMode: "scheduled" }, ...options.turnOverrides,
  }
  const defaultActive = status === "waiting_for_dependency" ? blockedTurn : null
  const activeTurn = "activeTurn" in options ? options.activeTurn : defaultActive
  mocks.executionFindFirst.mockResolvedValue({
    id: "execution_1", status: options.executionStatus ?? "failed",
    error: options.error ?? "scheduled_pipeline_source_changed", attemptCount: 5,
    state: options.state ?? sourceChangeState(options.markerOwner, options.markerExtras),
  })
  mocks.rootFindFirst.mockResolvedValue({ id: "root_1", attemptCount: options.rootAttemptCount ?? 3 })
  mocks.turnFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if ("status" in where) return activeTurn
    if ("id" in where) return blockedTurn
    return { id: options.latestTurnId ?? "blocked_turn" }
  })
}

describe("agent turns query API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset(); mocks.sessionFindFirst.mockReset(); mocks.turnFindMany.mockReset(); mocks.turnFindFirst.mockReset(); mocks.inputCount.mockReset()
    mocks.executionFindFirst.mockReset(); mocks.rootFindFirst.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.turnFindMany.mockResolvedValue([turn("turn_1", 1)])
    mocks.turnFindFirst.mockResolvedValue({ ...turn("turn_2", 2, "in_progress", "Current objective Bearer secret-token-123"), revision: 3 })
    mocks.inputCount.mockResolvedValue(2)
    mocks.executionFindFirst.mockResolvedValue(null)
    mocks.rootFindFirst.mockResolvedValue(null)
  })

  it("projects the owned active Turn goal independently of the chronological page", async () => {
    const { GET } = await import("./route")
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
    }))
    expect(mocks.turnFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", userId: "user_1", status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] } },
      select: expect.objectContaining({ input: true }),
    }))
    expect(mocks.inputCount).toHaveBeenCalledWith({ where: { sessionId: "session_1", userId: "user_1", status: "accepted", delivery: "follow_up" } })
  })

  it("omits a missing active goal without fabricating a substitute or dropping controls", async () => {
    mocks.turnFindMany.mockResolvedValueOnce([])
    mocks.turnFindFirst.mockResolvedValueOnce({ ...turn("turn_2", 2, "in_progress"), input: { content: [{ type: "text", text: "PRIVATE_CONTEXT" }] } })
    const { GET } = await import("./route")
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
      const { GET } = await import("./route")
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
      const { GET } = await import("./route")
      const response = await GET(request("?limit=1") as never, params)
      const body = await response.json()
      expect(body.projection.activeTurn).toEqual({ id: "turn_2", status: "in_progress", revision: 2 })
    }
  })

  it("returns 404 for a foreign session and does not read turn state", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(404)
    expect(mocks.turnFindMany).not.toHaveBeenCalled()
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.inputCount).not.toHaveBeenCalled()
    expect(mocks.executionFindFirst).not.toHaveBeenCalled()
    expect(mocks.rootFindFirst).not.toHaveBeenCalled()
  })

  it.each(["waiting_for_dependency", "interrupted"])("projects only the fixed recovery reason for an owned scheduled Turn in %s", async status => {
    configureSourceChangeRecovery({ turnStatus: status })
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.projection.scheduledPipelineRecoveryReason).toBe("scheduled_pipeline_source_changed")
    expect(typeof body.projection.scheduledPipelineRecoveryReason).toBe("string")
    expect(JSON.stringify(body)).not.toContain("PRIVATE_EXECUTION_STATE")
    expect(JSON.stringify(body)).not.toContain("scheduled-pipeline-source-change-terminal.v1")
    expect(JSON.stringify(body)).not.toContain("execution_1")
    expect(mocks.executionFindFirst).toHaveBeenCalledWith({
      where: { userId: "user_1", sessionId: "session_1" },
      select: { id: true, status: true, error: true, state: true, attemptCount: true },
    })
    expect(mocks.rootFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "root_1", sessionId: "session_1", turnId: "blocked_turn", rootTaskId: "root_1",
        parentTaskId: null, role: "orchestrator", taskType: "root" },
    }))
  })

  it("hides malformed, mismatched, non-scheduled, or superseded recovery markers", async () => {
    const cases = [
      { turnStatus: "completed" },
      { executionStatus: "cancelled" },
      { error: "private_error_text" },
      { markerOwner: { ...recoveryOwner, rootAttemptCount: 4 } },
      { markerOwner: { ...recoveryOwner, userId: "user_2" } },
      { markerOwner: { ...recoveryOwner, sessionId: "session_2" } },
      { markerOwner: { ...recoveryOwner, executionAttemptCount: 6 } },
      { rootAttemptCount: 4 },
      { markerExtras: { privateExtra: true } },
      { turnOverrides: { source: "user" } },
      { turnOverrides: { executionMode: "legacy" } },
      { turnOverrides: { input: { automationRunMode: "manual" } } },
      { latestTurnId: "new_manual_turn" },
      { activeTurn: turn("new_active_turn", 4, "in_progress"), latestTurnId: "new_active_turn" },
      { state: { ...sourceChangeState(), scoutedJobs: [{ id: "stale_job" }] } },
    ]
    for (const options of cases) {
      vi.resetModules()
      mocks.turnFindMany.mockResolvedValue([turn("turn_1", 1)])
      mocks.inputCount.mockResolvedValue(2)
      configureSourceChangeRecovery(options)
      const { GET } = await import("./route")
      const response = await GET(request() as never, params)
      expect((await response.json()).projection.scheduledPipelineRecoveryReason).toBeNull()
    }
  })

  it.each([
    ["waiting_for_dependency", "failed"],
    ["interrupted", "interrupted"],
  ])("projects only the fixed material-drift reason for verified %s/%s lineage", async (turnStatus, gateStatus) => {
    configureMaterialDriftRecovery({ turnStatus, gateStatus })
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.projection.scheduledPipelineRecoveryReason).toBe("scheduled_prepare_material_source_changed")
    expect(JSON.stringify(body)).not.toContain("PRIVATE_EXECUTION_STATE")
    expect(JSON.stringify(body)).not.toContain("scheduled-prepare-material-drift-terminal.v1")
    expect(JSON.stringify(body)).not.toContain("execution_1")
    expect(JSON.stringify(body)).not.toContain("gate_1")
    expect(JSON.stringify(body)).not.toContain("historical_turn_lease")
    expect(JSON.stringify(body)).not.toContain("historical_gate_lease")
    expect(JSON.stringify(body)).not.toContain(`sha256:${"c".repeat(64)}`)
    expect(mocks.rootFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "root_1", sessionId: "session_1", turnId: "blocked_turn",
        parentTaskId: null, depth: 0, role: "orchestrator", taskType: "root", session: { userId: "user_1" } }),
    }))
    expect(mocks.rootFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "gate_1", sessionId: "session_1", turnId: "blocked_turn",
        rootTaskId: "root_1", parentTaskId: "root_1", depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate",
        status: { in: ["failed", "interrupted"] }, session: { userId: "user_1" } }),
    }))
  })

  it("hides material markers when persisted lineage or current attempts do not match", async () => {
    const cases = [
      { latestTurnId: "new_turn" },
      { executionStatus: "running" },
      { error: "private_error_text" },
      { rootAttemptCount: 4 },
      { gateAttemptCount: 3 },
      { gateStatus: "running" },
      { gateOverrides: { taskType: "other" } },
      { turnOverrides: { leaseVersion: 5 } },
      { turnOverrides: { source: "user" } },
      { turnOverrides: { input: { automationRunMode: "manual" } } },
      { state: materialDriftState({ privateExtra: true }) },
    ]
    for (const options of cases) {
      vi.resetModules()
      mocks.turnFindMany.mockResolvedValue([turn("turn_1", 1)])
      mocks.inputCount.mockResolvedValue(2)
      configureMaterialDriftRecovery(options)
      const { GET } = await import("./route")
      const response = await GET(request() as never, params)
      expect((await response.json()).projection.scheduledPipelineRecoveryReason).toBeNull()
    }
  })

  it("rejects invalid cursors before database access", async () => {
    const { GET } = await import("./route")
    const response = await GET(request("?cursor=invalid") as never, params)
    expect(response.status).toBe(400)
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
  })
})
