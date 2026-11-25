import { beforeEach, describe, expect, it, vi } from "vitest"
import { hashApprovalScope, parseObjectiveApplicationApprovalSet, objectiveApplicationApprovalSetItemId } from "@jobcopilot/agent-protocol"
import { buildObjectiveApplicationResumeWitness, buildObjectiveApplicationReviewMemberProof, redactAgentEvent } from "@jobcopilot/shared"
import { ApprovalStoreError, protocolScope } from "../approval/types"
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
  agentSession: Row; agentTurn: Row; agentItem: Row; agentApproval: Row; agentEvent: Row; applicationTask: Row; applicationTaskEvent: Row
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
    const proof = buildObjectiveApplicationReviewMemberProof({ resumeWitness: resumeWitness(jobId), source: {
      jobId, sourceTurnId, rootTaskId: "source-root-1", graphItemId: "source-graph-1", graphRevision: 9,
      finalItemId: "source-final-1", slotOrdinal: index + 1, writerTaskId: `writer-${index + 1}`, reviewerTaskId: `reviewer-${index + 1}`,
      reviewerToolCallId: `review-call-${index + 1}`, reviewHash: `sha256:${"a".repeat(64)}`, artifactId: `artifact-${index + 1}`,
      version: 4, contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
    } })!
    const nonceHash = "sha256:" + String(index + 1).padStart(64, "0")
    const scope = { userId, sessionId, turnId, jobId, toolCallId, action: "review_application" as const,
      resourceHash: "sha256:" + "b".repeat(64), materialHash: proof.materialProofHash,
      answersHash: "sha256:" + "d".repeat(64), revision: 4, expiresAt }
    const scopeHash = await hashApprovalScope(protocolScope(scope, nonceHash))
    return { id: member.approvalId, userId, sessionId, turnId, taskId: `application-task-${index + 1}`, jobId, toolCallId,
      type: "review_application", status: statuses[index] ?? "pending", revision: 4, scopeHash, nonceHash,
      resourceHash: scope.resourceHash, materialHash: scope.materialHash, answersHash: scope.answersHash,
      expiresAt, createdAt: now, updatedAt: now, decidedAt: statuses[index] === "approved" ? now : null, consumedAt: null,
      payload: { schema: "objective-application-approval-set-member.v1", setId, sourceTurnId, slotOrdinal: index + 1,
        proof },
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
  const events: Event[] = [], outbox: Event[] = [], taskEvents: Event[] = []
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
    applicationTask: { findMany: vi.fn(async ({ where }: { where: Row }) => [{ id: where.id, userId: where.userId,
      sessionId: where.sessionId, jobId: where.jobId }]) },
    applicationTaskEvent: {
      findMany: vi.fn(async ({ where }: { where: Row }) => taskEvents.filter(event => event.taskId === where.taskId
        && event.type === where.type && (event.data as Row)?.approvalId === (where.data as Row).equals)),
      findUnique: vi.fn(async ({ where }: { where: Row }) => taskEvents.find(event => event.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => { taskEvents.push(data); return data }),
    },
  }
  return { tx, rows, events, outbox, taskEvents, turn, item }
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
      turn: fake.tx.agentTurn.updateMany.mock.calls.length, append: mocks.append.mock.calls.length,
      retirement: fake.tx.applicationTaskEvent.create.mock.calls.length }
    const duplicate = await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(selected), callbacks)
    expect(duplicate).toMatchObject({ disposition: "duplicate", status: "expired", setCompleted: true, nextTurnRevision: 6 })
    expect({ approval: fake.tx.agentApproval.updateMany.mock.calls.length, item: fake.tx.agentItem.updateMany.mock.calls.length,
      turn: fake.tx.agentTurn.updateMany.mock.calls.length, append: mocks.append.mock.calls.length,
      retirement: fake.tx.applicationTaskEvent.create.mock.calls.length }).toEqual(writes)
    expect(fake.taskEvents).toHaveLength(1)
    expect(fake.taskEvents[0]).toMatchObject({ id: `objective-application-review-retired:${setId}:6`,
      taskId: selected.taskId, type: "objective_application_review_retired", actor: "system",
      body: "Objective application review member was retired.", data: { schemaVersion: "objective-application-review-retirement.v1",
        userId, sessionId, reviewTurnId: turnId, sourceTurnId, setId, slotOrdinal: 6, jobId: selected.jobId,
        applicationTaskId: selected.taskId, approvalId: selected.id, receiptRevision: 4, reason: "resume_material_changed" } })

    const outboxApproval = fake.outbox.find(row => row.topic === "agent.session.event" && row.payload.type === "approval.expired")
    expect(outboxApproval?.payload.payload).toEqual(expired?.payload)
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
    expect(fake.tx.applicationTaskEvent.create).not.toHaveBeenCalled()
    expect(callbacks.recordApprovedHandoff).not.toHaveBeenCalled()
  })

  it("records TTL before other stale observations", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), selected = rows[0]!
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) => resumeWitness(scope.jobId))
    mocks.freshness.mockRejectedValue(new ApprovalStoreError("approval_revision_mismatch", "stale"))
    const expiredAt = new Date(expiresAt.getTime() + 1)
    await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, { ...request(selected), now: expiredAt }, hooks())
    expect(fake.taskEvents).toHaveLength(6)
    expect((fake.taskEvents[0]?.data as Row).reason).toBe("approval_ttl_reached")
    expect(mocks.freshness).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  it("still closes an expired set when a deleted member task cannot hold private retirement evidence", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), selected = rows[2]!
    fake.tx.applicationTask.findMany.mockImplementation(async ({ where }: { where: Row }) =>
      where.id === selected.taskId ? [] : [{ id: where.id, userId: where.userId, sessionId: where.sessionId, jobId: where.jobId }])
    mocks.freshness.mockRejectedValue(new ApprovalStoreError("approval_revision_mismatch", "stale"))
    const result = await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never,
      { ...request(selected), now: new Date(expiresAt.getTime() + 1) }, hooks())
    expect(result).toMatchObject({ status: "expired", setCompleted: true })
    expect(fake.events.filter(event => event.type === "approval.expired")).toHaveLength(6)
    expect(fake.events.filter(event => event.type === "turn.wakeup")).toHaveLength(1)
    expect(fake.taskEvents).toHaveLength(5)
    expect(fake.taskEvents.some(event => event.taskId === selected.taskId)).toBe(false)
  })

  it("records receipt revision before Resume drift and isolates the affected member", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), selected = rows[2]!
    mocks.freshness.mockImplementation(async (...args: unknown[]) => {
      const scope = args[1] as { id: string }
      if (scope.id === selected.id) throw new ApprovalStoreError("approval_revision_mismatch", "stale")
    })
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) => scope.jobId === selected.jobId
      ? null : resumeWitness(scope.jobId))
    await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(selected), hooks())
    expect(fake.taskEvents).toHaveLength(1)
    expect((fake.taskEvents[0]?.data as Row).reason).toBe("approval_revision_changed")
    expect(mocks.resume).not.toHaveBeenCalledWith(expect.anything(), { userId, jobId: selected.jobId })
  })

  it("records a missing Resume witness separately from changed material", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), selected = rows[0]!
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) => scope.jobId === selected.jobId
      ? null : resumeWitness(scope.jobId))
    await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(selected), hooks())
    expect(fake.taskEvents).toHaveLength(1)
    expect((fake.taskEvents[0]?.data as Row).reason).toBe("resume_witness_unavailable")
  })

  it("records exact completed-source drift only after current receipt and Resume proofs", async () => {
    const rows = await makeRows(Array(6).fill("pending")), fake = fixture(rows), selected = rows[0]!
    mocks.resume.mockImplementation(async (_tx: unknown, scope: { jobId: string }) => resumeWitness(scope.jobId))
    const callbacks = hooks({ verifySource: vi.fn(async () => "stale" as const) })
    await decideObjectiveApplicationApprovalSetMemberInTransaction(fake.tx as never, request(selected), callbacks)
    expect(fake.taskEvents).toHaveLength(1)
    expect((fake.taskEvents[0]?.data as Row).reason).toBe("completed_source_changed")
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
