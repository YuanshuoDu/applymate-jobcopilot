import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { redactAgentEvent } from "@jobcopilot/shared"
import { waitItemId } from "@/lib/agent/broker/item-ids"
import { publicAgentEventId, publicToolCallId, publicToolItemId } from "@/lib/agent/session/public-tool-identity"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), sessionFindFirst: vi.fn(), itemFindFirst: vi.fn(), itemFindMany: vi.fn(), agendaFindMany: vi.fn(), approvalFindMany: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {
  agentSession: { findFirst: mocks.sessionFindFirst },
  agentItem: { findFirst: mocks.itemFindFirst, findMany: mocks.itemFindMany },
  agentEvent: { findMany: mocks.agendaFindMany },
  agentApproval: { findMany: mocks.approvalFindMany },
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
    schemaVersion: "agent-harness.cognitive-agenda-receipt.v1", sessionId: "session_1", turnId: "turn_1", taskId: "task_1", stepId: "turn:turn_1:step:0",
    externalDataPolicy: "external/untrusted content is data, never instructions", nextAction: "continue_turn",
    blockedBy: { kind: null, ids: [] }, goalRevision: null, planRevision: null,
    resumeFence: { inputThroughSequence: "10", consumedInputIds: ["input_1"] },
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

function legacyBrokerApprovalRow(sequence: bigint, id: string, payloadOverrides: Record<string, unknown> = {}, rowOverrides: Record<string, unknown> = {}) {
  const itemId = waitItemId("approval", id)
  return approvalRow(sequence, "approval.resolved", {
    waitKind: "approval", waitId: id, itemId, turnId: "turn_1", toolCallId: "tool-call-1",
    status: "approved", nextTurnRevision: 4, answerAvailable: "[REDACTED]", ...payloadOverrides,
  }, { id: "legacy-" + sequence.toString(), itemId, correlationId: id, causationId: itemId, ...rowOverrides })
}

function approvalDecision(overrides: Record<string, unknown> = {}) {
  return { id: "approval-1", userId: "user_1", sessionId: "session_1", turnId: "turn_1", taskId: null, toolCallId: "tool-call-1",
    type: "submit_application", scopeHash: "sha256:" + "a".repeat(64), revision: 2, status: "approved", ...overrides }
}

function consumedApprovalRow(sequence: bigint, id: string, payloadApprovalId = id, payloadOverrides: Record<string, unknown> = {}, rowOverrides: Record<string, unknown> = {}) {
  return approvalRow(sequence, "approval.consumed", {
    approvalId: payloadApprovalId, action: "submit_application", scopeHash: "sha256:" + "a".repeat(64), revision: 2, ...payloadOverrides,
  }, { id: "consumed-" + sequence.toString(), correlationId: id, idempotencyKey: "approval:" + id + ":consumed", ...rowOverrides })
}

describe("agent timeline query API", () => {
  beforeAll(async () => {
    await import("./route")
  })

  beforeEach(() => {
    mocks.requireAuth.mockReset()
    mocks.sessionFindFirst.mockReset()
    mocks.itemFindFirst.mockReset()
    mocks.itemFindMany.mockReset()
    mocks.agendaFindMany.mockReset()
    mocks.approvalFindMany.mockReset()
    mocks.approvalFindMany.mockResolvedValue([])
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.itemFindFirst.mockResolvedValue(null)
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

  it("seals tool-item cursors while keeping public item and call aliases stable across pages", async () => {
    const rawCallId = "+353851234567"
    const rawItemId = `turn:turn_1:item:tool-call:${rawCallId}:item-suffix`
    const toolItem = { ...item(rawItemId, 0), type: "tool_call", content: { toolCallId: rawCallId, toolName: "jobs.search", input: { query: "engineer" } } }
    const nextItem = item("item_after_tool", 1)
    mocks.itemFindMany.mockResolvedValueOnce([toolItem, nextItem]).mockResolvedValueOnce([nextItem])
    const { GET } = await import("./route")

    const first = await GET(request("?limit=1") as never, params)
    const firstBody = await first.json()
    expect(firstBody.items[0]).toMatchObject({
      id: publicToolItemId("session_1", "turn_1", rawItemId),
      content: { toolCallId: publicToolCallId("session_1", "turn_1", rawCallId), toolName: "jobs.search" },
    })
    expect(firstBody.page.hasMore).toBe(true)
    expect(firstBody.page.nextCursor).toMatch(/^ptc1\./)
    expect(firstBody.page.nextCursor).not.toContain(rawCallId)
    expect(firstBody.page.nextCursor).not.toContain(rawItemId)

    const second = await GET(request(`?limit=1&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`) as never, params)
    const secondBody = await second.json()
    expect(secondBody.items.map((entry: { id: string }) => entry.id)).toEqual(["item_after_tool"])
    expect(mocks.itemFindMany.mock.calls[1]?.[0]).toMatchObject({
      where: { sessionId: "session_1", OR: [{ createdAt: { gt: toolItem.createdAt } }, { createdAt: toolItem.createdAt, id: { gt: rawItemId } }] },
    })
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

  it("returns one owner-scoped safe final DTO without paging or tail scans", async () => {
    const final = {
      ...item("turn:turn_1:item:final:step_1", 1), phase: "final_answer",
      content: { text: "Answer text unchanged", final: { summary: "Two verified points.", evidence: "PRIVATE_EVIDENCE", usage: { tokens: 42 } } },
    }
    mocks.itemFindFirst.mockResolvedValueOnce(final)
    const { GET } = await import("./route")

    const response = await GET(request(`?itemId=${encodeURIComponent(final.id)}`) as never, params)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ items: [{
      schemaVersion: "agent-harness.v2", id: final.id, sessionId: "session_1", turnId: "turn_1", stepId: null, taskId: null,
      type: "agent_message", status: "completed", phase: "final_answer", revision: 0,
      content: { text: "Answer text unchanged", summary: "Two verified points." },
      startedAt: null, completedAt: final.completedAt.toISOString(), createdAt: final.createdAt.toISOString(), updatedAt: final.updatedAt.toISOString(),
    }], page: { hasMore: false, nextCursor: null } })
    expect(JSON.stringify(body)).not.toContain("PRIVATE_EVIDENCE")
    expect(JSON.stringify(body)).not.toContain('"tokens"')
    expect(mocks.sessionFindFirst).toHaveBeenCalledBefore(mocks.itemFindFirst)
    expect(mocks.itemFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: final.id, sessionId: "session_1" },
      select: expect.objectContaining({ id: true, sessionId: true, turnId: true, type: true, content: true }),
    }))
    expect(mocks.itemFindMany).not.toHaveBeenCalled()
    expect(mocks.agendaFindMany).not.toHaveBeenCalled()
  })

  it("keeps targeted question hydration IDs stable and aliases only its provider tool call", async () => {
    const rawCallId = "private.user@example.com"
    const question = {
      ...item("agent-wait:question:q1", 1), type: "question",
      content: { questionId: "q1", toolCallId: rawCallId, stage: "profile", question: "Are you authorised to work?", options: [], answerAvailable: false },
    }
    mocks.itemFindFirst.mockResolvedValueOnce(question)
    const { GET } = await import("./route")

    const response = await GET(request(`?itemId=${encodeURIComponent(question.id)}`) as never, params)
    const body = await response.json()

    expect(body.items[0]).toMatchObject({
      id: question.id,
      content: { questionId: "q1", toolCallId: publicToolCallId("session_1", "turn_1", rawCallId) },
    })
    expect(JSON.stringify(body)).not.toContain(rawCallId)
    expect(mocks.itemFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: question.id, sessionId: "session_1" } }))
  })

  it.each([
    ["empty", "?itemId="],
    ["duplicate", "?itemId=first&itemId=second"],
    ["cursor mixed in", "?itemId=first&cursor=eyJ4IjoxfQ"],
    ["limit mixed in", "?itemId=first&limit=1"],
    ["unknown query parameter", "?itemId=first&unexpected=1"],
    ["control character", "?itemId=%00"],
  ])("rejects an %s direct item target after the owner check", async (_name, path) => {
    const { GET } = await import("./route")
    const response = await GET(request(path) as never, params)

    expect(response.status).toBe(400)
    expect(mocks.requireAuth).toHaveBeenCalledBefore(mocks.sessionFindFirst)
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
    expect(mocks.itemFindFirst).not.toHaveBeenCalled()
    expect(mocks.itemFindMany).not.toHaveBeenCalled()
    expect(mocks.agendaFindMany).not.toHaveBeenCalled()
  })

  it("keeps foreign session and missing or cross-session items indistinguishable as not found", async () => {
    const { GET } = await import("./route")
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const foreignSession = await GET(request("?itemId=item_1") as never, params)
    expect(foreignSession.status).toBe(404)
    expect(mocks.itemFindFirst).not.toHaveBeenCalled()

    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.itemFindFirst.mockResolvedValueOnce(null)
    const missingItem = await GET(request("?itemId=item_1") as never, params)
    expect(missingItem.status).toBe(404)
    expect(await missingItem.json()).toMatchObject({ error: { code: "timeline_item_not_found" } })
    expect(mocks.itemFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "item_1", sessionId: "session_1" } }))
    expect(mocks.itemFindMany).not.toHaveBeenCalled()
    expect(mocks.agendaFindMany).not.toHaveBeenCalled()
  })

  it("omits private reconciliation receipt rows from timeline projections", async () => {
    const privateMarker = "private-steering-reconciliation-marker"
    const row = {
      id: "private-reconciliation-event", sessionId: "session_1", turnId: "turn_1", itemId: null, taskId: "root_1",
      sequence: BigInt(12), type: "agent.plan.reconciliation", actor: "system", correlationId: "step_2",
      causationId: null, idempotencyKey: "private-receipt-key",
      payload: { receiptVersion: privateMarker, steerInputIds: [privateMarker], rationale: privateMarker },
    }
    const clarification = {
      ...row, id: "private-clarification-event", sequence: BigInt(13), type: "agent.plan.clarification",
      idempotencyKey: "private-clarification-key",
      payload: { waitId: privateMarker, steerInputIds: [privateMarker], questionText: privateMarker },
    }
    mocks.agendaFindMany.mockResolvedValueOnce([row, clarification]).mockResolvedValueOnce([row, clarification]).mockResolvedValueOnce([row, clarification])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(serialized).not.toContain("agent.plan.reconciliation")
    expect(serialized).not.toContain("agent.plan.clarification")
    expect(serialized).not.toContain("private-reconciliation-event")
    expect(serialized).not.toContain("private-clarification-event")
    expect(serialized).not.toContain("private-receipt-key")
    expect(serialized).not.toContain("private-clarification-key")
    expect(serialized).not.toContain(privateMarker)
    expect(mocks.agendaFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { sessionId: "session_1", type: "cognitive.agenda" },
    }))
    expect(mocks.agendaFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { sessionId: "session_1", type: "agent.steering.marker" },
    }))
    expect(mocks.agendaFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
      where: { sessionId: "session_1", type: { in: ["approval.requested", "approval.resolved", "approval.consumed", "approval.expired"] } },
    }))
  })

  it("returns the latest legal agenda only on the first page and redacts its payload", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([
      agendaRow(BigInt(9), { payload: agendaPayload({ unexpected: "reject this" }) }),
      agendaRow(BigInt(8), { payload: agendaPayload({
        goalRevision: 3, planRevision: 0,
        signals: { ...agendaPayload().signals, approvals: { count: 1, ids: ["sk-secret12345"] } },
      }) }),
    ])
    const { GET } = await import("./route")

    const response = await GET(request("?limit=1") as never, params)
    const body = await response.json()

    expect(body.agenda).toMatchObject({ id: publicAgentEventId("session_1", "agenda_8"), sequence: "8", type: "cognitive.agenda", payload: {
      goalRevision: 3, planRevision: 0, signals: { approvals: { count: 1, ids: ["[REDACTED]"] } },
    } })
    expect(body.agenda.payload).not.toHaveProperty("resumeFence")
    expect(JSON.stringify(body.agenda.payload)).not.toContain("input_1")
    expect(body.agendas.map((entry: { id: string }) => entry.id)).toEqual([publicAgentEventId("session_1", "agenda_8")])
    expect(mocks.agendaFindMany).toHaveBeenCalledWith({
      where: { sessionId: "session_1", type: "cognitive.agenda" }, orderBy: { sequence: "desc" }, take: 64,
      select: expect.objectContaining({ payload: true, sequence: true }),
    })

    mocks.agendaFindMany.mockClear()
    const next = await GET(request("?limit=1&cursor=eyJjb2xsZWN0aW9uIjoidGltZWxpbmUiLCJjcmVhdGVkQXQiOiIyMDI2LTA4LTMxVDAwOjAwOjAwLjAwMFoiLCJpZCI6Iml0ZW1fMSIsInNlc3Npb25JZCI6InNlc3Npb25fMSJ9") as never, params)
    expect((await next.json()).agenda).toBeUndefined()
    expect(mocks.agendaFindMany).not.toHaveBeenCalled()
  })

  it("restores a legacy redacted approval answer only from its exact authoritative decision", async () => {
    const row = legacyBrokerApprovalRow(BigInt(3), "approval-1")
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row])
    mocks.approvalFindMany.mockResolvedValueOnce([approvalDecision()])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.approvalEvents).toHaveLength(1)
    expect(body.approvalEvents[0].payload.answerAvailable).toBe(false)
    expect(body.approvalEvents[0].payload.status).toBe("approved")
    expect(JSON.stringify(body.approvalEvents)).not.toContain("[REDACTED]")
    expect(JSON.stringify(body.approvalEvents)).not.toContain("tool-call-1")
    expect(mocks.approvalFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["approval-1"] }, userId: "user_1", sessionId: "session_1" },
      select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, toolCallId: true, type: true, scopeHash: true, revision: true, status: true },
    })
  })

  it("restores a legacy redacted rejected answer only from its exact rejected authority", async () => {
    const row = legacyBrokerApprovalRow(BigInt(3), "approval-1", { status: "rejected" })
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row])
    mocks.approvalFindMany.mockResolvedValueOnce([approvalDecision({ status: "rejected" })])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.approvalEvents).toHaveLength(1)
    expect(body.approvalEvents[0]).toMatchObject({
      type: "approval.resolved",
      payload: { waitId: "approval-1", status: "rejected", answerAvailable: false },
    })
  })

  it("preserves consumed audit action, hash, and revision through fact-store redaction", () => {
    const payload = { approvalId: "approval-1", action: "submit_application", scopeHash: "sha256:" + "a".repeat(64), revision: 2 }
    const redacted = redactAgentEvent({
      type: "approval.consumed", body: "", data: payload,
      routing: { sessionId: "session_1", turnId: "turn_1", itemId: null, taskId: null, actor: "system",
        correlationId: "approval-1", causationId: null, outboxTopic: "agent.session.event" },
    })
    expect(redacted.data).toEqual({ approvalId: "[REDACTED]", action: payload.action, scopeHash: payload.scopeHash, revision: payload.revision })
  })

  it.each(["[REDACTED]", "approval-1"])("restores a consumed approval decision from the canonical audit when stored ID is %s", async storedId => {
    const resolved = legacyBrokerApprovalRow(BigInt(3), "approval-1")
    const consumed = consumedApprovalRow(BigInt(4), "approval-1", storedId)
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([consumed, resolved])
    mocks.approvalFindMany.mockResolvedValueOnce([approvalDecision({ status: "consumed" })])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()
    const event = body.approvalEvents.find((entry: { type: string }) => entry.type === "approval.resolved")

    expect(event.payload.answerAvailable).toBe(false)
    expect(event.payload.status).toBe("approved")
    expect(JSON.stringify(body.approvalEvents)).not.toContain("tool-call-1")
    expect(mocks.agendaFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
      where: { sessionId: "session_1", type: { in: ["approval.requested", "approval.resolved", "approval.consumed", "approval.expired"] } },
      orderBy: { sequence: "desc" }, take: 256, select: expect.objectContaining({ idempotencyKey: true, sequence: true }),
    }))
  })

  it("restores a consumed approval only when its non-null task scope matches every record", async () => {
    const resolved = legacyBrokerApprovalRow(BigInt(3), "approval-1", {}, { taskId: "task_1" })
    const consumed = consumedApprovalRow(BigInt(4), "approval-1", "[REDACTED]", {}, { taskId: "task_1" })
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([consumed, resolved])
    mocks.approvalFindMany.mockResolvedValueOnce([approvalDecision({ taskId: "task_1", status: "consumed" })])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()
    const event = body.approvalEvents.find((entry: { type: string }) => entry.type === "approval.resolved")

    expect(event).toMatchObject({
      taskId: "task_1",
      payload: { waitId: "approval-1", status: "approved", answerAvailable: false },
    })
    expect(body.approvalEvents.find((entry: { type: string }) => entry.type === "approval.consumed")).toMatchObject({ taskId: "task_1" })
  })

  it("fails closed when consumed approval audit evidence is absent, ambiguous, or mismatched", async () => {
    const resolved = (sequence: number, id: string, status = "approved") =>
      legacyBrokerApprovalRow(BigInt(sequence), id, { status })
    const resolvedRows = [
      resolved(10, "consumed-missing"), resolved(20, "consumed-duplicate"), resolved(30, "consumed-before"),
      resolved(40, "consumed-wrong-route"), resolved(50, "consumed-wrong-scope"), resolved(60, "consumed-wrong-revision"),
      resolved(70, "consumed-wrong-action"), resolved(80, "consumed-wrong-id"), resolved(90, "consumed-rejected", "rejected"),
      resolved(100, "consumed-wrong-correlation"), resolved(110, "consumed-wrong-key"), resolved(120, "consumed-wrong-turn"),
      resolved(130, "consumed-wrong-task"), resolved(140, "consumed-wrong-item"), resolved(150, "consumed-wrong-actor"),
      resolved(160, "consumed-wrong-session"),
    ]
    const consumedRows = [
      consumedApprovalRow(BigInt(21), "consumed-duplicate"), consumedApprovalRow(BigInt(22), "consumed-duplicate"),
      consumedApprovalRow(BigInt(29), "consumed-before"),
      consumedApprovalRow(BigInt(41), "consumed-wrong-route", "consumed-wrong-route", {}, { causationId: "wrong-cause" }),
      consumedApprovalRow(BigInt(51), "consumed-wrong-scope", "consumed-wrong-scope", { scopeHash: "sha256:" + "b".repeat(64) }),
      consumedApprovalRow(BigInt(61), "consumed-wrong-revision", "consumed-wrong-revision", { revision: 3 }),
      consumedApprovalRow(BigInt(71), "consumed-wrong-action", "consumed-wrong-action", { action: "review_application" }),
      consumedApprovalRow(BigInt(81), "consumed-wrong-id", "other-approval"),
      consumedApprovalRow(BigInt(91), "consumed-rejected"),
      consumedApprovalRow(BigInt(101), "consumed-wrong-correlation", "consumed-wrong-correlation", {}, { correlationId: "other-approval" }),
      consumedApprovalRow(BigInt(111), "consumed-wrong-key", "consumed-wrong-key", {}, { idempotencyKey: "approval:other-approval:consumed" }),
      consumedApprovalRow(BigInt(121), "consumed-wrong-turn", "consumed-wrong-turn", {}, { turnId: "turn_2" }),
      consumedApprovalRow(BigInt(131), "consumed-wrong-task", "consumed-wrong-task", {}, { taskId: "other-task" }),
      consumedApprovalRow(BigInt(141), "consumed-wrong-item", "consumed-wrong-item", {}, { itemId: "other-item" }),
      consumedApprovalRow(BigInt(151), "consumed-wrong-actor", "consumed-wrong-actor", {}, { actor: "user" }),
      consumedApprovalRow(BigInt(161), "consumed-wrong-session", "consumed-wrong-session", {}, { sessionId: "session_2" }),
    ]
    const authority = ["consumed-missing", "consumed-duplicate", "consumed-before", "consumed-wrong-route", "consumed-wrong-scope",
      "consumed-wrong-revision", "consumed-wrong-action", "consumed-wrong-id", "consumed-rejected", "consumed-wrong-correlation",
      "consumed-wrong-key", "consumed-wrong-turn", "consumed-wrong-task", "consumed-wrong-item", "consumed-wrong-actor", "consumed-wrong-session"]
      .map(id => approvalDecision({ id, status: "consumed" }))
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([...consumedRows, ...resolvedRows])
    mocks.approvalFindMany.mockResolvedValueOnce(authority)
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect((body.approvalEvents ?? []).filter((event: { type: string }) => event.type === "approval.resolved")).toEqual([])
  })

  it("fails closed for legacy approval sentinels with missing, ambiguous, or mismatched authority", async () => {
    const rows = [
      legacyBrokerApprovalRow(BigInt(1), "missing"),
      legacyBrokerApprovalRow(BigInt(2), "ambiguous"),
      legacyBrokerApprovalRow(BigInt(3), "foreign-user"),
      legacyBrokerApprovalRow(BigInt(4), "foreign-session"),
      legacyBrokerApprovalRow(BigInt(5), "foreign-event-session", {}, { sessionId: "session-2" }),
      legacyBrokerApprovalRow(BigInt(6), "wrong-turn", {}, { turnId: "turn_2" }),
      legacyBrokerApprovalRow(BigInt(7), "wrong-task", {}, { taskId: "task_event" }),
      legacyBrokerApprovalRow(BigInt(8), "wrong-wait", { waitId: "other-wait" }),
      legacyBrokerApprovalRow(BigInt(9), "wrong-row-item", {}, { itemId: "other-item" }),
      legacyBrokerApprovalRow(BigInt(10), "wrong-payload-item", { itemId: "other-item" }),
      legacyBrokerApprovalRow(BigInt(20), "wrong-noncanonical-item", { itemId: "legal-other-item" }, { itemId: "legal-other-item", causationId: "legal-other-item" }),
      legacyBrokerApprovalRow(BigInt(11), "wrong-correlation", {}, { correlationId: "other-wait" }),
      legacyBrokerApprovalRow(BigInt(12), "wrong-causation", {}, { causationId: "other-item" }),
      legacyBrokerApprovalRow(BigInt(13), "wrong-payload-turn", { turnId: "turn_2" }),
      legacyBrokerApprovalRow(BigInt(14), "wrong-authority-turn"),
      legacyBrokerApprovalRow(BigInt(15), "wrong-authority-task"),
      legacyBrokerApprovalRow(BigInt(16), "wrong-authority-tool-call"),
      legacyBrokerApprovalRow(BigInt(17), "wrong-payload-tool-call", { toolCallId: "other-tool-call" }),
      legacyBrokerApprovalRow(BigInt(18), "wrong-authority-status"),
      legacyBrokerApprovalRow(BigInt(19), "tampered-payload-status", { status: "rejected" }),
    ]
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(rows)
    mocks.approvalFindMany.mockResolvedValueOnce([
      approvalDecision({ id: "ambiguous" }), approvalDecision({ id: "ambiguous" }),
      approvalDecision({ id: "foreign-user", userId: "user_2" }),
      approvalDecision({ id: "foreign-session", sessionId: "session_2" }),
      approvalDecision({ id: "foreign-event-session" }),
      approvalDecision({ id: "wrong-turn" }),
      approvalDecision({ id: "wrong-task" }),
      approvalDecision({ id: "wrong-row-item" }),
      approvalDecision({ id: "wrong-payload-item" }),
      approvalDecision({ id: "wrong-noncanonical-item" }),
      approvalDecision({ id: "wrong-correlation" }),
      approvalDecision({ id: "wrong-causation" }),
      approvalDecision({ id: "wrong-payload-turn" }),
      approvalDecision({ id: "wrong-authority-turn", turnId: "turn_2" }),
      approvalDecision({ id: "wrong-authority-task", taskId: "task_authority" }),
      approvalDecision({ id: "wrong-authority-tool-call", toolCallId: "other-tool-call" }),
      approvalDecision({ id: "wrong-payload-tool-call" }),
      approvalDecision({ id: "wrong-authority-status", status: "rejected" }),
      approvalDecision({ id: "tampered-payload-status" }),
    ])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.approvalEvents ?? []).toEqual([])
    expect(JSON.stringify(body)).not.toContain("[REDACTED]")
  })

  it("restores legal approval facts in sequence order without returning receipt material", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      brokerApprovalRow(BigInt(3)), approvalRow(BigInt(1), "approval.requested", approvalAuditPayload()),
    ])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.approvalEvents.map((event: { id: string }) => event.id)).toEqual([
      publicAgentEventId("session_1", "approval_1"), publicAgentEventId("session_1", "approval_3"),
    ])
    expect(body.approvalEvents[1].payload).toMatchObject({
      waitId: "approval-1", itemId: "wait-item-1", turnId: "turn_1", toolCallId: publicToolCallId("session_1", "turn_1", "tool-call-1"),
    })
    expect(JSON.stringify(body.approvalEvents)).not.toContain("tool-call-1")
    expect(body.approvalEvents[0].payload).toEqual({ approvalId: "approval-1", action: "submit_application", revision: 2 })
    expect(JSON.stringify(body.approvalEvents)).not.toContain("scopeHash")
    expect(mocks.agendaFindMany).toHaveBeenNthCalledWith(3, {
      where: { sessionId: "session_1", type: { in: ["approval.requested", "approval.resolved", "approval.consumed", "approval.expired"] } },
      orderBy: { sequence: "desc" }, take: 256, select: expect.objectContaining({ payload: true, sequence: true }),
    })
  })

  it("filters foreign, wrong-actor, wrong-item, and malformed approval facts", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([
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

    expect(body.approvalEvents.map((event: { id: string }) => event.id)).toEqual([publicAgentEventId("session_1", "approval_1")])
    expect(JSON.stringify(body.approvalEvents)).not.toContain("raw secret")
  })

  it("restores only a legal bounded marker pair after the authenticated session check", async () => {
    mocks.agendaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      steeringMarkerRow(BigInt(11), "applied"), steeringMarkerRow(BigInt(10), "observed"),
    ])
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)
    const body = await response.json()

    expect(body.steeringMarkers.map((event: { id: string }) => event.id)).toEqual([
      publicAgentEventId("session_1", "marker_10"), publicAgentEventId("session_1", "marker_11"),
    ])
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

  it("does not query target items when authentication fails", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")
    const response = await GET(request("?itemId=item_1") as never, params)
    expect(response.status).toBe(401)
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
    expect(mocks.itemFindFirst).not.toHaveBeenCalled()
  })
})
