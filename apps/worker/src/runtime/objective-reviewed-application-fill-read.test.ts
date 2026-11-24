import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import {
  OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, objectiveApplicationApprovalSetItemId,
  parseObjectiveApplicationReviewIntent,
} from "@jobcopilot/agent-protocol"
import {
  buildObjectiveApplicationReviewMemberProof, buildObjectiveApplicationResumeWitness,
  objectiveApplicationApprovedIntentId, parseObjectiveReviewedFillSource, type ObjectiveApplicationReviewMemberProof,
  type ObjectiveApplicationResumeMaterial, type ObjectiveApplicationResumeWitness,
} from "@jobcopilot/shared"
import {
  objectiveApplicationReviewIntentHash, objectiveApplicationReviewSetId,
  objectiveApplicationReviewApprovalId, type ObjectiveApplicationReviewSetState,
} from "./objective-application-review-set-state.js"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"

const mocks = vi.hoisted(() => ({ readSet: vi.fn(), readSource: vi.fn(), readResume: vi.fn() }))
vi.mock("./objective-application-review-set-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./objective-application-review-set-state.js")>()
  return { ...actual, readObjectiveApplicationReviewSetState: mocks.readSet }
})
vi.mock("./subagents/objective-tailor-completed-source.js", () => ({ readCompletedObjectiveTailorSourceEvidence: mocks.readSource }))
vi.mock("./approval/objective-application-resume-witness.js", () => ({ readObjectiveApplicationResumeMaterial: mocks.readResume }))
import { readObjectiveReviewedApplicationFillSource } from "./objective-reviewed-application-fill-read.js"

const userId = "user-owner", sessionId = "session-fill", fillTurnId = "fill-turn-2", applicationTaskId = "application-2", jobId = "job-2"
const sourceTurnId = "objective-source", sourceRootId = "source-root", reviewTurnId = "review-turn", reviewRootId = "review-root"
const graphItemId = "task-graph-source", graphRevision = 17, selectedOrdinal = 2
const setId = objectiveApplicationReviewSetId(sessionId, reviewTurnId), itemId = objectiveApplicationApprovalSetItemId(setId)
const approvalId = objectiveApplicationReviewApprovalId(setId, selectedOrdinal)
const selection = Object.freeze({ schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, sourceTurnId, rootTaskId: sourceRootId,
  graphItemId, graphRevision, slotOrdinals: Object.freeze([2, 4]) })
const material: ObjectiveApplicationResumeMaterial = { name: "Tailored", content: { basics: { name: "Candidate" }, experience: [] },
  templateId: "modern", templateOptions: { color: "blue" }, kind: "adapted", targetJobId: jobId,
  parentResumeId: "base-resume", basicsDetached: false }
const resumeWitness = buildObjectiveApplicationResumeWitness({ userId, jobId, resumeId: "resume-current",
  finalResumeAssignmentRevision: 5, materialRevision: 7, material })!
const draft = "Verified reviewed cover letter"
const artifactId = "cover-letter-2", version = 3, contentHash = hashArtifactContent(draft), sourceDigest = `sha256:${"d".repeat(64)}`
const proof = buildObjectiveApplicationReviewMemberProof({ source: { jobId, sourceTurnId, rootTaskId: sourceRootId,
  graphItemId, graphRevision, finalItemId: "final-source", slotOrdinal: selectedOrdinal, writerTaskId: "writer-task-2",
  reviewerTaskId: "reviewer-task-2", reviewerToolCallId: "review-tool-2", reviewHash: `sha256:${"e".repeat(64)}`,
  artifactId, version, contentHash, sourceDigest }, resumeWitness })!
const approvedIntent = { schemaVersion: "objective-application-review-approved-intent.v1", userId, sessionId,
  reviewTurnId, applicationTaskId, jobId, approvalId, setId, slotOrdinal: selectedOrdinal, sourceTurnId,
  materialProofHash: proof.materialProofHash }
const source = { schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1", approvalId, reviewTurnId,
  materialProofHash: proof.materialProofHash }
const fillInput = { clientMessageId: `agent-objective-reviewed-fill:${approvalId}`,
  content: [{ type: "text", text: "Fill the server-bound application form for user review. Never submit it." }],
  goal: "Fill the server-bound application form for user review. Never submit it.", reviewedApplicationMaterialSource: source }
