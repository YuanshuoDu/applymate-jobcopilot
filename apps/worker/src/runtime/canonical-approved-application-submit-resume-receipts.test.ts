import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import { buildApplicationSubmissionManifest, hashAgentReceiptValue, hashApplicationSubmissionMaterial } from "@jobcopilot/shared"
import { protocolScope } from "./approval/types.js"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"
import { readCanonicalApprovedApplicationSubmitReceipts } from "./canonical-approved-application-submit-resume-receipts.js"

const verifier = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("../db/application-task-completion.js", () => ({ verifyExistingApplicationFillCompletion: verifier.run }))

const NOW = new Date("2026-11-22T12:00:00.000Z")
const lease = { userId: "user-a", sessionId: "session-a", turnId: "turn-a", ownerId: "owner-a", leaseVersion: 3,
  leaseStartedAt: new Date("2026-11-22T11:00:00.000Z"), leaseExpiresAt: new Date("2026-11-22T12:01:00.000Z") }
const taskBase = { id: "application-a", userId: "user-a", sessionId: "session-a", jobId: "job-a", fillTurnId: "turn-a",
  fillTurnSessionId: "session-a", fillTurnUserId: "user-a", resumeId: "resume-a", coverLetterId: null,
  confirmedAnswers: { eligible: "yes" }, question: null }
const material = { applicationTaskId: taskBase.id, jobId: taskBase.jobId, resumeId: taskBase.resumeId, coverLetterId: null }

async function fixture(state: "form_filled" | "submission_authorized" = "form_filled", options: { waitStatus?: string; eventStatus?: string; missingIntent?: "event" | "outbox"; jobState?: string } = {}) {
  const approvalId = `application-fill:${taskBase.id}:${lease.turnId}`, waitItemId = `agent-wait:approval:${approvalId}`
  const answersHash = await hashAgentReceiptValue("answers", taskBase.confirmedAnswers)
  const materialHash = await hashApplicationSubmissionMaterial(material)
  if (!answersHash || !materialHash) throw new Error("receipt fixture hash unavailable")
  const manifest = buildApplicationSubmissionManifest(material, answersHash)
  if (!manifest) throw new Error("receipt fixture manifest unavailable")
  const resourceHash = hashArtifactContent(manifest).slice("sha256:".length), revision = 9, nextTurnRevision = revision + 2
  const nonceHash = "a".repeat(64), scopeHash = await hashApprovalScope(protocolScope({
    userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, jobId: taskBase.jobId,
    toolCallId: `application-submit:${taskBase.id}`, action: "submit_application", resourceHash, materialHash,
    answersHash, revision, expiresAt: new Date("2026-11-22T12:15:00.000Z"),
  }, nonceHash))
  const expiresAt = new Date("2026-11-22T12:15:00.000Z"), decidedAt = new Date("2026-11-22T11:59:00.000Z")
  const approval = { id: approvalId, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, taskId: taskBase.id,
    jobId: taskBase.jobId, type: "submit_application", status: options.waitStatus ?? "approved", title: "Final submission authorization",
    body: "The form was filled without submission. Review the current job, material alignment, required answers, and sensitive declarations before authorizing an external submission.",
    impact: { externalSubmission: true, jobId: taskBase.jobId }, payload: { applicationTaskId: taskBase.id, coverLetterId: taskBase.coverLetterId,
      jobId: taskBase.jobId, resumeId: taskBase.resumeId },
    resourceHash, materialHash, answersHash, scopeHash, nonceHash, toolCallId: `application-submit:${taskBase.id}`, revision, expiresAt, decidedAt,
    consumedAt: null, waitItemId, waitStepId: null, waitTaskId: null, waitType: "approval_request", waitStatus: "completed",
    waitPhase: "commentary", waitRevision: 1, waitContent: { waitKind: "approval", approvalId, toolCallId: `application-submit:${taskBase.id}`,
      action: "submit_application", title: "Final submission authorization",
      body: "The form was filled without submission. Review the current job, material alignment, required answers, and sensitive declarations before authorizing an external submission.",
      impact: { externalSubmission: true, jobId: taskBase.jobId }, scopeHash, receiptRevision: revision, expiresAt: expiresAt.toISOString(),
      decision: "approved", responseAvailable: true, respondedAt: decidedAt.toISOString() },
    resolvedActor: "user", resolvedTaskId: taskBase.id, resolvedItemId: waitItemId, resolvedType: "approval.resolved",
    resolvedCorrelationId: approvalId, resolvedPayload: { waitKind: "approval", waitId: approvalId, itemId: waitItemId, turnId: lease.turnId,
      toolCallId: `application-submit:${taskBase.id}`, status: options.eventStatus ?? "approved", nextTurnRevision, answerAvailable: false } }
  const digest = createHash("sha256").update(JSON.stringify([taskBase.id, lease.turnId, approvalId])).digest("hex")
  const workerTaskId = `apply-submit-${digest}`, outboxId = `application-submit-outbox-${digest}`, idempotencyKey = `application-submit:${digest}`
  const task = { ...taskBase, status: state === "form_filled" ? "waiting_for_authorization" : "filling",
    checkpoint: state, workerTaskId: state === "form_filled" ? null : workerTaskId }
  const event = { actor: "user", body: "User approved this job for background submission.", data: {
    applicationTaskId: taskBase.id, userId: lease.userId, jobId: taskBase.jobId, sessionId: lease.sessionId, fillTurnId: lease.turnId,
    approvalId, receiptId: approvalId, constraintHash: scopeHash, workerTaskId,
  } }
  const submitPayload = { applicationTaskId: taskBase.id, jobId: taskBase.jobId, userId: lease.userId, personaId: "server-side",
    resumePath: "", operation: "submit", sessionId: lease.sessionId, fillTurnId: lease.turnId, receiptId: approvalId,
    constraintHash: scopeHash, applyUrl: "https://boards.greenhouse.io/example/jobs/1" }
  const outbox = { id: outboxId, topic: "application.submit.dispatch", aggregateId: lease.sessionId, idempotencyKey,
    payload: { applicationTaskId: taskBase.id, userId: lease.userId, jobId: taskBase.jobId, sessionId: lease.sessionId,
      fillTurnId: lease.turnId, receiptId: approvalId, constraintHash: scopeHash, workerTaskId, submitPayload } }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM "agent_approvals" AS approval')) return { rows: [approval] }
    if (sql.includes('FROM "application_task_events"')) return { rows: state === "submission_authorized" && options.missingIntent !== "event" ? [event] : [] }
    if (sql.includes('FROM "agent_outbox"')) return { rows: state === "submission_authorized" && options.missingIntent !== "outbox" ? [outbox] : [] }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: taskBase.jobId, status: "saved", workflowState: options.jobState ?? (state === "form_filled" ? "ready_to_apply" : "queued") }] }
    throw new Error("unexpected receipt query")
  })
  verifier.run.mockResolvedValue(true)
  return { client: { query } as never, task, approval, workerTaskId, outboxId, verifierArgs: verifier.run }
}

