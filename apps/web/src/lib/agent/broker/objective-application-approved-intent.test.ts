import { beforeEach, describe, expect, it, vi } from "vitest"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import {
  buildObjectiveApplicationReviewMemberProof,
  buildObjectiveApplicationResumeWitness,
} from "@jobcopilot/shared"
import { protocolScope } from "../approval/types"
import { recordObjectiveApplicationApprovedIntent } from "./objective-application-approved-intent"
import type { ObjectiveApprovalSetSourceInput } from "./objective-application-approval-set-decision"

const userId = "user-objective"
const sessionId = "session-objective"
const reviewTurnId = "review-turn-objective"
const sourceTurnId = "source-turn-objective"
const jobId = "job-objective"
const applicationTaskId = "application-task-objective"
const approvalId = "approval-objective"
const setId = "objective-review-set"
const slotOrdinal = 2
const now = new Date("2026-11-24T12:00:00.000Z")
const expiresAt = new Date("2026-11-24T13:00:00.000Z")

function proof() {
  const resumeWitness = buildObjectiveApplicationResumeWitness({
    userId, jobId, resumeId: "resume-objective", finalResumeAssignmentRevision: 4, materialRevision: 7,
    material: { name: "Adapted", content: { skills: ["TypeScript"] }, templateId: "resume-template", templateOptions: null,
      kind: "adapted", targetJobId: jobId, parentResumeId: "resume-base", basicsDetached: false },
  })!
  return buildObjectiveApplicationReviewMemberProof({
    source: { jobId, sourceTurnId, rootTaskId: "root-objective", graphItemId: "graph-objective", graphRevision: 8,
      finalItemId: "final-objective", slotOrdinal, writerTaskId: "writer-objective", reviewerTaskId: "reviewer-objective",
      reviewerToolCallId: "review-call-objective", reviewHash: "sha256:" + "a".repeat(64), artifactId: "artifact-objective",
      version: 3, contentHash: "sha256:" + "b".repeat(64), sourceDigest: "sha256:" + "c".repeat(64) },
    resumeWitness,
  })!
}

function scopeHash(materialHash: string, nonceHash: string) {
  return hashApprovalScope(protocolScope({ userId, sessionId, turnId: reviewTurnId, jobId, toolCallId: "tool-objective",
    action: "review_application", resourceHash: "d".repeat(64), materialHash, answersHash: "e".repeat(64),
    revision: 5, expiresAt }, nonceHash))
}

async function fixture(overrides: Readonly<{ approval?: Record<string, unknown>; task?: Record<string, unknown>; events?: Record<string, unknown>[] }> = {}) {
  const memberProof = proof()
  const nonceHash = "f".repeat(64)
  const approval = {
    id: approvalId, userId, sessionId, turnId: reviewTurnId, taskId: applicationTaskId, jobId,
    toolCallId: "tool-objective", type: "review_application", status: "approved", title: "Review application",
    body: "Approve these reviewed materials for a later form fill.", impact: { externalSubmission: false, jobId },
    payload: { schema: "objective-application-approval-set-member.v1", setId, sourceTurnId, slotOrdinal, proof: memberProof },
    resourceHash: "d".repeat(64), materialHash: memberProof.materialProofHash, answersHash: "e".repeat(64),
    scopeHash: await scopeHash(memberProof.materialProofHash, nonceHash), nonceHash, revision: 5,
    expiresAt, decidedAt: now, consumedAt: null,
  }
  const task = { id: applicationTaskId, resumeId: "resume-objective", status: "waiting_for_user", checkpoint: "materials_ready",
    workerTaskId: null, fillTurnId: null, fillTurnSessionId: null, fillTurnUserId: null, startedAt: null, completedAt: null }
  const events = [...(overrides.events ?? [])]
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: applicationTaskId }]),
    agentApproval: { findFirst: vi.fn(async () => ({ ...approval, ...(overrides.approval ?? {}) })) },
    applicationTask: { findFirst: vi.fn(async () => ({ ...task, ...(overrides.task ?? {}) })) },
    applicationTaskEvent: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => events.filter(row => {
        const data = row.data as Record<string, unknown> | undefined
        return row.taskId === where.taskId && row.type === where.type && data?.approvalId === "approval-objective"
      })),
      findUnique: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data }),
    },
  }
  const input: ObjectiveApprovalSetSourceInput = {
    setId, intentHash: "1".repeat(64), sourceTurnId, slotOrdinal,
    member: { approvalId, taskId: applicationTaskId, userId, sessionId, turnId: reviewTurnId, jobId,
      toolCallId: "tool-objective", scopeHash: approval.scopeHash, revision: 5, expiresAt,
      proof: memberProof, resumeWitness: memberProof.resumeWitness },
  }
  return { tx, input, approval, task, events, memberProof }
}