const reviewInput = { clientMessageId: "review-command", content: [{ type: "text", text: "Review" }],
  goal: "Review the selected completed Objective materials for application preparation.",
  intent: { kind: "objective_application_review", version: 1, selection: { ...selection, slotOrdinals: [2, 4] } } }
const expiry = new Date("2026-11-24T11:00:00.000Z"), decided = new Date("2026-11-24T10:00:00.000Z")
const fillCreated = new Date("2026-11-24T10:01:00.000Z")

function setState(): ObjectiveApplicationReviewSetState {
  const member = { slotOrdinal: selectedOrdinal, approvalId, applicationTaskId, jobId, status: "approved" as const,
    receiptRevision: 8, proof }
  return { status: "resolved", setId, itemId, intentHash: objectiveApplicationReviewIntentHash(selection),
    members: [member, { ...member, slotOrdinal: 4, approvalId: objectiveApplicationReviewApprovalId(setId, 4),
      applicationTaskId: "application-4", jobId: "job-4", status: "expired" }] }
}

function fixture(overrides: { eventRows?: unknown[]; fillInput?: unknown; reviewInput?: unknown; createdAt?: Date; fillStatus?: string;
  taskFillTurnId?: string; taskStatus?: string; checkpoint?: string; artifact?: Record<string, unknown> } = {}) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const eventData = { ...approvedIntent }
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "application_task_events"')) return { rows: overrides.eventRows ?? [{ id: objectiveApplicationApprovedIntentId(setId, selectedOrdinal),
      taskId: applicationTaskId, type: "objective_application_review_approved", actor: "user",
      body: "Objective application review approval recorded.", data: eventData }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ status: "completed", source: "user", executionMode: "canonical_task_graph", input: overrides.reviewInput ?? reviewInput }], rowCount: 1 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: [{ status: "approved", expiresAt: expiry, decidedAt: decided, consumedAt: null,
      materialHash: proof.materialProofHash, fillCreatedAt: overrides.createdAt ?? fillCreated, fillSource: "user",
      fillExecutionMode: "canonical_task_graph", fillStatus: overrides.fillStatus ?? "in_progress", fillInput: overrides.fillInput ?? fillInput }], rowCount: 1 }
    if (sql.includes('FROM "application_tasks"')) return { rows: [{ id: applicationTaskId, resumeId: "resume-current",
      fillTurnId: overrides.taskFillTurnId ?? fillTurnId, fillTurnSessionId: sessionId, fillTurnUserId: userId,
      status: overrides.taskStatus ?? "filling", checkpoint: overrides.checkpoint ?? "taskgraph_fill_queued" }], rowCount: 1 }
    if (sql.includes('FROM "agent_artifact_version"')) return { rows: [overrides.artifact ?? { content: draft,
      artifactType: "cover_letter", taskId: "writer-task-2", contentHash, sourceDigest }], rowCount: 1 }
    throw new Error(`unexpected read: ${sql}`)
  })
  const client = { query } as unknown as Pick<PoolClient, "query">
  const turnInput = overrides.fillInput ?? fillInput
  return { client, calls, turnInput, eventData }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readSet.mockResolvedValue(setState())
  mocks.readResume.mockResolvedValue({ witness: resumeWitness, resumeContent: material.content })
  mocks.readSource.mockResolvedValue({ sourceTurnId, reviewTurnId, sourceRootTaskId: sourceRootId,
    graphItemId, graphRevision, finalItemId: "final-source", outcomes: [{ slotId: "tailor-2", jobId,
      writerTaskId: proof.source.writerTaskId, reviewerTaskId: proof.source.reviewerTaskId, status: "ready",
      artifactRef: { artifactId, version, contentHash, sourceDigest },
      reviewReceipt: { taskId: proof.source.reviewerTaskId, status: "passed", artifactId, version, contentHash,
        sourceDigest, currentSourceDigest: sourceDigest, toolCallId: proof.source.reviewerToolCallId, reviewHash: proof.source.reviewHash } }] })
})

function input(turnInput: unknown = fillInput, phase: "prepare" | "browser_start" | "completion" | "completion_replay" | "authorize" | "marker" | "boundary" = "browser_start") {
  return { userId, sessionId, fillTurnId, applicationTaskId, jobId, turnInput, phase, now: new Date("2026-11-24T10:02:00.000Z") }
}

