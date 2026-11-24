import { afterEach, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, REVIEWED_APPLICATION_REVIEW_INTENT } from "@jobcopilot/agent-protocol"

import * as transaction from "./transaction"
import { ReviewedApplicationReviewCommandService, type ReviewedApplicationReviewCommand } from "./reviewed-application-review"

const command: ReviewedApplicationReviewCommand = {
  userId: "user_1", sessionId: "session_1", clientMessageId: "review_1", sourceTurnId: "source_turn_1",
}

function sourceInput(jobId = "job_1") {
  return { goal: "Prepare a cover letter", clientMessageId: "source_message", selectedJobPreparation: { jobId } }
}

function makeDb(options: {
  existing?: { id: string; targetTurnId: string | null; delivery: string; acceptedSequence: bigint } | null
  existingTurnInput?: unknown
  sourceRows?: readonly { input: unknown; rootTaskId: unknown }[]
  job?: { id: string } | null
  active?: { id: string; source: string; status: string; revision: number } | null
} = {}) {
  const raw = vi.fn()
    .mockResolvedValueOnce([{ id: command.sessionId }])
    .mockResolvedValueOnce(options.sourceRows ?? [{ input: sourceInput(), rootTaskId: "source_root_1" }])
  const agentTurnFindFirst = vi.fn(async (args: { where?: { id?: string } }) => {
    if (args.where?.id) return options.existingTurnInput ? { input: options.existingTurnInput } : null
    return options.active ?? null
  })
  const tx = {
    $queryRaw: raw,
    agentInput: { findFirst: vi.fn().mockResolvedValue(options.existing ?? null) },
    agentTurn: {
      findFirst: agentTurnFindFirst,
      create: vi.fn().mockResolvedValue({ id: "review_turn_1" }),
    },
    agentOutbox: { create: vi.fn().mockResolvedValue({ id: "outbox_1" }) },
    agentEvent: { findFirst: vi.fn().mockResolvedValue({ sequence: BigInt(17), payload: { disposition: "started" } }) },
    job: { findFirst: vi.fn().mockResolvedValue(Object.hasOwn(options, "job") ? options.job : { id: "job_1" }) },
  }
  const db = { $transaction: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(tx)) }
  return { db: db as unknown as PrismaClient, tx }
}

afterEach(() => vi.restoreAllMocks())

