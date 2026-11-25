import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashObjectiveApplicationSubmissionMaterial, OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA } from "@jobcopilot/shared"
import { protocolScope } from "../approval/types.js"
import { resumeAgentTurn } from "./resume-agent-turn-transaction.js"
import { resumeAgentTurnInTransaction } from "./resume-agent-turn-transaction.js"
import type { AgentTurnWakeupPayload } from "./types.js"

const objectiveMocks = vi.hoisted(() => ({ hasManifest: vi.fn(), readManifest: vi.fn() }))
vi.mock("../../db/objective-reviewed-application-submit-material.js", () => ({
  hasObjectiveSubmissionManifestEvidence: objectiveMocks.hasManifest,
}))
vi.mock("../../db/objective-submission-manifest-event.js", () => ({
  readObjectiveSubmissionManifestWithClient: objectiveMocks.readManifest,
}))

describe("Agent wakeup resume transaction", () => {
  it("rolls back and releases when a direct group payload carries unsupported fields", async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 } }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
    const payload = {
      eventId: "event_1", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:approval-set:set_1",
      waitKind: "approval_set", waitId: "set_1", toolCallId: null, status: "resolved", nextTurnRevision: 8,
      unrecognized: true,
    } as AgentTurnWakeupPayload

    await expect(resumeAgentTurn(pool, payload)).rejects.toMatchObject({ code: "schema_invalid_payload" })
    expect(statements).toEqual(["BEGIN", "ROLLBACK"])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("acknowledges the exact Objective submit approval without queueing or dispatching the Fill Turn", async () => {
    const setup = await objectiveSubmitWakeFixture()
    await expect(resumeAgentTurnInTransaction(setup.client, setup.payload)).resolves.toMatchObject({ status: "ignored" })
    expect(setup.calls.some(sql => sql.includes("SET \"status\" = 'queued'") || sql.includes("INSERT INTO"))).toBe(false)
  })

  it("terminalizes a mismatched Objective submit wake instead of scheduling generic model work", async () => {
    const setup = await objectiveSubmitWakeFixture(true)
    await expect(resumeAgentTurnInTransaction(setup.client, setup.payload)).rejects.toMatchObject({ code: "objective_final_submit_wait_mismatch" })
    expect(setup.calls.some(sql => sql.includes("SET \"status\" = 'queued'") || sql.includes("INSERT INTO"))).toBe(false)
  })

  it("keeps an ordinary submit approval wake on the prior resume path without V3 evidence", async () => {
    const setup = await objectiveSubmitWakeFixture(false, false)
    await expect(resumeAgentTurnInTransaction(setup.client, setup.payload)).resolves.toMatchObject({ status: "resumed" })
    expect(setup.calls.some(sql => sql.includes("SET \"status\" = 'queued'"))).toBe(true)
  })
})