beforeEach(() => verifier.run.mockReset())

describe("canonical approved application submit receipts", () => {
  it("proves an approved filled form without claiming submission", async () => {
    const test = await fixture()
    const result = await readCanonicalApprovedApplicationSubmitReceipts(test.client, {
      lease, task: test.task, material, now: NOW, turnRevision: 13,
    })
    expect(result).toMatchObject({ state: "form_filled", workerTaskId: null, outboxId: null, approvalRevision: 9 })
    expect(result).not.toHaveProperty("nonce")
    expect(test.verifierArgs).toHaveBeenCalledWith(test.client, lease, test.task, { revision: 13 }, true, undefined, 9)
  })

  it("proves only the exact committed submit queue intent", async () => {
    const test = await fixture("submission_authorized")
    const result = await readCanonicalApprovedApplicationSubmitReceipts(test.client, {
      lease, task: test.task, material, now: NOW, turnRevision: 13,
    })
    expect(result).toMatchObject({ state: "submission_authorized", workerTaskId: test.workerTaskId, outboxId: test.outboxId })
    expect(result).not.toHaveProperty("nonceHash")
  })

  it.each([
    ["wrong resume", { resumeId: "resume-b" }],
    ["wrong cover letter", { coverLetterId: "cover-letter-b" }],
    ["missing nullable cover letter", {}],
    ["extra field", { unexpected: true }],
  ])("rejects an approval payload with %s", async (label, change) => {
    const test = await fixture()
    const approval = test.approval as Record<string, unknown>
    const payload: Record<string, unknown> = { ...(approval.payload as Record<string, unknown>), ...change }
    if (label === "missing nullable cover letter") delete payload.coverLetterId
    approval.payload = payload
    await expect(readCanonicalApprovedApplicationSubmitReceipts(test.client, {
      lease, task: test.task, material, now: NOW, turnRevision: 13,
    })).resolves.toBeNull()
  })

  it.each([
    ["rejected decision", { eventStatus: "rejected" }],
    ["consumed receipt", { waitStatus: "consumed" }],
    ["queued task without intent", { missingIntent: "outbox" }],
    ["wrong job lifecycle", { jobState: "saved" }],
  ] as const)("denies %s", async (_label, options) => {
    const test = await fixture("submission_authorized", options)
    await expect(readCanonicalApprovedApplicationSubmitReceipts(test.client, {
      lease, task: test.task, material, now: NOW, turnRevision: 13,
    })).resolves.toBeNull()
  })

  it("rejects an approval resolution revision that does not follow the issued Wait", async () => {
    const test = await fixture()
    const approval = test.approval as Record<string, unknown>
    const payload = approval.resolvedPayload as Record<string, unknown>
    payload.nextTurnRevision = 12
    await expect(readCanonicalApprovedApplicationSubmitReceipts(test.client, {
      lease, task: test.task, material, now: NOW, turnRevision: 14,
    })).resolves.toBeNull()
    expect(test.verifierArgs).not.toHaveBeenCalled()
  })
})
