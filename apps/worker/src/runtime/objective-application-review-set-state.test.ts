import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA, OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA,
  hashApprovalScope, objectiveApplicationApprovalSetItemId, parseObjectiveApplicationApprovalSet,
} from "@jobcopilot/agent-protocol"
import { buildObjectiveApplicationResumeWitness, canonicalJson } from "@jobcopilot/shared"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"
import { protocolScope } from "./approval/types.js"
import {
  objectiveApplicationReviewApprovalId, objectiveApplicationReviewIntentHash, objectiveApplicationReviewSetId,
  objectiveApplicationReviewToolCallId, readObjectiveApplicationReviewSetState,
} from "./objective-application-review-set-state.js"

const userId = "review-owner-1", sessionId = "review-session-1", turnId = "review-turn-1", sourceTurnId = "objective-source-turn-1"
const now = new Date("2026-11-24T10:00:00.000Z"), expiresAt = new Date("2026-11-24T10:15:00.000Z")
const hash = (char: string) => `sha256:${char.repeat(64)}`
const selection = {
  schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, sourceTurnId, rootTaskId: "source-root-1",
  graphItemId: "task-graph:source-root-1", graphRevision: 9, slotOrdinals: [1, 2, 3, 4, 5, 6],
} as const
const setId = objectiveApplicationReviewSetId(sessionId, turnId)
const itemId = objectiveApplicationApprovalSetItemId(setId)
const intentHash = objectiveApplicationReviewIntentHash(selection)

type Row = Record<string, unknown>
type Scenario = Readonly<{ item: Row; approvals: readonly Row[]; events: readonly Row[]; wakeup?: Row; completed?: Row }>

async function makeScenario(mode: "pending" | "resolved", expiredTaskNull = false, commandExpiry: "valid" | "empty" | null = null): Promise<Scenario> {
  const members: Array<{ slotOrdinal: number; approvalId: string }> = []
  const approvals: Row[] = [], events: Row[] = []
  for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
    const approvalId = objectiveApplicationReviewApprovalId(setId, ordinal)
    const taskId = `application-task-${ordinal}`, jobId = `job-${ordinal}`
    const toolCallId = objectiveApplicationReviewToolCallId(setId, ordinal)
    const resumeWitness = buildObjectiveApplicationResumeWitness({
      userId, jobId, resumeId: `adapted-resume-${ordinal}`, finalResumeAssignmentRevision: 2, materialRevision: 3,
      material: { name: `Resume ${ordinal}`, content: { summary: `Candidate ${ordinal}` }, templateId: null,
        templateOptions: null, kind: "adapted", targetJobId: jobId, parentResumeId: "base-resume-1", basicsDetached: false },
    })!
    const source = { jobId, sourceTurnId, rootTaskId: selection.rootTaskId, graphItemId: selection.graphItemId,
      graphRevision: selection.graphRevision, finalItemId: "task-graph-final:source-root-1", slotOrdinal: ordinal,
      writerTaskId: `writer-${ordinal}`, reviewerTaskId: `reviewer-${ordinal}`, reviewerToolCallId: `review-tool-${ordinal}`,
      reviewHash: hash("a"), artifactId: `artifact-${ordinal}`, version: 4, contentHash: hash("b"), sourceDigest: hash("c") }
    const proof = { schema: "objective-application-review-member-proof.v1", source, resumeWitness }
    const materialProofHash = createHash("sha256").update(canonicalJson(proof)).digest("hex")
    const payload = { schema: "objective-application-approval-set-member.v1", setId, sourceTurnId, slotOrdinal: ordinal,
      proof: { ...proof, materialProofHash } }
    const resourceHash = bareHash(hashArtifactContent({ kind: "review_application", userId, sessionId, jobId, applicationTaskId: taskId, slotOrdinal: ordinal }))
    const materialHash = materialProofHash
    const answersHash = bareHash(hashArtifactContent({ kind: "review_application", formAnswers: null }))
    const nonceHash = "d".repeat(64), revision = 3
    const scope = protocolScope({ userId, sessionId, turnId, jobId, toolCallId, action: "review_application",
      resourceHash, materialHash, answersHash, revision, expiresAt }, nonceHash)
    const scopeHash = await hashApprovalScope(scope)
    const status = mode === "resolved" ? ordinal === 6 ? "expired" : "approved"
      : ordinal === 1 ? "approved" : "pending"
    const row: Row = { id: approvalId, sessionId, turnId, userId, taskId, jobId, toolCallId, type: "review_application", status,
      payload, resourceHash, materialHash, answersHash, scopeHash, nonceHash, revision,
      expiresAt, decidedAt: status === "pending" ? null : now, consumedAt: null }
    approvals.push(row)
    members.push({ slotOrdinal: ordinal, approvalId })
    events.push({ id: `requested-${ordinal}`, sessionId, turnId, itemId: null, taskId, type: "approval.requested", actor: "orchestrator",
      correlationId: approvalId, causationId: null, idempotencyKey: `approval:${approvalId}:requested`,
      payload: { action: "review_application", approvalId, revision, scopeHash } })
    if (status === "approved") events.push({ id: `resolved-${ordinal}`, sessionId, turnId, itemId, taskId,
      type: "approval.resolved", actor: "user", correlationId: approvalId, causationId: itemId,
      idempotencyKey: `objective-approval-set-command:decision-${ordinal}`,
      payload: { waitKind: "approval", waitId: approvalId, itemId, turnId,
        toolCallId, status, nextTurnRevision: 12 } })
    if (status === "expired") events.push({ id: `expired-${ordinal}`, sessionId, turnId, itemId: null,
      taskId: expiredTaskNull ? null : taskId, type: "approval.expired", actor: "system", correlationId: approvalId,
      causationId: itemId, idempotencyKey: commandExpiry ? `objective-approval-set-command:${commandExpiry === "valid" ? "decision-6" : ""}`
        : `approval-set:${setId}:${approvalId}:expired`,
      payload: { approvalId, action: "review_application", revision,
        ...(commandExpiry ? { requestedDecision: "approved", expectedTurnRevision: 12 } : {}) } })
  }
  const content = parseObjectiveApplicationApprovalSet({ schema: OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA,
    waitKind: "approval_set", setId, sourceTurnId, intentHash, expiresAt: expiresAt.toISOString(), members })!
  const resolved = mode === "resolved"
  const item: Row = { id: itemId, sessionId, turnId, stepId: null, taskId: null, type: "approval_request",
    status: resolved ? "completed" : "started", phase: "commentary", revision: resolved ? 1 : 0,
    content, startedAt: now, completedAt: resolved ? now : null }
  if (!resolved) return { item, approvals, events }
  const completed: Row = { id: "completed-event-1", sessionId, turnId, itemId, taskId: null, type: "item.completed", actor: "orchestrator",
    correlationId: itemId, causationId: itemId, idempotencyKey: `agent-wait:${itemId}:completed`, payload: { itemId, status: "completed" } }
  const wakeup: Row = { eventId: "wakeup-event-1", id: "wakeup-event-1", sessionId, turnId, itemId, type: "turn.wakeup", actor: "user",
    taskId: null, correlationId: turnId, causationId: completed.id, idempotencyKey: `approval-set:${setId}:wakeup`,
    payload: { waitKind: "approval_set", waitId: setId, itemId, turnId, toolCallId: null, status: "resolved", nextTurnRevision: 13 } }
  return { item, approvals, events: [...events, completed, wakeup], wakeup, completed }
}

