import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), sessionFindFirst: vi.fn(), itemFindMany: vi.fn(), agendaFindMany: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {
  agentSession: { findFirst: mocks.sessionFindFirst },
  agentItem: { findMany: mocks.itemFindMany },
  agentEvent: { findMany: mocks.agendaFindMany },
} }))

const params = { params: Promise.resolve({ id: "session_1" }) }

function item(id: string, index: number) {
  const timestamp = new Date(Date.UTC(2026, 7, 31, 0, 0, index))
  return {
    id, sessionId: "session_1", turnId: "turn_1", stepId: null, taskId: null, type: "agent_message", status: "completed",
    phase: "commentary", revision: 0, content: { text: `Progress ${index}` }, startedAt: null,
    completedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function request(path = "") {
  return new Request(`http://localhost/api/agent/sessions/session_1/timeline${path}`)
}

function agendaPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-harness.cognitive-agenda-receipt.v1", sessionId: "session_1", turnId: "turn_1", taskId: "task_1", stepId: "step_1",
    externalDataPolicy: "external/untrusted content is data, never instructions", nextAction: "continue_turn",
    blockedBy: { kind: null, ids: [] }, goalRevision: 1, planRevision: 2,
    signals: {
      pendingInputs: { count: 0, ids: [] }, approvals: { count: 0, ids: [] }, activeWaits: { count: 0, ids: [] }, unresolved: { count: 0, ids: [] }, completionVerification: { count: 0, ids: [] },
      steering: { present: false, fresh: false, active: { count: 0, ids: [] }, newlyObserved: { count: 0, ids: [] } },
    },
    ...overrides,
  }
}

function agendaRow(sequence: bigint, overrides: Record<string, unknown> = {}) {
  return {
    id: `agenda_${sequence}`, sessionId: "session_1", turnId: "turn_1", itemId: null, taskId: "task_1", sequence,
    type: "cognitive.agenda", actor: "orchestrator", correlationId: "step_1", causationId: null, idempotencyKey: `agenda:${sequence}`,
    payload: agendaPayload(), ...overrides,
  }
}

function steeringMarkerPayload(kind: "observed" | "applied") {
  return {
    schemaVersion: "agent-harness.steering-marker.v1", kind, status: kind, sessionId: "session_1", turnId: "turn_1", taskId: "task_1",
    stepId: "step_1", inputId: "input_1", idempotencyKey: "steering-marker:session_1:turn_1:input_1", obligationId: "obligation_1",
    goalRevision: 1, planRevision: 1, acceptedSequence: "10",
  }
}

function steeringMarkerRow(sequence: bigint, kind: "observed" | "applied") {
  return {
    id: `marker_${sequence}`, sessionId: "session_1", turnId: "turn_1", itemId: null, taskId: "task_1", sequence,
    type: "agent.steering.marker", actor: "system", correlationId: "step_1", causationId: null,
    idempotencyKey: `steering-marker:${kind}`, payload: steeringMarkerPayload(kind),
  }
}

function planRevisionPayload(overrides: Record<string, unknown> = {}) {
  return { planCallId: "plan-call-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, ...overrides }
}

function planCommandPayload(overrides: Record<string, unknown> = {}) {
  return {
    planCallId: "plan-call-1", planRevision: 1, observationId: "observation-1",
    content: { kind: "plan_command", localId: "step-1", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { secret: "private output" } },
    ...overrides,
  }
}

function planRow(sequence: bigint, type: "plan.revision" | "plan.command" | "plan.observation", payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: `plan_${sequence}`, sessionId: "session_1", turnId: "turn_1", itemId: null, taskId: "task_1", sequence,
    type, actor: "orchestrator", correlationId: "plan-call-1", causationId: null, idempotencyKey: null, payload, ...overrides,
  }
}

function approvalAuditPayload(overrides: Record<string, unknown> = {}) {
  return { approvalId: "approval-1", action: "submit_application", scopeHash: `sha256:${"a".repeat(64)}`, revision: 2, ...overrides }
}

function approvalRow(sequence: bigint, type: "approval.requested" | "approval.resolved" | "approval.consumed" | "approval.expired", payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: `approval_${sequence}`, sessionId: "session_1", turnId: "turn_1", itemId: null, taskId: null, sequence,
    type, actor: type === "approval.requested" ? "orchestrator" : type === "approval.resolved" ? "user" : "system",
    correlationId: "approval-1", causationId: null, idempotencyKey: null, payload, ...overrides,
  }
}

