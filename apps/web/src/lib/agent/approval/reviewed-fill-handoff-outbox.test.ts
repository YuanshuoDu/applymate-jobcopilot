import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma, PrismaClient } from "@prisma/client"

const { startFill, probeDuplicate, admitLaunch, processObjective } = vi.hoisted(() => ({
  startFill: vi.fn(), probeDuplicate: vi.fn(), admitLaunch: vi.fn(), processObjective: vi.fn(),
}))

vi.mock("../control-plane/commands/agent-command-service", () => ({
  AgentCommandService: class {
    constructor(_db: unknown) {}
    async startApplicationFillForReview(...args: unknown[]) { return startFill(...args) }
  },
}))
vi.mock("./reviewed-fill-admission", () => ({
  acknowledgeExistingReviewedFillHandoff: probeDuplicate,
  assertReviewedFillLaunchAllowed: admitLaunch,
}))
vi.mock("./objective-reviewed-fill-dispatch", () => ({ processObjectiveReviewedFillHandoffOutbox: processObjective }))

import { AgentCommandError } from "../control-plane/commands/errors"
import { AutoApplyError } from "@/lib/auto-apply-guards"
import {
  enqueueReviewedFillHandoffInTransaction,
  processReviewedFillHandoffOutbox,
  ReviewedFillHandoffOutboxNotFoundError,
} from "./reviewed-fill-handoff-outbox"
import { REVIEWED_FILL_SOURCE_SCHEMA } from "./reviewed-fill-source-binding"
import { buildObjectiveReviewedFillHandoffOutboxData, buildReviewedFillHandoffOutboxData } from "@jobcopilot/shared"

const NOW = new Date("2026-11-20T12:00:00.000Z")
const sourceId = "source_turn_1"
const objectiveSetId = `objective-review-${"a".repeat(40)}`
const objectiveApprovalId = `objective-review:${objectiveSetId}:2`
const intentInput = {
  userId: "user_1", sessionId: "session_1", applicationTaskId: "task_1",
  approvalId: "approval_1", predecessorTurnId: "turn_1",
}

function makeTransaction(options: { expiresAt?: Date; scheduled?: boolean; eventCount?: number } = {}) {
  const approval = {
    ...intentInput, id: intentInput.approvalId, turnId: intentInput.predecessorTurnId,
    taskId: intentInput.applicationTaskId, jobId: "job_1", type: "review_application", status: "approved",
    scopeHash: "scope_1", revision: 3, expiresAt: options.expiresAt ?? new Date(NOW.getTime() + 60_000),
    decidedAt: NOW, payload: { applicationTaskId: "task_1", jobId: "job_1", ...(options.scheduled ? { scheduledGateReview: true } : {}) },
  }
  const event = { id: "event_1", data: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, approvalId: approval.id, sourceTurnId: sourceId } }
  const outboxCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data)
  const client = {
    agentApproval: { findFirst: vi.fn(async () => approval) },
    applicationTask: { findFirst: vi.fn(async () => ({ id: "task_1" })) },
    agentTurn: { findFirst: vi.fn(async () => ({ id: sourceId, source: "user", rootTaskId: "root_1",
      input: { selectedJobPreparation: { jobId: "job_1" } } })) },
    applicationTaskEvent: { findMany: vi.fn(async () => Array.from({ length: options.eventCount ?? 1 }, (_, index) => ({ ...event, id: `event_${index}` }))) },
    agentOutbox: { create: outboxCreate },
  }
  return { approval, client, outboxCreate }
}

function makeOutboxRow(publishedAt: Date | null = null) {
  const built = buildReviewedFillHandoffOutboxData({ ...intentInput })!
  return { id: "outbox_1", ...built, publishedAt }
}

function makeObjectiveOutboxRow(publishedAt: Date | null = null) {
  const built = buildObjectiveReviewedFillHandoffOutboxData({ userId: "user_1", sessionId: "session_1",
    applicationTaskId: "task_1", approvalId: objectiveApprovalId, predecessorTurnId: "turn_1" })!
  return { id: "objective_outbox_1", ...built, publishedAt }
}

