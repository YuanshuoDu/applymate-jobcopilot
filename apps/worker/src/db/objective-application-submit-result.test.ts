import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Pool, PoolClient } from "pg"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import {
  bindReviewedApplicationSubmissionMaterial, buildObjectiveApplicationSubmissionManifest,
  hashObjectiveApplicationSubmissionMaterial, OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA,
  OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
} from "@jobcopilot/shared"
import { protocolScope } from "../runtime/approval/types.js"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"

const mocks = vi.hoisted(() => ({ fence: vi.fn(), insertResult: vi.fn(), manifest: vi.fn() }))
vi.mock("./submission-guard.js", () => ({ withExactSubmissionWrite: mocks.fence }))
vi.mock("./apply-results.js", () => ({ insertApplyResultWithClient: mocks.insertResult }))
vi.mock("./objective-submission-manifest-event.js", () => ({ readObjectiveSubmissionManifestWithClient: mocks.manifest }))

const execution = { applicationTaskId: "application-1", userId: "user-1", jobId: "job-1", sessionId: "session-1",
  fillTurnId: "fill-turn-1", approvalId: "approval-1", constraintHash: "c".repeat(64), workerTaskId: "worker-1", executionId: "execution-1" }
const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:1`, reviewTurnId: "review-turn-1", materialProofHash: "b".repeat(64) }
const proof = { jobId: execution.jobId, sourceTurnId: "objective-turn-1", rootTaskId: "root-1", graphRevision: 4,
  writerTaskId: "writer-1", reviewerTaskId: "reviewer-1", reviewerToolCallId: "review-call-1",
  reviewHash: `sha256:${"1".repeat(64)}`, artifactId: "artifact-1", version: 2,
  contentHash: `sha256:${"2".repeat(64)}`, sourceDigest: `sha256:${"3".repeat(64)}` }
const browserAt = new Date("2026-11-24T10:00:00.000Z")
const startAt = new Date("2026-11-24T10:01:00.000Z")
const resultAt = new Date("2026-11-24T10:02:00.000Z")
const leaseExpiresAt = "2026-11-24T11:00:00.000Z"

beforeEach(() => { vi.clearAllMocks(); mocks.insertResult.mockResolvedValue(73) })

describe("Objective application submit result event", () => {
  it("records the successful result and immutable link on the same fenced client, then reads it exactly", async () => {
    const test = await fixture()
    mocks.fence.mockImplementation(async (_pool: Pool, identity: unknown, phase: string, work: (client: PoolClient) => Promise<number>) => {
      expect(identity).toEqual(test.execution)
      expect(phase).toBe("objective_submit_success_result")
      return { kind: "current", value: await work(test.client) }
    })
    const written = await module()
    await expect(written.recordObjectiveApplicationSubmitResult(input({}, test.execution))).resolves.toBe(73)
    expect(mocks.insertResult).toHaveBeenCalledWith(test.client, expect.objectContaining({ status: "submitted", flowUsed: "application.submit" }))
    expect(test.resultEvent).toMatchObject({ id: resultEventId(test.execution), type: "objective_application_submit_result_recorded", actor: "worker" })
    await expect(written.readObjectiveApplicationSubmitResultWithClient(test.client, test.execution)).resolves.toMatchObject({
      applicationTaskId: test.execution.applicationTaskId, approvalId: test.execution.approvalId, attemptId: "attempt-1",
      applyResultId: 73, eventId: resultEventId(test.execution), eventCreatedAt: resultAt,
    })
  })

  it("replays the exact stored link without inserting another ApplyResult", async () => {
    const test = await fixture()
    mocks.fence.mockImplementation(async (_pool: Pool, _identity: unknown, _phase: string, work: (client: PoolClient) => Promise<number>) =>
      ({ kind: "current", value: await work(test.client) }))
    const written = await module()
    await expect(written.recordObjectiveApplicationSubmitResult(input({}, test.execution))).resolves.toBe(73)
    mocks.insertResult.mockClear()
    await expect(written.recordObjectiveApplicationSubmitResult(input({}, test.execution))).resolves.toBe(73)
    expect(mocks.insertResult).not.toHaveBeenCalled()
  })

  it.each([
    ["failed runner", { runnerStatus: "failed" }],
    ["missing request start", { requestStarted: false }],
    ["uncertain continuation", { requestContinued: false }],
    ["unavailable fence", { fenceUnavailable: true }],
    ["missing confirmation", { confirmationId: null }],
  ])("does not write a positive result for %s", async (_label, change) => {
    const written = await module()
    await expect(written.recordObjectiveApplicationSubmitResult(input(change))).resolves.toBeNull()
    expect(mocks.fence).not.toHaveBeenCalled()
    expect(mocks.insertResult).not.toHaveBeenCalled()
  })

  it("fails closed on changed receipt, wrong current checkpoint, or a duplicate logical event", async () => {
    const changedReceipt = await fixture({ attempt: { artifactHash: "f".repeat(64) } })
    mocks.fence.mockImplementation(async (_pool: Pool, _identity: unknown, _phase: string, work: (client: PoolClient) => Promise<number>) =>
      ({ kind: "current", value: await work(changedReceipt.client) }))
    let written = await module()
    await expect(written.recordObjectiveApplicationSubmitResult(input({}, changedReceipt.execution))).resolves.toBeNull()
    expect(mocks.insertResult).not.toHaveBeenCalled()

    const stale = await fixture({ checkpoint: "browser_active" })
    mocks.fence.mockImplementation(async (_pool: Pool, _identity: unknown, _phase: string, work: (client: PoolClient) => Promise<number>) =>
      ({ kind: "current", value: await work(stale.client) }))
    written = await module()
    await expect(written.recordObjectiveApplicationSubmitResult(input({}, stale.execution))).resolves.toBeNull()
    expect(mocks.insertResult).not.toHaveBeenCalled()

    const duplicate = await fixture({ duplicateLogical: true })
    mocks.fence.mockImplementation(async (_pool: Pool, _identity: unknown, _phase: string, work: (client: PoolClient) => Promise<number>) =>
      ({ kind: "current", value: await work(duplicate.client) }))
    written = await module()
    await expect(written.recordObjectiveApplicationSubmitResult(input({}, duplicate.execution))).resolves.toBeNull()
    expect(mocks.insertResult).not.toHaveBeenCalled()
  })
})

function input(change: Record<string, unknown> = {}, identity = execution) {
  return { pool: {} as Pool, execution: identity, runnerStatus: "submitted", confirmationId: "application:application-1",
    durationMs: 11, requestStarted: true, requestContinued: true, fenceUnavailable: false, ...change }
}
function resultEventId(identity = execution) { return `objective-application-submit-result:${hashArtifactContent([identity.applicationTaskId, identity.fillTurnId, identity.approvalId]).slice(7)}` }
async function module() { return import("./objective-application-submit-result.js") }

async function fixture(options: { attempt?: Record<string, unknown>; checkpoint?: string; duplicateLogical?: boolean } = {}) {
  const nonceHash = "e".repeat(64), expiresAt = new Date("2026-11-24T10:30:00.000Z")
  const legacy = { applicationTaskId: execution.applicationTaskId, jobId: execution.jobId, resumeId: "resume-1", coverLetterId: null }
  const bound = await bindReviewedApplicationSubmissionMaterial(legacy, proof)
  const material = { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA, ...legacy,
    reviewedCoverLetterHash: bound!.reviewedCoverLetterHash, objectiveSource: source }
  const answersHash = "d".repeat(64), manifest = buildObjectiveApplicationSubmissionManifest(material, answersHash)!
  const manifestHash = hashArtifactContent(manifest), materialHash = await hashObjectiveApplicationSubmissionMaterial(material)
  const approvalScope = protocolScope({ userId: execution.userId, sessionId: execution.sessionId, turnId: execution.fillTurnId,
    jobId: execution.jobId, toolCallId: `application-submit:${execution.applicationTaskId}`, action: "submit_application",
    resourceHash: manifestHash.slice(7), materialHash: materialHash!, answersHash, revision: 2, expiresAt }, nonceHash)
  const currentExecution = { ...execution, constraintHash: await hashApprovalScope(approvalScope) }
  const approval = { id: execution.approvalId, userId: execution.userId, sessionId: execution.sessionId, taskId: execution.applicationTaskId,
    turnId: execution.fillTurnId, toolCallId: `application-submit:${execution.applicationTaskId}`, jobId: execution.jobId,
    type: "submit_application", status: "consumed", payload: { ...legacy }, resourceHash: manifestHash.slice(7),
    materialHash, answersHash, scopeHash: currentExecution.constraintHash, nonceHash, revision: 2,
    expiresAt, decidedAt: new Date("2026-11-24T09:00:00.000Z"), consumedAt: new Date("2026-11-24T09:01:00.000Z") }
  const attempt = { id: "attempt-1", userId: execution.userId, jobId: execution.jobId, receiptId: execution.approvalId,
    constraintHash: currentExecution.constraintHash, artifactHash: approval.resourceHash, state: "submitted",
    responseRef: "application:application-1", ...options.attempt }
  const browser = { ...proof, schemaVersion: OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, userId: execution.userId,
    sessionId: execution.sessionId, fillTurnId: execution.fillTurnId, jobId: execution.jobId,
    applicationTaskId: execution.applicationTaskId, fillerTaskId: "filler-1", attemptCount: 1, leaseOwner: "worker",
    leaseExpiresAt, objectiveSource: source }
  const events: Array<Record<string, unknown>> = [
    { id: "browser-start-1", taskId: execution.applicationTaskId, type: "reviewed_application_fill_browser_started", actor: "worker",
      body: "Reviewed application material bound to browser-start attempt.", data: browser, createdAt: browserAt },
    { id: `evt_${execution.executionId}`, taskId: execution.applicationTaskId, type: "submission_execution_started", actor: "worker",
      body: "Submit execution started", data: { ...currentExecution }, createdAt: startAt },
  ]
  if (options.duplicateLogical) events.push({ id: "other-result", taskId: execution.applicationTaskId,
    type: "objective_application_submit_result_recorded", actor: "worker", body: "Objective browser-confirmed result recorded.",
    data: { approvalId: execution.approvalId, fillTurnId: execution.fillTurnId }, createdAt: resultAt })
  let resultEvent: Record<string, unknown> | null = null
  const task = { id: execution.applicationTaskId, userId: execution.userId, jobId: execution.jobId, sessionId: execution.sessionId,
    fillTurnId: execution.fillTurnId, fillTurnSessionId: execution.sessionId, fillTurnUserId: execution.userId,
    workerTaskId: execution.workerTaskId, turnInput: { reviewedApplicationMaterialSource: source } }
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('FROM "application_tasks" AS task')) return { rows: [task], rowCount: 1 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: [approval], rowCount: 1 }
    if (sql.includes('FROM "submission_attempt"')) return { rows: [attempt], rowCount: 1 }
    if (sql.includes('FROM apply_results')) return { rows: [{ id: 73, userId: execution.userId, jobId: execution.jobId,
      mode: "unattended", atsType: "greenhouse", flowUsed: "application.submit", status: "submitted", error: null }], rowCount: 1 }
    if (sql.includes('FROM "application_task_events"')) {
      const found = events.filter(event => event.taskId === values[0] && (event.id === values[1]
        || event.type === values[2] && (event.data as Record<string, unknown>)?.fillTurnId === values[3]
        || event.type === "reviewed_application_fill_browser_started" && (event.data as Record<string, unknown>)?.fillTurnId === values[1]
        || event.type === "submission_execution_started" && ((event.data as Record<string, unknown>)?.workerTaskId === values[2] || event.id === values[1])))
      return { rows: found.slice(0, 2), rowCount: found.length }
    }
    if (sql.includes('INSERT INTO "application_task_events"')) {
      resultEvent = { id: values[0], taskId: values[1], type: values[2], actor: "worker", body: values[3],
        data: JSON.parse(String(values[4])), createdAt: resultAt }
      events.push(resultEvent); return { rows: [{ id: values[0] }], rowCount: 1 }
    }
    if (sql.includes('FROM "application_tasks" WHERE')) return { rows: [{ status: "filling", checkpoint: options.checkpoint ?? "submission_request_started" }], rowCount: 1 }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const client = { query } as unknown as PoolClient
  mocks.manifest.mockResolvedValue({ manifest, hash: manifestHash })
  return { client, query, execution: currentExecution, get resultEvent() { return resultEvent } }
}