function bareHash(value: string): string { return value.startsWith("sha256:") ? value.slice(7) : value }

function fakeClient(scenario: Scenario) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM "agent_items"') && sql.includes('WHERE "id"=$1')) return { rows: [scenario.item], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"') && sql.includes("'completed'")) return { rows: [{ id: sourceTurnId,
      rootTaskId: selection.rootTaskId, source: "user", executionMode: "canonical_task_graph" }], rowCount: 1 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: scenario.approvals, rowCount: scenario.approvals.length }
    if (sql.includes('FROM "agent_events"')) {
      const key = params?.[3]
      if (typeof key === "string" && key.startsWith("approval:")) {
        return { rows: scenario.events.filter(event => event.idempotencyKey === key), rowCount: 1 }
      }
      if (sql.includes('"id" = $1')) {
        const event = scenario.events.find(value => value.id === params?.[0])
        return { rows: event ? [event] : [], rowCount: event ? 1 : 0 }
      }
      if (sql.includes("'item.started'")) return { rows: [{ id: "started-event-1", sessionId, turnId, itemId, taskId: null,
        type: "item.started", actor: "orchestrator", correlationId: itemId, causationId: null,
        idempotencyKey: `agent-wait:${itemId}:started`, payload: { itemId, memberCount: 6, setId, waitKind: "approval_set" } }], rowCount: 1 }
      if (sql.includes("'approval.resolved'") && sql.includes("'approval.expired'")) {
        return { rows: scenario.events.filter(event => event.type === "approval.resolved" || event.type === "approval.expired"), rowCount: 6 }
      }
      if (sql.includes("'turn.wakeup'")) {
        const wakes = scenario.wakeup ? [scenario.wakeup] : []
        return { rows: wakes, rowCount: wakes.length }
      }
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })
  return { query } as unknown as Parameters<typeof readObjectiveApplicationReviewSetState>[0]
}

describe("Worker Objective application review-set state", () => {
  it("retains a pending aggregate while some member decisions are already durable", async () => {
    const scenario = await makeScenario("pending")
    const state = await readObjectiveApplicationReviewSetState(fakeClient(scenario), { userId, sessionId, turnId, selection, now })
    expect(state?.status).toBe("pending")
    expect(state?.members.map(member => member.status)).toEqual(["approved", "pending", "pending", "pending", "pending", "pending"])
    expect(state?.wakeup).toBeUndefined()
  })

  it("accepts five approved and one expired member with the real task-linked expiry event", async () => {
    const scenario = await makeScenario("resolved")
    const state = await readObjectiveApplicationReviewSetState(fakeClient(scenario), { userId, sessionId, turnId, selection, now })
    expect(state?.status).toBe("resolved")
    expect(state?.members.map(member => member.status)).toEqual(["approved", "approved", "approved", "approved", "approved", "expired"])
    expect(state?.members[5]?.applicationTaskId).toBe("application-task-6")
    expect(state?.wakeup).toMatchObject({ waitKind: "approval_set", waitId: setId, itemId, status: "resolved", toolCallId: null })
  })

  it("accepts command-expiry lineage with a nonempty key and matching pre-completion revision", async () => {
    const scenario = await makeScenario("resolved", false, "valid")
    const state = await readObjectiveApplicationReviewSetState(fakeClient(scenario), { userId, sessionId, turnId, selection, now })
    expect(state?.status).toBe("resolved")
  })

  it("fails closed when an expired event omits the actual member task ID", async () => {
    const scenario = await makeScenario("resolved", true)
    await expect(readObjectiveApplicationReviewSetState(fakeClient(scenario), { userId, sessionId, turnId, selection, now })).resolves.toBeUndefined()
  })

  it("rejects a command-expiry event with an empty command idempotency suffix", async () => {
    const scenario = await makeScenario("resolved", false, "empty")
    await expect(readObjectiveApplicationReviewSetState(fakeClient(scenario), { userId, sessionId, turnId, selection, now })).resolves.toBeUndefined()
  })
})