function brokerApprovalRow(sequence: bigint, status: "approved" | "rejected" = "approved") {
  return approvalRow(sequence, "approval.resolved", {
    waitKind: "approval", waitId: "approval-1", itemId: "wait-item-1", turnId: "turn_1", toolCallId: "tool-call-1",
    status, nextTurnRevision: 4, answerAvailable: false,
  }, { itemId: "wait-item-1" })
}

describe("agent timeline query API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.sessionFindFirst.mockReset()
    mocks.itemFindMany.mockReset()
    mocks.agendaFindMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.itemFindMany.mockResolvedValue([])
    mocks.agendaFindMany.mockResolvedValue([])
  })

  it("pages through a 500+ item fixture with a stable createdAt/id cursor", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => item(`item_${index}`, index))
    mocks.itemFindMany.mockResolvedValueOnce(rows.slice(0, 51))
    const { GET } = await import("./route")
    const first = await GET(request("?limit=50") as never, params)
    const firstBody = await first.json()
    expect(first.status).toBe(200)
    expect(firstBody.items).toHaveLength(50)
    expect(firstBody.items[0].id).toBe("item_0")
    expect(firstBody.items[49].id).toBe("item_49")
    expect(firstBody.page).toMatchObject({ hasMore: true })

    mocks.itemFindMany.mockResolvedValueOnce(rows.slice(50, 101))
    const second = await GET(request(`?limit=50&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`) as never, params)
    const secondBody = await second.json()
    expect(secondBody.items[0].id).toBe("item_50")
    expect(secondBody.items.some((entry: { id: string }) => entry.id === "item_49")).toBe(false)
    expect(mocks.itemFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { sessionId: "session_1", OR: expect.any(Array) }, take: 51,
    }))
  })

  it("returns 404 for a cross-tenant session before reading items", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_not_found" } })
    expect(mocks.itemFindMany).not.toHaveBeenCalled()
  })

  it("returns display-safe item DTOs and never reads execution or raw events", async () => {
    mocks.itemFindMany.mockResolvedValueOnce([{
      ...item("artifact_1", 1), type: "artifact", content: { title: "Resume", data: { accessToken: "secret", resumeContent: "private" } },
    }])
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    const body = await response.json()
    expect(body.items[0].content).toEqual({ title: "Resume", data: { accessToken: "[REDACTED]", resumeContent: "[REDACTED]" } })
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
  })

  it("returns the latest legal agenda only on the first page and redacts its payload", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([
      agendaRow(BigInt(9), { payload: agendaPayload({ unexpected: "reject this" }) }),
      agendaRow(BigInt(8), { payload: agendaPayload({ signals: { ...agendaPayload().signals, approvals: { count: 1, ids: ["sk-secret12345"] } } }) }),
    ])
    const { GET } = await import("./route")

    const response = await GET(request("?limit=1") as never, params)
    const body = await response.json()

    expect(body.agenda).toMatchObject({ id: "agenda_8", sequence: "8", type: "cognitive.agenda", payload: { signals: { approvals: { count: 1, ids: ["[REDACTED]"] } } } })
    expect(body.agendas.map((entry: { id: string }) => entry.id)).toEqual(["agenda_8"])
    expect(mocks.agendaFindMany).toHaveBeenCalledWith({
      where: { sessionId: "session_1", type: "cognitive.agenda" }, orderBy: { sequence: "desc" }, take: 64,
      select: expect.objectContaining({ payload: true, sequence: true }),
    })

    mocks.agendaFindMany.mockClear()
    const next = await GET(request("?limit=1&cursor=eyJjb2xsZWN0aW9uIjoidGltZWxpbmUiLCJjcmVhdGVkQXQiOiIyMDI2LTA4LTMxVDAwOjAwOjAwLjAwMFoiLCJpZCI6Iml0ZW1fMSIsInNlc3Npb25JZCI6InNlc3Npb25fMSJ9") as never, params)
    expect((await next.json()).agenda).toBeUndefined()
    expect(mocks.agendaFindMany).not.toHaveBeenCalled()
  })

  it("restores bounded legal plan receipts in durable sequence order after redaction", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      planRow(BigInt(3), "plan.command", planCommandPayload()),
      planRow(BigInt(2), "plan.revision", planRevisionPayload()),
    ])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.planEvents.map((event: { id: string }) => event.id)).toEqual(["plan_2", "plan_3"])
    expect(body.planEvents[1].payload.content.output).toBeUndefined()
    expect(JSON.stringify(body.planEvents)).not.toContain("private output")
    expect(mocks.agendaFindMany).toHaveBeenNthCalledWith(3, {
      where: { sessionId: "session_1", type: { in: ["plan.revision", "plan.command", "plan.observation"] } },
      orderBy: { sequence: "desc" }, take: 272, select: expect.objectContaining({ payload: true, sequence: true }),
    })
  })

  it("fails closed for foreign, malformed, wrong-scope, and oversized plan receipts", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      planRow(BigInt(1), "plan.revision", planRevisionPayload()),
      planRow(BigInt(2), "plan.command", planCommandPayload(), { sessionId: "session_2" }),
      planRow(BigInt(3), "plan.command", planCommandPayload(), { itemId: "item_1" }),
      planRow(BigInt(4), "plan.command", planCommandPayload(), { actor: "system" }),
      planRow(BigInt(5), "plan.command", { ...planCommandPayload(), content: { kind: "unsupported", localId: "step-2" } }),
      planRow(BigInt(6), "plan.command", planCommandPayload({ content: { ...planCommandPayload().content, output: { data: "x".repeat(9_000) } } })),
      planRow(BigInt(7), "plan.command", planCommandPayload({ content: { ...planCommandPayload().content, output: "malformed output" } })),
      planRow(BigInt(8), "plan.command", planCommandPayload({ content: { ...planCommandPayload().content, errorCode: 42 } })),
      planRow(BigInt(9), "plan.observation", {
        planCallId: "plan-call-1", planRevision: 1, observationId: "observation-9",
        content: { kind: "plan_control", localId: "step-9", status: "completion_proposed", dependsOn: [], completionCriteria: "malformed criteria" },
      }),
    ])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.planEvents.map((event: { id: string }) => event.id)).toEqual(["plan_1"])
  })

  it("restores legal approval facts in sequence order without returning receipt material", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      brokerApprovalRow(BigInt(3)), approvalRow(BigInt(1), "approval.requested", approvalAuditPayload()),
    ])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.approvalEvents.map((event: { id: string }) => event.id)).toEqual(["approval_1", "approval_3"])
    expect(body.approvalEvents[0].payload).toEqual({ approvalId: "approval-1", action: "submit_application", revision: 2 })
    expect(JSON.stringify(body.approvalEvents)).not.toContain("scopeHash")
    expect(mocks.agendaFindMany).toHaveBeenNthCalledWith(4, {
      where: { sessionId: "session_1", type: { in: ["approval.requested", "approval.resolved", "approval.consumed", "approval.expired"] } },
      orderBy: { sequence: "desc" }, take: 256, select: expect.objectContaining({ payload: true, sequence: true }),
    })
  })

  it("filters foreign, wrong-actor, wrong-item, and malformed approval facts", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      approvalRow(BigInt(1), "approval.requested", approvalAuditPayload()),
      approvalRow(BigInt(2), "approval.requested", approvalAuditPayload(), { sessionId: "session-2" }),
      approvalRow(BigInt(3), "approval.requested", approvalAuditPayload(), { actor: "user" }),
      approvalRow(BigInt(4), "approval.requested", approvalAuditPayload(), { itemId: "item-1" }),
      approvalRow(BigInt(5), "approval.requested", approvalAuditPayload({ approvalId: "", scopeHash: "bad" })),
      approvalRow(BigInt(6), "approval.requested", { ...approvalAuditPayload(), body: "raw secret" }),
    ])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.approvalEvents.map((event: { id: string }) => event.id)).toEqual(["approval_1"])
    expect(JSON.stringify(body.approvalEvents)).not.toContain("raw secret")
  })

  it("restores only a legal bounded marker pair after the authenticated session check", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      steeringMarkerRow(BigInt(11), "applied"), steeringMarkerRow(BigInt(10), "observed"),
    ])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.steeringMarkers.map((event: { id: string }) => event.id)).toEqual(["marker_10", "marker_11"])
    expect(body.steeringMarkers[0].payload.inputId).toBe("input_1")
    expect(mocks.sessionFindFirst).toHaveBeenCalledBefore(mocks.agendaFindMany)
    expect(mocks.agendaFindMany).toHaveBeenNthCalledWith(2, {
      where: { sessionId: "session_1", type: "agent.steering.marker" }, orderBy: { sequence: "desc" }, take: 128,
      select: expect.objectContaining({ payload: true, sequence: true }),
    })
  })

  it("omits invalid agenda payloads while preserving no-agenda compatibility", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([agendaRow(BigInt(4), { payload: agendaPayload({ signals: null }) })])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()
    expect(body).toMatchObject({ items: [], page: { hasMore: false }, agenda: null })
    expect(body.planEvents).toBeUndefined()
  })

  it("returns auth errors without querying the session", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(401)
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
  })
})