describe("recordObjectiveApplicationApprovedIntent", () => {
  beforeEach(() => vi.clearAllMocks())

  it("records a deterministic private pointer after the exact approved receipt and ready task are re-read", async () => {
    const { tx, input, events, memberProof } = await fixture()
    await recordObjectiveApplicationApprovedIntent(tx as never, input)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      id: `objective-application-approved:${setId}:${slotOrdinal}`, taskId: applicationTaskId,
      type: "objective_application_review_approved", actor: "user", body: "Objective application review approval recorded.",
      data: { schemaVersion: "objective-application-review-approved-intent.v1", userId, sessionId,
        reviewTurnId, applicationTaskId, jobId, approvalId, setId, slotOrdinal, sourceTurnId,
        materialProofHash: memberProof.materialProofHash },
    })
    const serialized = JSON.stringify(events[0])
    expect(serialized).not.toContain("TypeScript")
    expect(serialized).not.toContain("nonceHash")
    expect(tx.agentApproval.findFirst).toHaveBeenCalledWith({ where: { id: approvalId, userId, sessionId, turnId: reviewTurnId } })
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.applicationTask.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: applicationTaskId, userId, sessionId, jobId },
    }))
  })

  it("accepts only the exact deterministic event on transaction replay", async () => {
    const { tx, input, events } = await fixture()
    await recordObjectiveApplicationApprovedIntent(tx as never, input)
    const prior = events[0]!
    const replay = await fixture({ events: [prior] })
    await recordObjectiveApplicationApprovedIntent(replay.tx as never, replay.input)
    expect(replay.tx.applicationTaskEvent.create).not.toHaveBeenCalled()
  })

  it("rejects a self-consistent row scope field whose hash does not verify", async () => {
    const invalidHash = "2".repeat(64)
    const { tx, input, events } = await fixture({ approval: { scopeHash: invalidHash } })
    const mismatched = { ...input, member: { ...input.member, scopeHash: invalidHash } }
    await expect(recordObjectiveApplicationApprovedIntent(tx as never, mismatched)).rejects.toThrow("objective_application_approved_intent_invalid")
    expect(events).toHaveLength(0)
  })

  it.each([
    ["unapproved receipt", { status: "pending" }, undefined],
    ["wrong owner", { userId: "other-user" }, undefined],
    ["changed material hash", { materialHash: "2".repeat(64) }, undefined],
    ["changed scope hash", { scopeHash: "2".repeat(64) }, undefined],
    ["malformed persisted proof", { payload: { schema: "objective-application-approval-set-member.v1", setId, sourceTurnId,
      slotOrdinal, proof: { schema: "invalid" } } }, undefined],
    ["task no longer ready", undefined, { status: "filling" }],
    ["task bound to another Fill Turn", undefined, { fillTurnId: "fill-turn-other" }],
  ] as const)("rejects %s without creating an event", async (_name, approvalOverrides, taskOverrides) => {
    const { tx, input, events } = await fixture({ approval: approvalOverrides, task: taskOverrides })
    await expect(recordObjectiveApplicationApprovedIntent(tx as never, input)).rejects.toThrow("objective_application_approved_intent_invalid")
    expect(events).toHaveLength(0)
    expect(tx.applicationTaskEvent.create).not.toHaveBeenCalled()
  })

  it("rejects ambiguous or colliding prior events", async () => {
    const duplicate = { taskId: applicationTaskId, type: "objective_application_review_approved",
      data: { approvalId } }
    const { tx, input, events } = await fixture({ events: [{ ...duplicate, id: "other" }, { ...duplicate, id: "another" }] })
    await expect(recordObjectiveApplicationApprovedIntent(tx as never, input)).rejects.toThrow("objective_application_approved_intent_invalid")
    expect(events).toHaveLength(2)
    const collision = await fixture()
    collision.tx.applicationTaskEvent.findUnique.mockResolvedValue({ id: `objective-application-approved:${setId}:${slotOrdinal}` })
    await expect(recordObjectiveApplicationApprovedIntent(collision.tx as never, collision.input)).rejects.toThrow("objective_application_approved_intent_invalid")
  })

  it("allows a newer approval for the same task when an older approval intent already exists", async () => {
    const earlier = { taskId: applicationTaskId, type: "objective_application_review_approved",
      data: { approvalId: "prior-approval", setId: "prior-set", slotOrdinal: 1 } }
    const { tx, input, events } = await fixture({ events: [earlier] })
    await recordObjectiveApplicationApprovedIntent(tx as never, input)
    expect(events).toHaveLength(2)
    expect(tx.applicationTaskEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId: applicationTaskId, type: "objective_application_review_approved",
        data: { path: ["approvalId"], equals: approvalId } },
    }))
  })
})