describe("reviewed fill handoff outbox", () => {
  beforeEach(() => {
    startFill.mockReset()
    probeDuplicate.mockReset().mockResolvedValue({ kind: "none" })
    admitLaunch.mockReset().mockResolvedValue(undefined)
    processObjective.mockReset().mockResolvedValue("queued")
  })

  it("enqueues only the exact approved private source binding", async () => {
    const fake = makeTransaction()
    await enqueueReviewedFillHandoffInTransaction(fake.client as unknown as Prisma.TransactionClient, {
      ...intentInput, sourceTurnId: sourceId, now: NOW,
    })
    expect(fake.outboxCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      topic: "agent.reviewed-fill.dispatch", aggregateId: "session_1",
      idempotencyKey: "agent-reviewed-fill:approval_1",
      payload: expect.objectContaining({ approvalId: "approval_1", predecessorTurnId: "turn_1" }),
    }) })
  })

  it.each([
    ["scheduled receipt", { scheduled: true }],
    ["expired receipt", { expiresAt: new Date(NOW.getTime() - 1) }],
    ["ambiguous source event", { eventCount: 2 }],
  ] as const)("does not enqueue for %s", async (_name, options) => {
    const fake = makeTransaction(options)
    await expect(enqueueReviewedFillHandoffInTransaction(fake.client as unknown as Prisma.TransactionClient, {
      ...intentInput, sourceTurnId: sourceId, now: NOW,
    })).rejects.toThrow()
    expect(fake.outboxCreate).not.toHaveBeenCalled()
  })

  it("processes a real Prisma-shaped unpublished row into a queued fill", async () => {
    const row = makeOutboxRow()
    const db = { agentOutbox: { findUnique: vi.fn(async () => row) } }
    startFill.mockResolvedValue({ disposition: "started" })
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, row.id)).resolves.toBe("queued")
    expect(startFill).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", sessionId: "session_1", applicationTaskId: "task_1",
      reviewedSourceApprovalId: "approval_1", reviewedSourcePredecessorTurnId: "turn_1",
      clientMessageId: "agent-reviewed-fill:approval_1",
    }))
    expect(probeDuplicate).toHaveBeenCalledWith(expect.anything(), row.payload, row.idempotencyKey)
    expect(admitLaunch).toHaveBeenCalledWith(row.payload)
  })

  it("acknowledges only the exact read-only duplicate before current launch gates", async () => {
    const row = makeOutboxRow()
    const db = { agentOutbox: { findUnique: vi.fn(async () => row) } }
    probeDuplicate.mockResolvedValueOnce({ kind: "duplicate", result: { disposition: "duplicate" } })
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, row.id)).resolves.toBe("duplicate")
    expect(admitLaunch).not.toHaveBeenCalled()
    expect(startFill).not.toHaveBeenCalled()
  })

  it("acknowledges an exact published row and terminalizes known proof rejection", async () => {
    const row = makeOutboxRow(new Date())
    const db = { agentOutbox: { findUnique: vi.fn(async () => row) } }
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, row.id)).resolves.toBe("duplicate")
    expect(startFill).not.toHaveBeenCalled()
    const pending = { ...row, publishedAt: null }
    db.agentOutbox.findUnique.mockResolvedValue(pending)
    startFill.mockResolvedValueOnce({ disposition: "duplicate" })
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, row.id)).resolves.toBe("duplicate")
    startFill.mockRejectedValueOnce(new AgentCommandError("retry_target_invalid", "rejected", 409))
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, row.id)).resolves.toBe("terminal")
    startFill.mockRejectedValueOnce(new AgentCommandError("retry_active_conflict", "active", 409))
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, row.id)).resolves.toBe("deferred")
    startFill.mockRejectedValueOnce(new AutoApplyError("launch gate denied"))
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, row.id)).resolves.toBe("terminal")
  })

  it("rejects an unknown row and leaves unexpected failures retryable", async () => {
    const missing = { agentOutbox: { findUnique: vi.fn(async () => null) } }
    await expect(processReviewedFillHandoffOutbox(missing as unknown as PrismaClient, "outbox_1"))
      .rejects.toBeInstanceOf(ReviewedFillHandoffOutboxNotFoundError)
    const db = { agentOutbox: { findUnique: vi.fn(async () => makeOutboxRow()) } }
    startFill.mockRejectedValueOnce(new Error("transient database failure"))
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, "outbox_1"))
      .rejects.toThrow("transient database failure")
  })

  it("routes only the registered Objective topic to the Objective processor", async () => {
    const row = makeObjectiveOutboxRow()
    const db = { agentOutbox: { findUnique: vi.fn(async () => row) } }
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, row.id)).resolves.toBe("queued")
    expect(processObjective).toHaveBeenCalledWith(db, expect.objectContaining({
      id: row.id, topic: row.topic, aggregateId: row.aggregateId, idempotencyKey: row.idempotencyKey, payload: row.payload,
    }))
    expect(startFill).not.toHaveBeenCalled()
    const published = makeObjectiveOutboxRow(new Date())
    db.agentOutbox.findUnique.mockResolvedValue(published)
    await expect(processReviewedFillHandoffOutbox(db as unknown as PrismaClient, published.id)).resolves.toBe("duplicate")
    expect(processObjective).toHaveBeenCalledOnce()
  })
})
