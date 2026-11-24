import { createHash } from "node:crypto"
import { hashApprovalNonce, hashApprovalScope, type ApprovalScope } from "@jobcopilot/agent-protocol"
import { buildAgentSelectedJobMaterial, hashReviewedApplicationMaterialProof } from "@jobcopilot/shared"
import { describe, expect, it, vi } from "vitest"

import { hashArtifactContent } from "../artifacts/hash"
import { readReviewedApplicationReviewDecision } from "./reviewed-application-review-decision"

const now = new Date("2026-11-21T12:00:00.000Z"), nonce = "current-nonce-1"
const ids = { userId: "user-1", sessionId: "session-1", reviewTurnId: "review-turn-1", sourceTurnId: "source-turn-1",
  appTaskId: "application-task-1", jobId: "job-1", rootTaskId: "source-root-1", resumeId: "resume-1", artifactId: "cover-artifact-1" }
const job = { id: ids.jobId, company: "Example GmbH", role: "Engineer", location: "Berlin", status: "saved", score: 8,
  url: "https://jobs.example/1", source: "greenhouse", salary: "EUR 80k", description: "Build systems", keywords: "TypeScript" }
const resume = { id: ids.resumeId, name: "Base", kind: "base", origin: "manual", isDefault: true,
  content: { text: "Engineer with TypeScript experience" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }
const personaFacts = [{ id: "fact-1", key: "language", category: "language", value: "English C1", source: "resume",
  sourceRef: "resume:language", confidence: 0.98, allowedUses: ["cover_letter"] }]

async function fixture() {
  const current = buildAgentSelectedJobMaterial({ job, baseResume: resume, personaFacts })
  const content = "A reviewed cover letter for this job."
  const proof = { jobId: ids.jobId, sourceTurnId: ids.sourceTurnId, rootTaskId: ids.rootTaskId, graphRevision: 4,
    writerTaskId: "writer-task-1", reviewerTaskId: "reviewer-task-1", reviewerToolCallId: "review-tool-1",
    reviewHash: `sha256:${"a".repeat(64)}`, artifactId: ids.artifactId, version: 2,
    contentHash: hashArtifactContent(content), sourceDigest: current.preparation.sourceDigest }
  const task = { id: ids.appTaskId, userId: ids.userId, sessionId: ids.sessionId, jobId: ids.jobId, resumeId: ids.resumeId,
    coverLetterId: null, confirmedAnswers: null, status: "waiting_for_user", checkpoint: "materials_ready", workerTaskId: null,
    startedAt: null, completedAt: null, fillTurnId: null, fillTurnSessionId: null, fillTurnUserId: null }
  const [materialHash, nonceHash] = await Promise.all([hashReviewedApplicationMaterialProof(proof), hashApprovalNonce(nonce)])
  const resourceHash = bare(hashArtifactContent({ kind: "review_application", userId: ids.userId, sessionId: ids.sessionId,
    jobId: ids.jobId, applicationTaskId: ids.appTaskId }))
  const answersHash = bare(hashArtifactContent({ kind: "review_application", formAnswers: null }))
  if (!materialHash) throw new Error("invalid test fixture")
  const approvalId = `reviewed-application-review:${ids.reviewTurnId}`
  const toolCallId = `review_application:${ids.reviewTurnId}`
  const expiresAt = new Date("2026-11-22T12:00:00.000Z")
  const scope: ApprovalScope = { userId: ids.userId, sessionId: ids.sessionId, turnId: ids.reviewTurnId, jobId: ids.jobId,
    toolCallId, action: "review_application", resourceHash, materialHash, answersHash, revision: 0, nonceHash, expiresAt: expiresAt.toISOString() }
  const approval = { id: approvalId, userId: ids.userId, sessionId: ids.sessionId, turnId: ids.reviewTurnId,
    taskId: ids.appTaskId, jobId: ids.jobId, toolCallId, type: "review_application", status: "pending", title: "Review application",
    body: "Approval unlocks form-fill only.", impact: { externalSubmission: false, jobId: ids.jobId },
    payload: { applicationTaskId: ids.appTaskId, jobId: ids.jobId }, resourceHash, materialHash, answersHash,
    scopeHash: await hashApprovalScope(scope), nonceHash, revision: 0, expiresAt, decidedAt: null, consumedAt: null }
  const receiptScope = { action: "review_application", toolCallId, resourceHash, materialHash, answersHash, revision: 0, expiresAt: expiresAt.toISOString() }
  const issuedPayload = { schemaVersion: "agent-harness.v2.reviewed-application-review-binding.v1", approvalId,
    reviewTurnId: ids.reviewTurnId, applicationTaskId: ids.appTaskId, userId: ids.userId, sessionId: ids.sessionId,
    jobId: ids.jobId, proof, receiptScope }
  const reviewTurn = { id: ids.reviewTurnId, userId: ids.userId, sessionId: ids.sessionId, source: "user",
    executionMode: "canonical_task_graph", status: "waiting_for_approval", revision: 1,
    input: { clientMessageId: "review-message-1", intent: { kind: "reviewed_application_review", version: 1,
      sourceTurnId: ids.sourceTurnId, jobId: ids.jobId } } as Record<string, unknown> }
  const sourceTurn = { id: ids.sourceTurnId, userId: ids.userId, sessionId: ids.sessionId, source: "user",
    executionMode: "canonical_task_graph", status: "completed", rootTaskId: ids.rootTaskId,
    input: { clientMessageId: "source-message-1", content: [], goal: "Prepare this selected job", selectedJobPreparation: { jobId: ids.jobId } } }
  const issueEvent = { id: "issue-event-1", taskId: ids.appTaskId, type: "reviewed_application_review_issued", actor: "worker" as string,
    body: "Reviewed application approval binding recorded.", data: issuedPayload }
  const requestEvent = { id: "request-event-1", sessionId: ids.sessionId, turnId: ids.reviewTurnId, itemId: null,
    taskId: ids.appTaskId, type: "approval.requested", actor: "orchestrator", correlationId: approvalId,
    idempotencyKey: `approval:${approvalId}:requested`, payload: { approvalId, action: "review_application", scopeHash: approval.scopeHash, revision: 0 } }
  const waitItem = { id: `agent-wait:approval:${approvalId}`, sessionId: ids.sessionId, turnId: ids.reviewTurnId,
    stepId: null, taskId: null as string | null, type: "approval_request", status: "started", phase: "commentary", revision: 0,
    content: { waitKind: "approval", approvalId, toolCallId, action: "review_application", title: approval.title, body: approval.body,
      impact: approval.impact, scopeHash: approval.scopeHash, receiptRevision: 0, expiresAt: expiresAt.toISOString(), decision: null },
    startedAt: now, completedAt: null }
  const jobRow = { ...job, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z") }
  const resumeRow = { ...resume, createdAt: new Date(resume.createdAt), updatedAt: new Date(resume.updatedAt) }
  const sourceRows = { job: [jobRow], resume: [resumeRow], persona: personaFacts }
  const version = { id: "version-1", artifactId: ids.artifactId, version: proof.version, userId: ids.userId,
    sessionId: ids.sessionId, jobId: ids.jobId, artifactType: "cover_letter", content, contentHash: proof.contentHash,
    sourceDigest: proof.sourceDigest, taskId: proof.writerTaskId }
  const head = { id: ids.artifactId, userId: ids.userId, jobId: ids.jobId, artifactType: "cover_letter", lifecycle: "draft",
    content: { kind: "agent_artifact_version", artifactId: ids.artifactId, version: proof.version, contentHash: proof.contentHash },
    hash: proof.contentHash, version: proof.version }
  const review = { id: "review-1", artifactVersionId: version.id, userId: ids.userId, sessionId: ids.sessionId, jobId: ids.jobId,
    artifactId: ids.artifactId, version: proof.version, contentHash: proof.contentHash, sourceDigest: proof.sourceDigest,
    currentSourceDigest: proof.sourceDigest, status: "passed", taskId: proof.reviewerTaskId,
    toolCallId: proof.reviewerToolCallId, reviewHash: proof.reviewHash }
  const rootTask = { id: ids.rootTaskId, sessionId: ids.sessionId, turnId: ids.sourceTurnId,
    rootTaskId: ids.rootTaskId, parentTaskId: null, role: "orchestrator", taskType: "root", depth: 0, status: "completed" }
  const graphId = `task-graph-${createHash("sha256").update(ids.rootTaskId).digest("hex")}`
  const graph = { id: graphId, sessionId: ids.sessionId, turnId: ids.sourceTurnId, taskId: ids.rootTaskId, type: "task_graph", revision: proof.graphRevision }
  const rawQueries: Array<{ sql: string; values: readonly unknown[] }> = []
  const tx = {
    agentApproval: { findFirst: vi.fn(async () => approval) },
    agentTurn: { findMany: vi.fn(async ({ where }: { where: { id: string } }) => where.id === ids.reviewTurnId ? [reviewTurn] : [sourceTurn]) },
    applicationTaskEvent: { findMany: vi.fn(async ({ where }: { where: { taskId: string; type: string; data: { path: string[]; equals: string } } }) =>
      where.taskId === ids.appTaskId && where.type === issueEvent.type && where.data.equals === ids.reviewTurnId ? [issueEvent] : []) },
    agentEvent: { findMany: vi.fn(async () => [requestEvent]) },
    agentItem: { findMany: vi.fn(async ({ where }: { where: { id: string; sessionId: string; turnId: string; taskId?: string; type: string } }) =>
      where.type === "task_graph" && where.id === graph.id && where.sessionId === ids.sessionId
        && where.turnId === ids.sourceTurnId && where.taskId === ids.rootTaskId ? [graph] : [waitItem]) },
    applicationTask: { findMany: vi.fn(async ({ where }: { where: { id: string; userId: string; sessionId: string; jobId: string } }) =>
      where.id === task.id && where.userId === ids.userId && where.sessionId === ids.sessionId && where.jobId === ids.jobId ? [task] : []) },
    resume: { findMany: vi.fn(async ({ where }: { where: { id: string; userId: string; kind: string } }) =>
      where.id === ids.resumeId && where.userId === ids.userId && where.kind === "base" ? [{ id: ids.resumeId }] : []) },
    subAgentTask: { findMany: vi.fn(async ({ where }: { where: { id: string; sessionId: string; turnId: string } }) =>
      where.id === rootTask.id && where.sessionId === ids.sessionId && where.turnId === ids.sourceTurnId ? [rootTask] : []) },
    agentArtifact: { findMany: vi.fn(async () => [head]) },
    agentArtifactVersion: { findMany: vi.fn(async () => [version]) },
    agentArtifactReview: { findMany: vi.fn(async () => [review]) },
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      rawQueries.push({ sql, values })
      return sql.includes('FROM "Job"') ? sourceRows.job : sql.includes('FROM "Resume"') ? sourceRows.resume : sourceRows.persona
    }),
  }
  return { tx, approval, scope, reviewTurn, sourceTurn, issueEvent, requestEvent, waitItem, task, proof, rawQueries, sourceRows }
}

