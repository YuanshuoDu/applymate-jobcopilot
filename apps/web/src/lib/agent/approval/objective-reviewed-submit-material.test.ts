import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR, OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA, OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
  OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA, OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA,
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, bindReviewedApplicationSubmissionMaterial,
  buildObjectiveApplicationSubmissionManifest, hashAgentReceiptValue,
  hashObjectiveApplicationSubmissionMaterial,
} from "@jobcopilot/shared"
import { hashArtifactContent } from "../artifacts/hash"

const mocks = vi.hoisted(() => ({ verifyFreshness: vi.fn() }))
vi.mock("./objective-reviewed-fill-authority.js", () => ({
  verifyObjectiveReviewedFillFreshness: mocks.verifyFreshness,
}))

import { resolveObjectiveReviewedSubmitMaterial } from "./objective-reviewed-submit-material"

const input = { userId: "user-1", sessionId: "session-1", applicationTaskId: "application-1", jobId: "job-1",
  fillTurnId: "fill-turn-1", approvalId: "submit-approval-1", receiptNonce: "n".repeat(64) }
const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:1`, reviewTurnId: "review-turn-1", materialProofHash: "b".repeat(64) }
const proof = { jobId: input.jobId, sourceTurnId: "source-turn-1", rootTaskId: "source-root-1", graphRevision: 7,
  writerTaskId: "writer-task-1", reviewerTaskId: "reviewer-task-1", reviewerToolCallId: "review-call-1",
  reviewHash: `sha256:${"c".repeat(64)}`, artifactId: "cover-artifact-1", version: 2,
  contentHash: `sha256:${"d".repeat(64)}`, sourceDigest: `sha256:${"e".repeat(64)}` }
const turnCreatedAt = new Date("2026-11-24T12:00:00.000Z")

async function fixture() {
  const task = { id: input.applicationTaskId, userId: input.userId, sessionId: input.sessionId, jobId: input.jobId,
    fillTurnId: input.fillTurnId, fillTurnSessionId: input.sessionId, fillTurnUserId: input.userId,
    status: "waiting_for_authorization", checkpoint: "form_filled", resumeId: "resume-1", coverLetterId: "letter-1",
    confirmedAnswers: { rightToWork: "yes" } }
  const turn = { id: input.fillTurnId, userId: input.userId, sessionId: input.sessionId, source: "user",
    status: "waiting_for_approval", rootTaskId: "fill-root-1", executionMode: "canonical_task_graph", createdAt: turnCreatedAt,
    input: { reviewedApplicationMaterialSource: source } }
  const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers)
  const bound = await bindReviewedApplicationSubmissionMaterial({ applicationTaskId: task.id, jobId: task.jobId,
    resumeId: task.resumeId, coverLetterId: task.coverLetterId }, proof)
  if (!bound) throw new Error("invalid Objective fixture proof")
  const material = { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA, ...bound, objectiveSource: source }
  const manifest = buildObjectiveApplicationSubmissionManifest(material, answersHash)!
  const manifestHash = hashArtifactContent(manifest)
  const manifestData = { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA,
    scope: { userId: input.userId, sessionId: input.sessionId, applicationTaskId: task.id, jobId: task.jobId,
      fillTurnId: input.fillTurnId }, manifest, hash: manifestHash }
  const browserData = { schemaVersion: OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, userId: input.userId,
    sessionId: input.sessionId, fillTurnId: input.fillTurnId, applicationTaskId: task.id,
    fillerTaskId: "filler-1", attemptCount: 2, leaseOwner: "worker-1", leaseExpiresAt: "2026-11-24T12:05:00.000Z",
    ...proof, objectiveSource: source }
  const filler = { id: "filler-1", attemptCount: 2, status: "completed", completedAt: new Date("2026-11-24T12:06:00.000Z"),
    rootTaskId: turn.rootTaskId, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null }
  const manifestId = `objective-submission-manifest:${hashArtifactContent([task.id, input.fillTurnId]).slice(7)}`
  const browserEvent = { id: "browser-event-1", taskId: task.id, type: "reviewed_application_fill_browser_started", actor: "worker",
    body: "Reviewed application material bound to browser-start attempt.", data: browserData,
    createdAt: new Date("2026-11-24T12:01:00.000Z") }
  const manifestEvent = { id: manifestId, taskId: task.id, type: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
    actor: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR, body: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY,
    data: manifestData }
  const events = [browserEvent, manifestEvent]
  const client = {
    applicationTaskEvent: { findMany: vi.fn(async (query: { where: { type?: string } }) =>
      query.where.type ? events.filter(row => row.type === query.where.type) : events.filter(row => row.id === manifestId
        || row.type === OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE)) },
    subAgentTask: { findMany: vi.fn(async () => [filler]) },
    agentApproval: { findMany: vi.fn(async () => [{ id: source.approvalId,
      decidedAt: new Date("2026-11-24T11:59:00.000Z"), expiresAt: new Date("2026-11-24T13:00:00.000Z") }]) },
  }
  const authority = { jobId: input.jobId, resumeId: task.resumeId, source, input: { member: { proof: { source: proof } } } }
  mocks.verifyFreshness.mockResolvedValue(undefined)
  const verifyReceipt = vi.fn(async () => true)
  const expected = { mode: "reviewed", ready: true, resourceHash: manifestHash.slice(7),
    materialHash: await hashObjectiveApplicationSubmissionMaterial(manifest.material), answersHash,
    objectiveSource: source, fillTurnCreatedAt: turnCreatedAt }
  return { client, task, turn, manifest, manifestHash, browserEvent, manifestEvent, events, authority, verifyReceipt, answersHash, expected }
}

beforeEach(() => vi.clearAllMocks())

describe("Objective reviewed submit material", () => {
  it("checks immutable evidence for the advisory read and full authority under the fenced transaction", async () => {
    const state = await fixture()
    const advisory = await resolveObjectiveReviewedSubmitMaterial(state.client as never, input, state.task, state.turn,
      state.verifyReceipt)
    expect(advisory).toEqual(state.expected)
    expect(mocks.verifyFreshness).not.toHaveBeenCalled()

    const transaction = {} as never
    const actual = await resolveObjectiveReviewedSubmitMaterial(state.client as never, input, state.task, state.turn,
      state.verifyReceipt, { tx: transaction, authority: state.authority } as never)
    expect(actual).toEqual(state.expected)
    expect(mocks.verifyFreshness).toHaveBeenCalledWith(transaction, state.authority)
    expect(state.client.agentApproval.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: source.approvalId, turnId: source.reviewTurnId, status: "approved",
    }) }))
    expect(state.verifyReceipt).toHaveBeenCalledWith({ applicationTaskId: input.applicationTaskId, jobId: input.jobId,
      resumeId: "resume-1", coverLetterId: "letter-1" }, expect.objectContaining({ resourceHash: state.manifestHash.slice(7) }))
    expect(JSON.stringify(actual)).not.toMatch(/resume-1|letter-1|source-turn-1|cover-artifact-1/)
  })

  it("revalidates a queue_retry with the same current Objective proof", async () => {
    const state = await fixture()
    state.task.checkpoint = "queue_retry"

    await expect(resolveObjectiveReviewedSubmitMaterial(state.client as never, input, state.task, state.turn,
      state.verifyReceipt)).resolves.toEqual(state.expected)
  })

  it.each(["duplicate manifest", "manifest hash drift", "browser proof mismatch", "foreign scope", "future review decision",
    "lease expired before browser start", "cover letter binding drift"])(
    "rejects %s without using another material path", async mode => {
      const state = await fixture()
      if (mode === "duplicate manifest") state.events.push({ ...state.manifestEvent, id: "duplicate-event" })
      if (mode === "manifest hash drift") state.manifestEvent.data.hash = `sha256:${"0".repeat(64)}`
      if (mode === "foreign scope") state.manifestEvent.data.scope.userId = "foreign-user"
      if (mode === "browser proof mismatch") state.authority.input.member.proof.source.writerTaskId = "other-writer"
      if (mode === "future review decision") state.client.agentApproval.findMany.mockResolvedValueOnce([{
        id: source.approvalId, decidedAt: new Date("2026-11-24T12:01:00.000Z"), expiresAt: new Date("2026-11-24T13:00:00.000Z"),
      }])
      if (mode === "lease expired before browser start") state.browserEvent.data.leaseExpiresAt = "2026-11-24T12:01:00.000Z"
      if (mode === "cover letter binding drift") {
        const changed = buildObjectiveApplicationSubmissionManifest({ ...state.manifest.material,
          reviewedCoverLetterHash: "0".repeat(64) }, state.answersHash)!
        state.manifestEvent.data.manifest = changed
        state.manifestEvent.data.hash = hashArtifactContent(changed)
      }
      const result = await resolveObjectiveReviewedSubmitMaterial(state.client as never, input, state.task, state.turn,
        state.verifyReceipt, { tx: {} as never, authority: state.authority } as never)
      expect(result).toBeNull()
    })

  it("rejects current source or Resume drift on the locked reread", async () => {
    const state = await fixture()
    mocks.verifyFreshness.mockRejectedValueOnce(new Error("private source drift"))
    await expect(resolveObjectiveReviewedSubmitMaterial(state.client as never, input, state.task, state.turn,
      state.verifyReceipt, { tx: {} as never, authority: state.authority } as never)).resolves.toBeNull()
    expect(state.verifyReceipt).toHaveBeenCalledOnce()
  })
})