describe("Objective reviewed application Fill reader", () => {
  it("rebuilds one approved slot from a resolved mixed group and returns the exact current adapted Resume", async () => {
    const test = fixture()
    const result = await readObjectiveReviewedApplicationFillSource(test.client, input())
    expect(result).toMatchObject({ source, approvedIntent, proof, resumeWitness, resumeContent: material.content,
      reviewedArtifact: { sourceTurnId, rootTaskId: sourceRootId, graphRevision, jobId, content: draft } })
    expect(mocks.readSource).toHaveBeenCalledWith(test.client, expect.objectContaining({ reviewTurnMode: "completed",
      selectedSlotIds: ["tailor-2"], graphRevision, graphItemId, rootTaskId: sourceRootId }))
    expect(mocks.readResume).toHaveBeenCalledWith(test.client, { userId, jobId })
    expect(test.calls[0]?.values).toEqual([applicationTaskId, userId, sessionId, jobId, approvalId])
    expect(JSON.stringify(result)).toContain(draft)
  })

  it.each(["prepare", "browser_start"] as const)("accepts the exact waiting parent Turn during %s", async phase => {
    const waitingParent = fixture({ fillStatus: "waiting_for_dependency" })
    await expect(readObjectiveReviewedApplicationFillSource(waitingParent.client, input(fillInput, phase)))
      .resolves.toMatchObject({ source, resumeContent: material.content })
    for (const fillStatus of ["waiting_for_user", "waiting_for_approval", "completed"]) {
      const wrongState = fixture({ fillStatus })
      await expect(readObjectiveReviewedApplicationFillSource(wrongState.client, input(fillInput, phase))).resolves.toBeUndefined()
    }
  })

  it("rejects an unknown phase before database reads", async () => {
    const test = fixture()
    const invalid = { ...input(), phase: "unknown" } as unknown as Parameters<typeof readObjectiveReviewedApplicationFillSource>[1]
    await expect(readObjectiveReviewedApplicationFillSource(test.client, invalid)).resolves.toBeUndefined()
    expect(test.calls).toHaveLength(0)
  })

  it.each([
    ["wrong approved pointer", { eventRows: [{ id: "foreign-event", taskId: applicationTaskId, type: "objective_application_review_approved",
      actor: "user", body: "Objective application review approval recorded.", data: { ...approvedIntent, approvalId: "other-approval" } }] }],
    ["duplicate matching pointer", { eventRows: Array(2).fill({ id: objectiveApplicationApprovedIntentId(setId, selectedOrdinal), taskId: applicationTaskId,
      type: "objective_application_review_approved", actor: "user", body: "Objective application review approval recorded.", data: approvedIntent }) }],
    ["Fill Turn created before the approval", { createdAt: new Date(decided.getTime() - 1) }],
    ["Fill Turn created after approval expiry", { createdAt: new Date(expiry.getTime() + 1) }],
    ["Fill task points at another Turn", { taskFillTurnId: "foreign-fill-turn" }],
    ["Fill Turn is not active", { fillStatus: "completed" }],
    ["Fill Turn input has a changed selector", { fillInput: { ...fillInput, reviewedApplicationMaterialSource: { ...source, approvalId: "other" } } }],
    ["artifact content changed", { artifact: { content: "changed", artifactType: "cover_letter", taskId: proof.source.writerTaskId, contentHash, sourceDigest } }],
  ])("fails closed for %s", async (_name, options) => {
    const test = fixture(options as Parameters<typeof fixture>[0])
    await expect(readObjectiveReviewedApplicationFillSource(test.client, input(test.turnInput))).resolves.toBeUndefined()
  })

  it("rejects a changed current Resume witness before reading artifact content", async () => {
    mocks.readResume.mockResolvedValueOnce({ witness: { ...resumeWitness, materialRevision: 8 }, resumeContent: material.content })
    const test = fixture()
    await expect(readObjectiveReviewedApplicationFillSource(test.client, input())).resolves.toBeUndefined()
    expect(test.calls.some(call => call.sql.includes('FROM "agent_artifact_version"'))).toBe(false)
  })

  it("requires the review Turn selection, proof graph identity, and effective receipt to match", async () => {
    const test = fixture()
    const tampered = { ...reviewInput, intent: { ...reviewInput.intent,
      selection: { ...reviewInput.intent.selection, graphRevision: graphRevision - 1 } } }
    await expect(readObjectiveReviewedApplicationFillSource(test.client, input(fillInput))).resolves.toMatchObject({ source })
    const changed = fixture({ reviewInput: tampered })
    await expect(readObjectiveReviewedApplicationFillSource(changed.client, input())).resolves.toBeUndefined()
    test.calls.length = 0
    mocks.readSource.mockResolvedValueOnce({ sourceTurnId, reviewTurnId, sourceRootTaskId: sourceRootId,
      graphItemId, graphRevision, finalItemId: "final-source", outcomes: [{ slotId: "tailor-2", jobId,
        writerTaskId: proof.source.writerTaskId, reviewerTaskId: proof.source.reviewerTaskId, status: "ready",
        artifactRef: { artifactId, version, contentHash, sourceDigest }, reviewReceipt: { taskId: proof.source.reviewerTaskId,
          status: "failed", artifactId, version, contentHash, sourceDigest, currentSourceDigest: sourceDigest,
          toolCallId: proof.source.reviewerToolCallId, reviewHash: proof.source.reviewHash } }] })
    await expect(readObjectiveReviewedApplicationFillSource(test.client, input())).resolves.toBeUndefined()
  })

  it.each(["queued", "in_progress", "waiting_for_dependency"])("accepts fresh completion only on live Turn status %s", async status => {
    const test = fixture({ fillStatus: status, checkpoint: "browser_active" })
    await expect(readObjectiveReviewedApplicationFillSource(test.client, input(fillInput, "completion")))
      .resolves.toMatchObject({ source, resumeContent: material.content })
  })

  it("rejects fresh completion when the task did not reach browser_active or the Turn is terminal", async () => {
    for (const test of [fixture({ checkpoint: "taskgraph_fill_queued" }), fixture({ fillStatus: "completed", checkpoint: "browser_active" })]) {
      await expect(readObjectiveReviewedApplicationFillSource(test.client, input(fillInput, "completion"))).resolves.toBeUndefined()
    }
  })

  it("accepts only the exact post-completion replay state", async () => {
    const valid = fixture({ taskStatus: "waiting_for_authorization", checkpoint: "form_filled", fillStatus: "waiting_for_approval" })
    await expect(readObjectiveReviewedApplicationFillSource(valid.client, input(fillInput, "completion_replay"))).resolves.toMatchObject({ source })
    const incomplete = fixture({ taskStatus: "filling", checkpoint: "browser_active", fillStatus: "waiting_for_approval" })
    await expect(readObjectiveReviewedApplicationFillSource(incomplete.client, input(fillInput, "completion_replay"))).resolves.toBeUndefined()
  })

  it.each(["authorize", "marker", "boundary"] as const)("rechecks exact Objective source at submit phase %s", async phase => {
    const checkpoint = phase === "boundary" ? "submission_request_started" : "browser_active"
    for (const fillStatus of ["waiting_for_approval", "queued", "in_progress"]) {
      const valid = fixture({ taskStatus: "filling", checkpoint, fillStatus })
      await expect(readObjectiveReviewedApplicationFillSource(valid.client, input(fillInput, phase))).resolves.toMatchObject({ source })
    }
    const dependencyWait = fixture({ taskStatus: "filling", checkpoint, fillStatus: "waiting_for_dependency" })
    await expect(readObjectiveReviewedApplicationFillSource(dependencyWait.client, input(fillInput, phase))).resolves.toBeUndefined()
    const terminal = fixture({ taskStatus: "filling", checkpoint, fillStatus: "completed" })
    await expect(readObjectiveReviewedApplicationFillSource(terminal.client, input(fillInput, phase))).resolves.toBeUndefined()
    const wrongCheckpoint = fixture({ taskStatus: "filling", checkpoint: phase === "boundary" ? "browser_active" : "submission_request_started" })
    await expect(readObjectiveReviewedApplicationFillSource(wrongCheckpoint.client, input(fillInput, phase))).resolves.toBeUndefined()
  })

  it("rejects a malformed private Objective selector without database reads", async () => {
    const test = fixture()
    await expect(readObjectiveReviewedApplicationFillSource(test.client, input({ reviewedApplicationMaterialSource: { ...source, extra: true } })))
      .resolves.toBeUndefined()
    expect(test.calls).toHaveLength(0)
    expect(parseObjectiveApplicationReviewIntent(selection)).not.toBeNull()
  })
})