async function objectiveSubmitWakeFixture(mismatch = false, objective = true) {
  const ids = { userId: "user_1", sessionId: "session_1", turnId: "fill_turn_1", taskId: "application_1", jobId: "job_1" }
  const approvalId = `application-fill:${ids.taskId}:${ids.turnId}`, toolCallId = `application-submit:${ids.taskId}`
  const itemId = `agent-wait:approval:${approvalId}`, eventId = "wake_event_1", revision = 10
  const payload: AgentTurnWakeupPayload = { eventId, sessionId: ids.sessionId, turnId: ids.turnId, itemId,
    waitKind: "approval", waitId: approvalId, toolCallId, status: "approved", nextTurnRevision: revision }
  const expiresAt = new Date("2027-01-01T00:15:00.000Z"), decidedAt = new Date("2026-12-31T23:59:00.000Z")
  const resourceHash = "1".repeat(64), answersHash = "3".repeat(64)
  const objectiveSource = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
    approvalId: `objective-review:objective-review-${"a".repeat(40)}:2`, reviewTurnId: "review_turn_1", materialProofHash: "b".repeat(64) }
  const material = { schemaVersion: "agent-harness.v2.objective-application-submit-material.v1", applicationTaskId: ids.taskId,
    jobId: ids.jobId, resumeId: "resume_1", coverLetterId: "letter_1", reviewedCoverLetterHash: "6".repeat(64), objectiveSource }
  const materialHash = await hashObjectiveApplicationSubmissionMaterial(material)
  if (!materialHash) throw new Error("fixture material hash unavailable")
  const manifest = { schemaVersion: "agent-harness.application-submission.v3", material, answersHash }
  const hashes = { resourceHash, materialHash, answersHash, nonceHash: "4".repeat(64) }
  objectiveMocks.hasManifest.mockReset().mockResolvedValue(objective)
  objectiveMocks.readManifest.mockReset().mockResolvedValue({ manifest, hash: `sha256:${resourceHash}` })
  const scopeHash = await hashApprovalScope(protocolScope({ ...ids, turnId: ids.turnId, toolCallId,
    action: "submit_application", ...hashes, revision: 8, expiresAt }, hashes.nonceHash))
  const task = { id: ids.taskId, userId: ids.userId, sessionId: ids.sessionId, jobId: ids.jobId, fillTurnId: ids.turnId,
    fillTurnSessionId: ids.sessionId, fillTurnUserId: ids.userId, resumeId: "resume_1", coverLetterId: "letter_1" }
  const approval = { id: approvalId, ...ids, toolCallId, type: "submit_application", status: "approved", payload: {
    applicationTaskId: ids.taskId, jobId: ids.jobId, resumeId: task.resumeId, coverLetterId: task.coverLetterId,
  }, ...hashes, scopeHash, revision: 8, expiresAt, decidedAt, consumedAt: null, impact: { externalSubmission: true, jobId: ids.jobId } }
  const item = { id: itemId, sessionId: ids.sessionId, turnId: ids.turnId, type: "approval_request", status: "completed", taskId: null,
    content: { waitKind: "approval", approvalId, toolCallId, action: "submit_application", scopeHash, receiptRevision: 8,
      expiresAt: expiresAt.toISOString(), decision: "approved", responseAvailable: true, respondedAt: decidedAt.toISOString(),
      impact: { externalSubmission: true, jobId: ids.jobId } } }
  const resolution = { id: "resolved_event_1", sessionId: ids.sessionId, turnId: ids.turnId, itemId, taskId: ids.taskId,
    type: "approval.resolved", actor: "user", correlationId: approvalId, causationId: mismatch ? "other_item" : itemId,
    idempotencyKey: "agent-wait-command:command_1", payload: { waitKind: "approval", waitId: approvalId, itemId,
      turnId: ids.turnId, toolCallId, status: "approved", nextTurnRevision: revision, answerAvailable: false } }
  const wakeupEvent = { id: eventId, sessionId: ids.sessionId, turnId: ids.turnId, itemId, taskId: null, type: "turn.wakeup",
    actor: "user", correlationId: ids.turnId, causationId: "resolved_event_1", idempotencyKey: "agent-wait-command:command_1:wakeup",
    payload: { waitKind: "approval", waitId: approvalId, itemId, turnId: ids.turnId, toolCallId, status: "approved", nextTurnRevision: revision } }
  const turn = { userId: ids.userId, status: "waiting_for_approval", revision, source: "user", executionMode: "canonical_task_graph",
    input: { clientMessageId: "fill_1", content: [], goal: "Fill the server-bound application form for user review. Never submit it.",
      ...(objective ? { reviewedApplicationMaterialSource: objectiveSource } : {}) },
    rootTaskId: "root_1", hasLiveLease: true }
  const calls: string[] = []
  const client = { query: vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql.includes('SELECT "userId", "status" FROM "agent_sessions"')) return { rows: [{ userId: ids.userId, status: "running" }], rowCount: 1 }
    if (sql.includes("SELECT set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT turn."userId"')) return { rows: [turn], rowCount: 1 }
    if (sql.includes('FROM "application_tasks"')) return { rows: [task], rowCount: 1 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: [approval], rowCount: 1 }
    if (sql.includes('FROM "agent_items"')) return { rows: [item], rowCount: 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes('"type" = \'turn.wakeup\'')) return { rows: [wakeupEvent], rowCount: 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes('"type"=\'turn.wakeup\'')) return { rows: [wakeupEvent], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) return { rows: [resolution], rowCount: 1 }
    if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 1 }
    if (sql.includes('UPDATE "agent_sessions" AS session')) return { rows: [{ eventSequence: "11" }], rowCount: 1 }
    if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: [{ id: ids.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"')) return { rows: [{ id: ids.turnId }], rowCount: 1 }
    if (sql.startsWith("INSERT INTO")) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) } as unknown as pg.PoolClient
  return { client, payload, calls }
}