describe("ReviewedApplicationReviewCommandService", () => {
  it("creates a canonical user Root with only the server-derived Job and exact source selector", async () => {
    const { db, tx } = makeDb()
    const acceptInputFacts = vi.spyOn(transaction, "acceptInputFacts").mockResolvedValue({
      inputId: "input_1", turnId: "review_turn_1", sequence: "17",
    })
    const service = new ReviewedApplicationReviewCommandService(db)

    await expect(service.start(command)).resolves.toEqual({
      inputId: "input_1", turnId: "review_turn_1", sequence: "17", disposition: "started",
    })

    expect(tx.job.findFirst).toHaveBeenCalledWith({
      where: { id: "job_1", userId: command.userId, status: "saved", workflowState: { in: ["draft", "ready_to_apply"] }, appliedAt: null },
      select: { id: true },
    })
    expect(tx.agentTurn.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      source: "user", executionMode: "canonical_task_graph",
      input: expect.objectContaining({
        clientMessageId: command.clientMessageId,
        intent: { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: command.sourceTurnId, jobId: "job_1" },
      }),
    }) }))
    expect(tx.agentTurn.create.mock.calls[0]?.[0]?.data.input).not.toHaveProperty("selectedJobPreparation")
    expect(tx.agentOutbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      topic: "agent.turn.dispatch", aggregateId: command.sessionId, idempotencyKey: "turn-dispatch:review_turn_1",
    }) }))
    expect(acceptInputFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: "user" }),
      expect.any(Array), expect.objectContaining({ id: "review_turn_1" }), "follow_up", "started", true)
    expect(Object.hasOwn(tx.job, "update")).toBe(false)
    const sessionLockSql = (tx.$queryRaw.mock.calls[0]?.[0] as { sql?: string } | undefined)?.sql ?? ""
    const sourceSql = (tx.$queryRaw.mock.calls[1]?.[0] as { sql?: string } | undefined)?.sql ?? ""
    expect(sessionLockSql).toContain('"userId" =')
    for (const requiredPredicate of [
      'source."userId" =', 'source."sessionId" =', 'source."source" = \'user\'',
      'source."executionMode" = \'canonical_task_graph\'', 'source."status" = \'completed\'',
      'root."status" = \'completed\'', 'root."parentTaskId" IS NULL',
    ]) expect(sourceSql).toContain(requiredPredicate)
  })

  it("replays only the exact same command identity and source Turn", async () => {
    const existing = { id: "input_1", targetTurnId: "review_turn_1", delivery: "follow_up", acceptedSequence: BigInt(17) }
    const existingTurnInput = {
      clientMessageId: command.clientMessageId,
      intent: { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: command.sourceTurnId, jobId: "job_1" },
    }
    const { db, tx } = makeDb({ existing, existingTurnInput })
    const acceptInputFacts = vi.spyOn(transaction, "acceptInputFacts")
    const service = new ReviewedApplicationReviewCommandService(db)

    await expect(service.start(command)).resolves.toMatchObject({
      inputId: "input_1", turnId: "review_turn_1", disposition: "duplicate", originalDisposition: "started",
    })
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.job.findFirst).not.toHaveBeenCalled()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(acceptInputFacts).not.toHaveBeenCalled()
  })

  it("accepts the exact Objective v1 marker on canonical selected-job source history", async () => {
    const { db, tx } = makeDb({ sourceRows: [{
      input: { ...sourceInput(), intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }, rootTaskId: "source_root_1",
    }] })
    const service = new ReviewedApplicationReviewCommandService(db)
    vi.spyOn(transaction, "acceptInputFacts").mockResolvedValue({ inputId: "input_1", turnId: "review_turn_1", sequence: "17" })

    await expect(service.start(command)).resolves.toMatchObject({ turnId: "review_turn_1", disposition: "started" })
    expect(tx.agentTurn.create).toHaveBeenCalledOnce()
    expect(tx.job.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "job_1" }) }))
  })

  it("rejects reusing a command ID for another selected source", async () => {
    const existing = { id: "input_1", targetTurnId: "review_turn_1", delivery: "follow_up", acceptedSequence: BigInt(17) }
    const existingTurnInput = {
      clientMessageId: command.clientMessageId,
      intent: { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: "source_turn_other", jobId: "job_1" },
    }
    const { db, tx } = makeDb({ existing, existingTurnInput })
    const service = new ReviewedApplicationReviewCommandService(db)

    await expect(service.start(command)).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    expect(tx.agentEvent.findFirst).not.toHaveBeenCalled()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
  })

  it("rejects forged, missing, or non-canonical completed selected-job sources before creating a Root", async () => {
    const invalidSources = [
      [],
      [{ input: { ...sourceInput(), intent: { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, version: 2 } }, rootTaskId: "source_root_1" }],
      [{ input: { ...sourceInput(), intent: { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, sourceTurnId: "different_source" } }, rootTaskId: "source_root_1" }],
      [{ input: { ...sourceInput(), intent: { ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: "different_source", jobId: "job_1" } }, rootTaskId: "source_root_1" }],
      [{ input: { goal: "Prepare" }, rootTaskId: "source_root_1" }],
      [{ input: sourceInput(), rootTaskId: null }],
    ] as const
    for (const sourceRows of invalidSources) {
      const { db, tx } = makeDb({ sourceRows })
      const service = new ReviewedApplicationReviewCommandService(db)
      await expect(service.start({ ...command, clientMessageId: `review_${invalidSources.indexOf(sourceRows)}` }))
        .rejects.toMatchObject({ code: "invalid_command", status: 422 })
      expect(tx.agentTurn.create).not.toHaveBeenCalled()
      expect(tx.job.findFirst).not.toHaveBeenCalled()
    }
  })

  it("rejects non-owned or terminal Jobs without changing them", async () => {
    const { db, tx } = makeDb({ job: null })
    const service = new ReviewedApplicationReviewCommandService(db)

    await expect(service.start(command)).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    expect(tx.job.findFirst).toHaveBeenCalledOnce()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects a concurrent active Turn and malformed or generic message-shaped commands", async () => {
    const active = { id: "active_turn", source: "user", status: "in_progress", revision: 1 }
    const { db } = makeDb({ active })
    const service = new ReviewedApplicationReviewCommandService(db)

    await expect(service.start(command)).rejects.toMatchObject({ code: "retry_active_conflict", status: 409 })
    await expect(service.start({ ...command, jobId: "client_job" } as never)).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start({ ...command, source: "automation" } as never)).rejects.toMatchObject({ code: "invalid_command", status: 422 })
    await expect(service.start({ ...command, sourceTurnId: " " })).rejects.toMatchObject({ code: "invalid_command", status: 422 })
  })
})
