import { describe, expect, it, vi } from "vitest"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import {
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR, OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA, OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
  OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA, OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA, buildObjectiveApplicationSubmissionManifest, hashObjectiveApplicationSubmissionMaterial,
} from "@jobcopilot/shared"
import { createSubmitIntent } from "@/lib/apply-queue-client"
import { hashArtifactContent } from "../artifacts/hash"
import { readObjectiveSubmitApprovalReplay } from "./objective-submit-approval-replay"

const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:2`, reviewTurnId: "review-turn-1", materialProofHash: "b".repeat(64) }
const scope = { userId: "user-1", sessionId: "session-1", applicationTaskId: "application-1", jobId: "job-1",
  approvalId: "submit-approval-1", receiptNonce: "n".repeat(64) }

async function fixture(options: { checkpoint?: string; status?: string; workerTaskId?: string | null;
  outbox?: boolean; scopedOutbox?: boolean; queued?: boolean; started?: boolean; approvalStatus?: string;
  ordinaryTurn?: boolean; selectedTurn?: boolean; reservedMalformedTurn?: boolean; manifest?: boolean; decidedAt?: Date; expiresAt?: Date } = {}) {
  const now = new Date(), decidedAt = options.decidedAt ?? new Date(now.getTime() - 60_000)
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + 60_000)
  const task = { id: scope.applicationTaskId, userId: scope.userId, jobId: scope.jobId, sessionId: scope.sessionId,
    fillTurnId: "fill-turn-1", fillTurnSessionId: scope.sessionId, fillTurnUserId: scope.userId,
    workerTaskId: options.workerTaskId === undefined ? "apply-submit-worker" : options.workerTaskId,
    status: options.status ?? "filling", checkpoint: options.checkpoint ?? "submission_authorized",
    resumeId: "resume-at-approval", coverLetterId: "letter-at-approval" }
  const material = { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA, applicationTaskId: task.id, jobId: task.jobId,
    resumeId: task.resumeId, coverLetterId: task.coverLetterId, reviewedCoverLetterHash: "c".repeat(64), objectiveSource: source }
  const answersHash = "d".repeat(64), manifest = buildObjectiveApplicationSubmissionManifest(material, answersHash)!
  const manifestHash = hashArtifactContent(manifest), materialHash = await hashObjectiveApplicationSubmissionMaterial(material)
  const manifestId = `objective-submission-manifest:${hashArtifactContent([task.id, task.fillTurnId]).slice(7)}`
  const manifestEvent = { id: manifestId, taskId: task.id, type: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
    actor: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR, body: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY,
    data: { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA, scope: { userId: scope.userId,
      sessionId: scope.sessionId, applicationTaskId: task.id, jobId: scope.jobId, fillTurnId: task.fillTurnId }, manifest, hash: manifestHash } }
  const nonceHash = await hashApprovalNonce(scope.receiptNonce)
  const approval = { id: scope.approvalId, status: options.approvalStatus ?? "consumed", payload: { applicationTaskId: task.id,
    jobId: task.jobId, resumeId: material.resumeId, coverLetterId: material.coverLetterId }, sessionId: scope.sessionId,
    taskId: task.id, turnId: task.fillTurnId, toolCallId: `application-submit:${task.id}`, jobId: scope.jobId, revision: 3,
    expiresAt, decidedAt, scopeHash: "", nonceHash, resourceHash: manifestHash.slice(7), materialHash,
    answersHash }
  approval.scopeHash = await hashApprovalScope({ userId: scope.userId, sessionId: scope.sessionId, turnId: task.fillTurnId,
    jobId: scope.jobId, toolCallId: approval.toolCallId, action: "submit_application", resourceHash: approval.resourceHash,
    materialHash: approval.materialHash!, answersHash, revision: approval.revision, nonceHash, expiresAt: expiresAt.toISOString() })
  const submitPayload = { applicationTaskId: task.id, userId: scope.userId, jobId: scope.jobId, sessionId: scope.sessionId,
    fillTurnId: task.fillTurnId, receiptId: approval.id, constraintHash: approval.scopeHash,
    operation: "submit" as const, applyUrl: "https://boards.greenhouse.io/example/jobs/1", personaId: "server-side", resumePath: "" }
  const intent = createSubmitIntent(submitPayload)
  if (task.workerTaskId === "apply-submit-worker") task.workerTaskId = intent.payload.workerTaskId
  const outbox = { ...intent, payload: intent.payload }
  const queued = { id: "queued-event-1", taskId: task.id, type: "submission_queued", actor: "user",
    body: "User approved this job for background submission.", data: { applicationTaskId: task.id, userId: scope.userId,
      jobId: scope.jobId, sessionId: scope.sessionId, fillTurnId: task.fillTurnId, approvalId: approval.id,
      receiptId: approval.id, constraintHash: approval.scopeHash, workerTaskId: intent.payload.workerTaskId }, createdAt: new Date(decidedAt.getTime() + 1_000) }
  const start = { id: "started-event-1" }
  const turnInput = options.ordinaryTurn ? { goal: "Ordinary Fill", clientMessageId: "ordinary-fill" }
    : options.selectedTurn ? { clientMessageId: "selected-fill", reviewedApplicationMaterialSource: {
      schemaVersion: REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA, sourceTurnId: "completed-source-turn" } }
      : options.reservedMalformedTurn ? { clientMessageId: "agent-objective-reviewed-fill:malformed" }
        : { clientMessageId: `agent-objective-reviewed-fill:${source.approvalId}`, reviewedApplicationMaterialSource: source }
  const client = {
    agentTurn: { findMany: vi.fn(async () => [{ id: task.fillTurnId, userId: scope.userId, sessionId: scope.sessionId,
      source: "user", executionMode: "canonical_task_graph", input: turnInput }]) },
    applicationTaskEvent: { findMany: vi.fn(async (query: { where: { OR?: unknown; type?: string | { in: string[] } } }) => {
      if (query.where.OR) return options.manifest === false ? [] : [manifestEvent]
      if (query.where.type === "submission_queued") return options.queued === false ? [] : [queued]
      if (typeof query.where.type === "object") return options.started ? [start] : []
      return []
    }) },
    agentOutbox: { findUnique: vi.fn(async () => options.outbox === false ? null : outbox),
      findMany: vi.fn(async () => options.scopedOutbox ? [{ id: "other-submit-intent" }] : []) },
  }
  return { client, task, approval, queued, outbox, intent, manifestEvent, input: { ...scope, task, approval } }
}

describe("Objective submit approval replay", () => {
  it("acknowledges an exact committed V3 intent after expiry and material drift without reauthorization", async () => {
    const now = new Date("2026-11-24T12:00:00.000Z")
    const state = await fixture({ decidedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2026-01-01T01:00:00.000Z") })
    state.task.resumeId = "resume-now-different"
    state.task.coverLetterId = "letter-now-different"

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input, now)).resolves.toEqual({
      kind: "committed", taskId: state.intent.payload.workerTaskId,
    })
    expect(state.client.agentOutbox.findUnique).toHaveBeenCalledOnce()
  })

  it("permits a fresh retry only from queue_retry with a valid approved receipt and no dispatch evidence", async () => {
    const state = await fixture({ status: "waiting_for_authorization", checkpoint: "queue_retry", workerTaskId: null,
      outbox: false, queued: false, approvalStatus: "approved" })

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input)).resolves.toEqual({ kind: "retryable" })
    expect(state.client.agentOutbox.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      topic: state.intent.topic, aggregateId: scope.sessionId, AND: [
        { payload: { path: ["applicationTaskId"], equals: scope.applicationTaskId } },
        { payload: { path: ["fillTurnId"], equals: state.task.fillTurnId } },
      ],
    }) }))
  })

  it("rejects any already-scoped outbox, even when its deterministic key differs", async () => {
    const state = await fixture({ status: "waiting_for_authorization", checkpoint: "queue_retry", workerTaskId: null,
      outbox: false, queued: false, approvalStatus: "approved", scopedOutbox: true })

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input)).resolves.toEqual({ kind: "invalid" })
  })

  it("rejects a malformed reserved Objective Fill marker before relying on manifest history", async () => {
    const state = await fixture({ reservedMalformedTurn: true })

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input)).resolves.toEqual({ kind: "invalid" })
    expect(state.client.applicationTaskEvent.findMany).not.toHaveBeenCalled()
  })

  it("preserves valid selected-job reviewed Fill replay for its existing path", async () => {
    const state = await fixture({ selectedTurn: true, manifest: false })

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input)).resolves.toEqual({ kind: "not_objective" })
  })

  it("rejects selected-job marker mixed with an Objective V3 manifest", async () => {
    const state = await fixture({ selectedTurn: true })

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input)).resolves.toEqual({ kind: "invalid" })
  })

  it("scopes stripped-marker manifest detection to the ApplicationTask id", async () => {
    const state = await fixture({ ordinaryTurn: true })

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input)).resolves.toEqual({ kind: "invalid" })
    expect(state.client.applicationTaskEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      taskId: scope.applicationTaskId, OR: expect.any(Array),
    }) }))
  })

  it("rejects a wrong nonce before returning a committed queue identity", async () => {
    const state = await fixture()

    await expect(readObjectiveSubmitApprovalReplay(state.client as never,
      { ...state.input, receiptNonce: "wrong-nonce" })).resolves.toEqual({ kind: "invalid" })
  })

  it.each([
    ["outbox without its event", { queued: false }],
    ["event without its outbox", { outbox: false }],
    ["a prior started attempt", { status: "waiting_for_authorization", checkpoint: "queue_retry", workerTaskId: null,
      outbox: false, queued: false, started: true, approvalStatus: "approved" }],
  ])("fails closed for %s", async (_name, options) => {
    const state = await fixture(options)

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input)).resolves.toEqual({ kind: "invalid" })
  })

  it("does not turn an ordinary form_filled replay into a new V3 submission", async () => {
    const state = await fixture({ status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null,
      outbox: false, queued: false, approvalStatus: "approved" })

    await expect(readObjectiveSubmitApprovalReplay(state.client as never, state.input)).resolves.toEqual({ kind: "invalid" })
  })
})
