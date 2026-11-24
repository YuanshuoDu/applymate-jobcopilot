import { beforeEach, describe, expect, it, vi } from "vitest"
import { hashApprovalScope, parseObjectiveApplicationApprovalSet, objectiveApplicationApprovalSetItemId } from "@jobcopilot/agent-protocol"
import { buildObjectiveApplicationResumeWitness, redactAgentEvent } from "@jobcopilot/shared"
import { protocolScope } from "../approval/types"
import { decideObjectiveApplicationApprovalSetMemberInTransaction } from "./objective-application-approval-set-decision"

const mocks = vi.hoisted(() => ({
  fence: vi.fn(async () => undefined),
  freshness: vi.fn(async () => undefined),
  resume: vi.fn(),
  append: vi.fn(),
}))

vi.mock("../source-material-fence", () => ({ acquireSourceMaterialFence: mocks.fence }))
vi.mock("../approval/decision", () => ({ assertApprovalFreshnessInTransaction: mocks.freshness }))
vi.mock("../approval/objective-application-resume-witness", () => ({ readObjectiveApplicationResumeWitness: mocks.resume }))
vi.mock("../session/fact-store", async () => {
  const { redactAgentEvent: redact } = await import("@jobcopilot/shared")
  return {
    appendAgentEventWithOutboxInTransaction: mocks.append.mockImplementation(async (rawTx: unknown, input: Record<string, unknown>) => {
      const tx = rawTx as FixtureTx
      const route = {
        sessionId: input.sessionId as string, turnId: input.turnId as string, itemId: (input.itemId ?? null) as string | null,
        taskId: (input.taskId ?? null) as string | null, actor: input.actor as string,
        correlationId: input.correlationId as string, causationId: (input.causationId ?? null) as string | null,
        outboxTopic: input.outboxTopic as string,
      }
      const safe = redact({ type: input.type as string, body: "", data: input.payload, routing: route }).data
      const event = { ...input, id: "event-" + String(tx.events.length + 1), payload: safe }
      tx.events.push(event)
      tx.outbox.push({ topic: input.outboxTopic, payload: { type: input.type, payload: safe } })
      return { event, duplicate: false }
    }),
  }
})

const userId = "00000000-0000-4000-8000-000000000001"
const sessionId = "00000000-0000-4000-8000-000000000002"
const turnId = "00000000-0000-4000-8000-000000000003"
const sourceTurnId = "00000000-0000-4000-8000-000000000004"
const setId = "set-approval-1"
const itemId = objectiveApplicationApprovalSetItemId(setId)
const now = new Date("2026-11-24T12:00:00.000Z")
const expiresAt = new Date("2026-12-01T12:00:00.000Z")
const setContent = parseObjectiveApplicationApprovalSet({
  schema: "objective-application-approval-set.v1", waitKind: "approval_set", setId, sourceTurnId,
  intentHash: "a".repeat(64), expiresAt: expiresAt.toISOString(),
  members: Array.from({ length: 6 }, (_, index) => ({ slotOrdinal: index + 1, approvalId: "approval-" + (index + 1) })),
})!

