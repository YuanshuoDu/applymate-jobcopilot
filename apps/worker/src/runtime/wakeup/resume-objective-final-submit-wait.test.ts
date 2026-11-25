import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashObjectiveApplicationSubmissionMaterial, OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA } from "@jobcopilot/shared"
import { protocolScope } from "../approval/types.js"
import type { AgentTurnWakeupPayload } from "./types.js"
import { inspectObjectiveFinalSubmitWake } from "./resume-objective-final-submit-wait.js"

const objectiveMocks = vi.hoisted(() => ({ hasManifest: vi.fn(), readManifest: vi.fn() }))
vi.mock("../../db/objective-reviewed-application-submit-material.js", () => ({
  hasObjectiveSubmissionManifestEvidence: objectiveMocks.hasManifest,
}))
vi.mock("../../db/objective-submission-manifest-event.js", () => ({
  readObjectiveSubmissionManifestWithClient: objectiveMocks.readManifest,
}))

const ids = { userId: "user_1", sessionId: "session_1", turnId: "fill_turn_1", taskId: "application_1", jobId: "job_1" }
const approvalId = `application-fill:${ids.taskId}:${ids.turnId}`
const toolCallId = `application-submit:${ids.taskId}`
const itemId = `agent-wait:approval:${approvalId}`
const reviewedSource = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:2`, reviewTurnId: "review_turn_1", materialProofHash: "b".repeat(64) }
const payload: AgentTurnWakeupPayload = { eventId: "wake_event_1", sessionId: ids.sessionId, turnId: ids.turnId,
  itemId, waitKind: "approval", waitId: approvalId, toolCallId, status: "approved", nextTurnRevision: 10 }
const expiresAt = new Date("2027-01-01T00:15:00.000Z")
const decidedAt = new Date("2026-12-31T23:59:00.000Z")
const task = { id: ids.taskId, userId: ids.userId, sessionId: ids.sessionId, jobId: ids.jobId,
  fillTurnId: ids.turnId, fillTurnSessionId: ids.sessionId, fillTurnUserId: ids.userId, resumeId: "resume_1", coverLetterId: "letter_1" }
const hashes = { resourceHash: "1".repeat(64), materialHash: "2".repeat(64), answersHash: "3".repeat(64), nonceHash: "4".repeat(64) }
const scope = { userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, jobId: ids.jobId,
  toolCallId, action: "submit_application" as const, ...hashes, revision: 8, expiresAt }

async function fixture(overrides: { task?: Record<string, unknown>; approval?: Record<string, unknown>; item?: Record<string, unknown>;
  resolution?: Record<string, unknown>; wakeup?: Record<string, unknown>; manifestEvidence?: boolean;
  consumed?: boolean; manifest?: Record<string, unknown> } = {}) {
  const material = { schemaVersion: "agent-harness.v2.objective-application-submit-material.v1",
    applicationTaskId: ids.taskId, jobId: ids.jobId, resumeId: "resume_1", coverLetterId: "letter_1",
    reviewedCoverLetterHash: "6".repeat(64), objectiveSource: reviewedSource }
  const materialHash = await hashObjectiveApplicationSubmissionMaterial(material)
  if (!materialHash) throw new Error("fixture material hash unavailable")
  const resourceHash = "5".repeat(64)
  const manifest = { schemaVersion: "agent-harness.application-submission.v3", material, answersHash: hashes.answersHash,
    ...(overrides.manifest ?? {}) }
  const stored = { manifest, hash: `sha256:${resourceHash}` }
  objectiveMocks.hasManifest.mockReset().mockResolvedValue(overrides.manifestEvidence ?? true)
  objectiveMocks.readManifest.mockReset().mockResolvedValue(stored)
  const approvalHashes = { ...hashes, resourceHash, materialHash }
  const approvalScope = { ...scope, ...approvalHashes }
  const scopeHash = await hashApprovalScope(protocolScope(approvalScope, hashes.nonceHash))
  const approval = { id: approvalId, ...ids, taskId: ids.taskId, type: "submit_application", status: "approved", toolCallId,
    payload: { applicationTaskId: ids.taskId, jobId: ids.jobId, resumeId: "resume_1", coverLetterId: "letter_1" }, ...approvalHashes,
    scopeHash, revision: 8, expiresAt, decidedAt, consumedAt: null, impact: { externalSubmission: true, jobId: ids.jobId },
    ...(overrides.consumed ? { status: "consumed", consumedAt: new Date("2027-01-01T00:00:00.000Z") } : {}),
    ...(overrides.approval ?? {}) }
  const item = { id: itemId, sessionId: ids.sessionId, turnId: ids.turnId, type: "approval_request", status: "completed", taskId: null,
    content: { waitKind: "approval", approvalId, toolCallId, action: "submit_application", scopeHash,
      receiptRevision: 8, expiresAt: expiresAt.toISOString(), decision: "approved", responseAvailable: true,
      respondedAt: decidedAt.toISOString(), impact: { externalSubmission: true, jobId: ids.jobId } }, ...(overrides.item ?? {}) }
  const resolution = { id: "resolved_event_1", sessionId: ids.sessionId, turnId: ids.turnId, itemId, taskId: ids.taskId,
    type: "approval.resolved", actor: "user", correlationId: approvalId, causationId: itemId,
    idempotencyKey: "agent-wait-command:command_1", payload: { waitKind: "approval", waitId: approvalId, itemId,
      turnId: ids.turnId, toolCallId, status: "approved", nextTurnRevision: 10, answerAvailable: false }, ...(overrides.resolution ?? {}) }
  const wakeup = { id: payload.eventId, sessionId: ids.sessionId, turnId: ids.turnId, itemId, taskId: null,
    type: "turn.wakeup", actor: "user", correlationId: ids.turnId, causationId: resolution.id,
    idempotencyKey: `${resolution.idempotencyKey}:wakeup`, payload: { waitKind: "approval", waitId: approvalId, itemId,
      turnId: ids.turnId, toolCallId, status: "approved", nextTurnRevision: 10 }, ...(overrides.wakeup ?? {}) }
  const data = { task: { ...task, ...(overrides.task ?? {}) }, approval, item, resolution, wakeup }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM "application_tasks"')) return { rows: [data.task], rowCount: 1 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: [data.approval], rowCount: 1 }
    if (sql.includes('FROM "agent_items"')) return { rows: [data.item], rowCount: 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes('"type"=\'turn.wakeup\'')) return { rows: [data.wakeup], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) return { rows: [data.resolution], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const client = { query }
  return { client: client as unknown as Pick<pg.PoolClient, "query">, query, data, stored }
}

const turn = { source: "user", executionMode: "canonical_task_graph", input: { clientMessageId: "fill_1", content: [],
  goal: "Fill the server-bound application form for user review. Never submit it.", reviewedApplicationMaterialSource: reviewedSource },
  status: "waiting_for_approval", revision: payload.nextTurnRevision }

describe("Objective final submit wake admission", () => {
  it("acknowledges only the exact approved Objective final wait without writing", async () => {
    const { client, stored, query } = await fixture()
    await expect(inspectObjectiveFinalSubmitWake(client, payload, turn, ids.userId)).resolves.toBe("acknowledge")
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true)
    expect(objectiveMocks.readManifest).toHaveBeenCalledWith(client, {
      userId: ids.userId, sessionId: ids.sessionId, applicationTaskId: ids.taskId, jobId: ids.jobId, fillTurnId: ids.turnId,
    })
    expect(stored.hash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it("acknowledges a consumed receipt only when its consumption followed approval and preceded expiry", async () => {
    const { client } = await fixture({ consumed: true })
    await expect(inspectObjectiveFinalSubmitWake(client, payload, turn, ids.userId)).resolves.toBe("acknowledge")
    const expired = await fixture({ consumed: true, approval: { consumedAt: new Date("2027-01-01T00:15:00.000Z") } })
    expect(expired.data.approval.consumedAt).toEqual(expiresAt)
    await expect(inspectObjectiveFinalSubmitWake(expired.client, payload, turn, ids.userId)).resolves.toBe("mismatch")
  })

  it.each([
    ["foreign Task", { task: { userId: "other_user" } }],
    ["wrong receipt type", { approval: { type: "review_application" } }],
    ["forged scope hash", { approval: { scopeHash: "9".repeat(64) } }],
    ["wrong wait action", { item: { content: { action: "review_application" } } }],
    ["unlinked approval event", { resolution: { causationId: "foreign_item" } }],
    ["unlinked wake event", { wakeup: { causationId: "foreign_resolution" } }],
  ] as const)("rejects %s evidence", async (_name, overrides) => {
    const { client, data } = await fixture(overrides)
    if (_name === "wrong receipt type") expect(data.approval.type).toBe("review_application")
    await expect(inspectObjectiveFinalSubmitWake(client, payload, turn, ids.userId)).resolves.toBe("mismatch")
  })

  it("fails closed for a malformed Objective marker but leaves valid selected and legacy waits alone", async () => {
    const malformed = { ...turn, input: { ...turn.input, reviewedApplicationMaterialSource: { ...reviewedSource, extra: true } } }
    const { client } = await fixture({ manifestEvidence: false })
    await expect(inspectObjectiveFinalSubmitWake(client, payload, malformed, ids.userId)).resolves.toBe("mismatch")
    await expect(inspectObjectiveFinalSubmitWake(client, payload, { ...turn, input: {} }, ids.userId)).resolves.toBe("not_applicable")
    await expect(inspectObjectiveFinalSubmitWake(client, payload, { ...turn, input: { reviewedApplicationMaterialSource: {
      schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source_turn_1" } } }, ids.userId))
      .resolves.toBe("not_applicable")
    expect(objectiveMocks.hasManifest).toHaveBeenCalled()
  })

  it("detects a stripped Objective marker from the scoped V3 manifest before falling through", async () => {
    const { client } = await fixture({ manifestEvidence: true })
    const stripped = { ...turn, input: { clientMessageId: "fill_1", content: [], goal: turn.input.goal } }
    await expect(inspectObjectiveFinalSubmitWake(client, payload, stripped, ids.userId)).resolves.toBe("mismatch")
    expect(objectiveMocks.hasManifest).toHaveBeenCalledWith(client, expect.objectContaining({
      applicationTaskId: ids.taskId, fillTurnId: ids.turnId, approvalId,
    }))
  })

  it("preserves rejection and question handling for the existing paths", async () => {
    const { client } = await fixture()
    await expect(inspectObjectiveFinalSubmitWake(client, { ...payload, status: "rejected" }, turn, ids.userId)).resolves.toBe("not_applicable")
    await expect(inspectObjectiveFinalSubmitWake(client, { ...payload, waitKind: "question", status: "answered" }, turn, ids.userId)).resolves.toBe("not_applicable")
    expect(client.query).not.toHaveBeenCalled()
  })
})