describe("readReviewedApplicationReviewDecision", () => {
  it("returns only the source Turn for an exact approved reviewed application", async () => {
    const state = await fixture()
    const result = await readReviewedApplicationReviewDecision(state.tx as never, {
      ...ids, approvalId: state.approval.id, decision: "approved", now, receiptNonce: nonce,
    })
    expect(result).toEqual({ status: "reviewed_approved", sourceTurnId: ids.sourceTurnId })
    expect(JSON.stringify(result)).not.toMatch(/nonce|cover-artifact|Reviewed cover letter|proof/)
    expect(state.rawQueries).toHaveLength(3)
    expect(state.rawQueries.every(query => query.sql.trimStart().startsWith("SELECT") && query.values.length > 0)).toBe(true)
  })

  it("allows rejection from the exact receipt and Wait after selected source content changes without requiring nonce", async () => {
    const state = await fixture()
    state.sourceRows.job[0]!.company = "Changed after issuance"
    const result = await readReviewedApplicationReviewDecision(state.tx as never, {
      ...ids, approvalId: state.approval.id, decision: "rejected", now,
    })

    expect(result).toEqual({ status: "reviewed_rejected" })
    expect(state.rawQueries).toHaveLength(0)
    expect(state.tx.agentArtifact.findMany).not.toHaveBeenCalled()
  })

  it("keeps unmarked scoped legacy approvals on the legacy path", async () => {
    const state = await fixture()
    state.approval.id = "legacy-approval-1"
    state.approval.toolCallId = "application-review:legacy-call"
    state.reviewTurn.input = { clientMessageId: "legacy-message-1" }
    state.tx.applicationTaskEvent.findMany.mockResolvedValue([])

    await expect(readReviewedApplicationReviewDecision(state.tx as never, {
      ...ids, approvalId: state.approval.id, decision: "approved", now,
    })).resolves.toEqual({ status: "legacy" })
  })

  it.each(["malformed intent", "wrong issuer", "wait item task binding"])("fails closed for %s without legacy downgrade", async mode => {
    const state = await fixture()
    if (mode === "malformed intent") state.reviewTurn.input = { ...state.reviewTurn.input,
      intent: { ...(state.reviewTurn.input.intent as Record<string, unknown>), version: 2 } }
    if (mode === "wrong issuer") state.issueEvent.actor = "user"
    if (mode === "wait item task binding") state.waitItem.taskId = ids.appTaskId

    await expect(readReviewedApplicationReviewDecision(state.tx as never, {
      ...ids, approvalId: state.approval.id, decision: "approved", now, receiptNonce: nonce,
    })).resolves.toEqual({ status: "unavailable" })
  })

  it.each(["missing nonce", "wrong nonce", "wrong client source", "changed current source"])("denies approval with %s", async mode => {
    const state = await fixture()
    if (mode === "changed current source") state.sourceRows.job[0]!.company = "Changed after issuance"
    const result = await readReviewedApplicationReviewDecision(state.tx as never, {
      ...ids, approvalId: state.approval.id, decision: "approved",
      ...(mode === "missing nonce" ? {} : { receiptNonce: mode === "wrong nonce" ? "other-nonce" : nonce }),
      ...(mode === "wrong client source" ? { requestedSourceTurnId: "other-source-turn" } : {}), now,
    })
    expect(result).toEqual({ status: "unavailable" })
  })

  it("accepts the current rotated scope while retaining the immutable requested event hash", async () => {
    const state = await fixture(), rotatedNonce = "rotated-nonce-2"
    state.approval.nonceHash = await hashApprovalNonce(rotatedNonce)
    state.approval.scopeHash = await hashApprovalScope({ ...state.scope, nonceHash: state.approval.nonceHash } as ApprovalScope)
    state.waitItem.content.scopeHash = state.approval.scopeHash
    expect(state.requestEvent.payload.scopeHash).not.toBe(state.approval.scopeHash)
    await expect(readReviewedApplicationReviewDecision(state.tx as never, {
      ...ids, approvalId: state.approval.id, decision: "approved", now, receiptNonce: rotatedNonce,
    })).resolves.toEqual({ status: "reviewed_approved", sourceTurnId: ids.sourceTurnId })
  })

  it("does not downgrade a stable reviewed approval when its private binding is missing", async () => {
    const state = await fixture()
    state.tx.applicationTaskEvent.findMany.mockResolvedValue([])
    await expect(readReviewedApplicationReviewDecision(state.tx as never, {
      ...ids, approvalId: state.approval.id, decision: "approved", now, receiptNonce: nonce,
    })).resolves.toEqual({ status: "unavailable" })
  })
})

function bare(value: string): string { return value.startsWith("sha256:") ? value.slice(7) : value }