type Row = Record<string, any> // Fixture rows mirror mutable Prisma JSON records.
type Event = Record<string, any>
type FixtureTx = {
  events: Event[]; outbox: Event[]; $queryRaw: ReturnType<typeof vi.fn>
  agentSession: Row; agentTurn: Row; agentItem: Row; agentApproval: Row; agentEvent: Row
}
function resumeWitness(jobId: string, materialRevision = 3) {
  return buildObjectiveApplicationResumeWitness({
    userId, jobId, resumeId: "resume-" + jobId, finalResumeAssignmentRevision: 2, materialRevision,
    material: { name: "Tailored", content: { experience: ["verified"] }, templateId: "resume", templateOptions: null,
      kind: "adapted", targetJobId: jobId, parentResumeId: "resume-base", basicsDetached: false },
  })!
}
async function makeRows(statuses: readonly string[]) {
  return Promise.all(setContent.members.map(async (member, index) => {
    const jobId = "job-" + (index + 1), toolCallId = "call-" + (index + 1)
    const nonceHash = "sha256:" + String(index + 1).padStart(64, "0")
    const scope = { userId, sessionId, turnId, jobId, toolCallId, action: "review_application" as const,
      resourceHash: "sha256:" + "b".repeat(64), materialHash: "sha256:" + "c".repeat(64),
      answersHash: "sha256:" + "d".repeat(64), revision: 4, expiresAt }
    const scopeHash = await hashApprovalScope(protocolScope(scope, nonceHash))
    return { id: member.approvalId, userId, sessionId, turnId, taskId: null, jobId, toolCallId,
      type: "review_application", status: statuses[index] ?? "pending", revision: 4, scopeHash, nonceHash,
      resourceHash: scope.resourceHash, materialHash: scope.materialHash, answersHash: scope.answersHash,
      expiresAt, createdAt: now, updatedAt: now, decidedAt: statuses[index] === "approved" ? now : null, consumedAt: null,
      payload: { schema: "objective-application-approval-set-member.v1", setId, sourceTurnId, slotOrdinal: index + 1,
        proof: { resumeWitness: resumeWitness(jobId) } },
    }
  }))
}
function seededEvents(rows: Row[]) {
  return rows.filter(row => row.status === "approved").map(row => {
    const raw = { waitKind: "approval", waitId: row.id, itemId, turnId, toolCallId: row.toolCallId,
      status: "approved", nextTurnRevision: 5 }
    return { id: "prior-" + row.id, sessionId, turnId, itemId, taskId: null, type: "approval.resolved", actor: "user",
      correlationId: row.id, causationId: itemId, idempotencyKey: "objective-approval-set-command:prior-" + row.id,
      payload: redactAgentEvent({ type: "approval.resolved", body: "", data: raw, routing: {
        sessionId, turnId, itemId, taskId: null, actor: "user", correlationId: row.id, causationId: itemId, outboxTopic: "agent.session.event",
      } }).data }
  })
}
function fixture(rows: Row[]) {
  const events: Event[] = [], outbox: Event[] = []
  const session = { id: sessionId, status: "running" }, turn = { id: turnId, status: "waiting_for_approval", revision: 5 }
  const item = { id: itemId, sessionId, turnId, type: "approval_request", status: "started", revision: 0, content: setContent }
  const tx: FixtureTx = {
    events, outbox,
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = String((query as { sql?: unknown }).sql ?? "")
      if (sql.includes('FROM "agent_sessions"')) return [{ id: sessionId, status: session.status }]
      if (sql.includes('FROM "agent_turns"')) return [{ id: turnId, status: turn.status, revision: turn.revision }]
      if (sql.includes('FROM "agent_items"')) return [{ id: itemId }]
      if (sql.includes('FROM "agent_approvals"')) return rows.map(row => ({ id: row.id }))
      return []
    }),
    agentSession: {},
    agentTurn: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => where.id === sourceTurnId ? { id: sourceTurnId } : null),
      updateMany: vi.fn(async ({ data }: { data: Row }) => { turn.revision += data.revision.increment; return { count: 1 } }),
    },
    agentItem: {
      findFirst: vi.fn(async () => item),
      updateMany: vi.fn(async ({ data }: { data: Row }) => { item.status = data.status; item.revision += data.revision.increment; return { count: 1 } }),
    },
    agentApproval: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => rows.find(row => row.id === where.id) ?? null),
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = rows.find(candidate => candidate.id === where.id)
        if (!row || row.status !== "pending" || row.revision !== where.revision || row.scopeHash !== where.scopeHash) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      }),
    },
    agentEvent: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => events.find(event => event.idempotencyKey === where.idempotencyKey) ?? null),
    },
  }
  return { tx, rows, events, outbox, turn, item }
}
const request = (row: Row, decision: "approved" | "rejected" = "approved") => ({
  approvalId: row.id, userId, sessionId, expectedTurnId: turnId, expectedRevision: 5,
  expectedReceiptRevision: row.revision, expectedScopeHash: row.scopeHash,
  clientMessageId: "decision-" + row.id, decision, now,
})
const hooks = (overrides: Partial<Parameters<typeof decideObjectiveApplicationApprovalSetMemberInTransaction>[2]> = {}) => ({
  verifySource: vi.fn(async () => "current" as const),
  recordApprovedHandoff: vi.fn(async () => undefined),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fence.mockResolvedValue(undefined)
  mocks.freshness.mockResolvedValue(undefined)
})

describe("Objective application approval-set member decision", () => {
  it("expires the one stale member, closes once, emits one redacted completion and wake, and replays exactly", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), selected = rows[5]!
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) => resumeWitness(scope.jobId))
    const callbacks = hooks()
    for (const member of rows.slice(0, 5)) {
      const approval = await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(member), callbacks)
      expect(approval).toMatchObject({ status: "approved", setCompleted: false, nextTurnRevision: 5 })
    }
    expect(rows.slice(0, 5).map(row => row.status)).toEqual(Array(5).fill("approved"))
    expect(selected.status).toBe("pending")
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) => resumeWitness(scope.jobId, scope.jobId === selected.jobId ? 4 : 3))
    const first = await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(selected), callbacks)

    expect(first).toMatchObject({ disposition: "resolved", status: "expired", setCompleted: true, nextTurnRevision: 6 })
    expect(selected.status).toBe("expired")
    expect(rows.slice(0, 5).map(row => row.status)).toEqual(Array(5).fill("approved"))
    expect(fake.tx.agentItem.updateMany).toHaveBeenCalledOnce()
    expect(fake.tx.agentTurn.updateMany).toHaveBeenCalledOnce()
    expect(callbacks.verifySource).toHaveBeenCalledTimes(5)
    expect(callbacks.recordApprovedHandoff).toHaveBeenCalledTimes(5)

    const resolved = fake.events.find(event => event.type === "approval.resolved" && event.correlationId === rows[0]!.id)
    expect(resolved?.payload).toEqual({ waitKind: "approval", waitId: rows[0]!.id, itemId, turnId, toolCallId: rows[0]!.toolCallId, status: "approved", nextTurnRevision: 5 })
    const expired = fake.events.find(event => event.type === "approval.expired" && event.correlationId === selected.id)
    expect(expired?.payload).toMatchObject({ approvalId: selected.id, action: "review_application", revision: 4,
      requestedDecision: "approved", expectedTurnRevision: 5 })
    expect(expired?.payload).not.toHaveProperty("scopeHash")
    const completion = fake.events.find(event => event.type === "item.completed")
    const wake = fake.events.find(event => event.type === "turn.wakeup")
    expect(completion?.payload).toEqual({ itemId, status: "completed" })
    expect(wake?.causationId).toBe(completion?.id)
    expect(wake?.payload).toMatchObject({ waitKind: "approval_set", waitId: setId, itemId, turnId, toolCallId: null, status: "resolved", nextTurnRevision: 6 })
    expect(fake.outbox.filter(row => row.topic === "agent.turn.wakeup")).toHaveLength(1)
    expect(fake.tx.agentApproval.updateMany).toHaveBeenCalledTimes(6)

    const writes = { approval: fake.tx.agentApproval.updateMany.mock.calls.length, item: fake.tx.agentItem.updateMany.mock.calls.length,
      turn: fake.tx.agentTurn.updateMany.mock.calls.length, append: mocks.append.mock.calls.length }
    const duplicate = await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(selected), callbacks)
    expect(duplicate).toMatchObject({ disposition: "duplicate", status: "expired", setCompleted: true, nextTurnRevision: 6 })
    expect({ approval: fake.tx.agentApproval.updateMany.mock.calls.length, item: fake.tx.agentItem.updateMany.mock.calls.length,
      turn: fake.tx.agentTurn.updateMany.mock.calls.length, append: mocks.append.mock.calls.length }).toEqual(writes)

    const outboxApproval = fake.outbox.find(row => row.topic === "agent.session.event" && row.payload.type === "approval.expired")
    expect(outboxApproval?.payload.payload).toEqual(expired?.payload)
  })

  it("retires a pre-edited member on the first valid command while the other five finish the set", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), edited = rows[5]!
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) =>
      resumeWitness(scope.jobId, scope.jobId === edited.jobId ? 4 : 3))
    const callbacks = hooks()

    for (const [index, member] of rows.slice(0, 5).entries()) {
      const result = await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(member), callbacks)
      expect(result.status).toBe("approved")
      if (index === 0) {
        expect(result).toMatchObject({ setCompleted: false, nextTurnRevision: 5 })
        expect(rows.map(row => row.status)).toEqual(["approved", "pending", "pending", "pending", "pending", "expired"])
        expect(fake.tx.agentItem.updateMany).not.toHaveBeenCalled()
        expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
        expect(fake.outbox.filter(row => row.topic === "agent.turn.wakeup")).toHaveLength(0)
      }
      if (index === 4) expect(result).toMatchObject({ setCompleted: true, nextTurnRevision: 6 })
    }

    expect(rows.map(row => row.status)).toEqual(["approved", "approved", "approved", "approved", "approved", "expired"])
    expect(fake.tx.agentItem.updateMany).toHaveBeenCalledOnce()
    expect(fake.tx.agentTurn.updateMany).toHaveBeenCalledOnce()
    expect(callbacks.verifySource).toHaveBeenCalledTimes(5)
    expect(callbacks.recordApprovedHandoff).toHaveBeenCalledTimes(5)
    expect(fake.events.filter(event => event.type === "approval.resolved")).toHaveLength(5)
    expect(fake.events.filter(event => event.type === "approval.expired")).toHaveLength(1)
    expect(fake.outbox.filter(row => row.topic === "agent.turn.wakeup")).toHaveLength(1)
    const publicWrites = JSON.stringify({ events: fake.events, outbox: fake.outbox })
    for (const privateField of ["resumeWitness", "resourceHash", "materialHash", "answersHash", "scopeHash"])
      expect(publicWrites).not.toContain(privateField)

    const writes = { handoffs: callbacks.recordApprovedHandoff.mock.calls.length,
      approvals: fake.tx.agentApproval.updateMany.mock.calls.length, events: fake.events.length, outbox: fake.outbox.length }
    const duplicate = await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(rows[4]!), callbacks)
    expect(duplicate).toMatchObject({ disposition: "duplicate", status: "approved", setCompleted: true, nextTurnRevision: 6 })
    expect({ handoffs: callbacks.recordApprovedHandoff.mock.calls.length,
      approvals: fake.tx.agentApproval.updateMany.mock.calls.length, events: fake.events.length, outbox: fake.outbox.length }).toEqual(writes)
  })

  it("rolls back without member events or handoff when the exact source verifier fails", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), selected = rows[0]!
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) => resumeWitness(scope.jobId))
    const callbacks = hooks({ verifySource: vi.fn(async () => { throw new Error("source read failed") }) })

    await expect(decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(selected), callbacks))
      .rejects.toThrow("source read failed")
    expect(selected.status).toBe("pending")
    expect(fake.tx.agentApproval.updateMany).not.toHaveBeenCalled()
    expect(fake.tx.agentItem.updateMany).not.toHaveBeenCalled()
    expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
    expect(callbacks.recordApprovedHandoff).not.toHaveBeenCalled()
  })

  it("approves only the selected member while keeping the aggregate open for the other five", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), selected = rows[0]!
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) => resumeWitness(scope.jobId))
    const callbacks = hooks()
    const result = await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(selected), callbacks)

    expect(result).toMatchObject({ status: "approved", setCompleted: false, nextTurnRevision: 5 })
    expect(rows.filter(row => row.status === "approved").map(row => row.id)).toEqual([selected.id])
    expect(fake.tx.agentItem.updateMany).not.toHaveBeenCalled()
    expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(fake.events.filter(event => event.type === "turn.wakeup")).toHaveLength(0)
    expect(callbacks.verifySource).toHaveBeenCalledOnce()
    expect(callbacks.recordApprovedHandoff).toHaveBeenCalledOnce()
    expect(JSON.stringify(fake.outbox)).not.toContain("agent_action_reservations")
  })
})
