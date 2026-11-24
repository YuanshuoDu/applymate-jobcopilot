import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

import {
  acceptedFillTurnMatchesReviewedSource, persistReviewedFillSourceInTransaction,
  persistReviewedSourceOnFillTurn, readAcceptedReviewedFillSource, ReviewedFillSourceBindingError,
  REVIEWED_FILL_SOURCE_EVENT, REVIEWED_FILL_SOURCE_SCHEMA,
} from "./reviewed-fill-source-binding"

function harness(eventRows: unknown[] = []) {
  const sourceTurn = {
    id: "source_turn_1", userId: "user_1", sessionId: "session_1", status: "completed", source: "user",
    rootTaskId: "root_1", input: { selectedJobPreparation: { jobId: "job_1" } },
  }
  const fillTurn = {
    id: "fill_turn_1", userId: "user_1", sessionId: "session_1", status: "queued", source: "user",
    input: { clientMessageId: "fill_1", goal: "Fill, then stop for review." },
  }
  const approval = { id: "approval_1", userId: "user_1", sessionId: "session_1", status: "approved",
    type: "review_application", taskId: "application_1", jobId: "job_1",
    payload: { applicationTaskId: "application_1", jobId: "job_1" } }
  const task = { id: "application_1", userId: "user_1", sessionId: "session_1", jobId: "job_1",
    status: "waiting_for_user", checkpoint: "materials_ready" }
  let events = [...eventRows]
  const client = {
    agentApproval: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.id !== approval.id || where.userId !== approval.userId || where.sessionId !== approval.sessionId
        || (where.type && where.type !== approval.type)) return null
      return approval
    }) },
    applicationTask: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.id !== task.id || where.userId !== task.userId || where.sessionId !== task.sessionId
        || (where.jobId && where.jobId !== task.jobId) || (where.status && where.status !== task.status)
        || (where.checkpoint && where.checkpoint !== task.checkpoint)) return null
      return task
    }) },
    applicationTaskEvent: {
      findMany: vi.fn(async () => events.slice(0, 2)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data }),
    },
    agentTurn: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id === sourceTurn.id && where.userId === sourceTurn.userId && where.sessionId === sourceTurn.sessionId) return sourceTurn
        if (where.id === fillTurn.id && where.userId === fillTurn.userId && where.sessionId === fillTurn.sessionId) return fillTurn
        return null
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.id !== fillTurn.id || where.status !== fillTurn.status || where.source !== fillTurn.source) return { count: 0 }
        Object.assign(fillTurn, data)
        return { count: 1 }
      }),
    },
  } as unknown as PrismaClient
  return { client, get events() { return events }, sourceTurn, fillTurn }
}

const scope = { approvalId: "approval_1", userId: "user_1", sessionId: "session_1", applicationTaskId: "application_1", jobId: "job_1" }
const bindingEvent = () => ({ id: "event_1", data: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, approvalId: "approval_1", sourceTurnId: "source_turn_1" } })

describe("reviewed application fill source binding", () => {
  it("atomically records a validated selection as a private application-task event", async () => {
    const fake = harness()
    await persistReviewedFillSourceInTransaction(fake.client, { ...scope, decision: "approved", sourceTurnId: "source_turn_1" })
    expect(fake.events).toEqual([expect.objectContaining({
      taskId: "application_1", type: REVIEWED_FILL_SOURCE_EVENT, actor: "user",
      data: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, approvalId: "approval_1", sourceTurnId: "source_turn_1" },
    })])
  })

  it("fails closed on wrong decision, source owner, or source job", async () => {
    const rejected = harness()
    await expect(persistReviewedFillSourceInTransaction(rejected.client, { ...scope, decision: "rejected", sourceTurnId: "source_turn_1" }))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
    const wrongJob = harness()
    wrongJob.sourceTurn.input = { selectedJobPreparation: { jobId: "job_other" } }
    await expect(persistReviewedFillSourceInTransaction(wrongJob.client, { ...scope, decision: "approved", sourceTurnId: "source_turn_1" }))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
    expect(wrongJob.events).toHaveLength(0)
    const wrongOwner = harness()
    wrongOwner.sourceTurn.userId = "other_user"
    await expect(persistReviewedFillSourceInTransaction(wrongOwner.client, { ...scope, decision: "approved", sourceTurnId: "source_turn_1" }))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
    expect(wrongOwner.events).toHaveLength(0)
  })

  it("recovers only one exact accepted binding when a replay omits its selector", async () => {
    const fake = harness([bindingEvent()])
    await expect(readAcceptedReviewedFillSource(fake.client, scope)).resolves.toEqual({ sourceTurnId: "source_turn_1" })
    await expect(readAcceptedReviewedFillSource(fake.client, { ...scope, requestedSourceTurnId: "source_turn_1" }))
      .resolves.toEqual({ sourceTurnId: "source_turn_1" })
    await expect(readAcceptedReviewedFillSource(fake.client, { ...scope, requestedSourceTurnId: "source_turn_other" }))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
  })

  it("keeps legacy replays without a binding unchanged and rejects missing, duplicate, or corrupt proof", async () => {
    await expect(readAcceptedReviewedFillSource(harness().client, scope)).resolves.toBeUndefined()
    await expect(readAcceptedReviewedFillSource(harness().client, { ...scope, requestedSourceTurnId: "source_turn_1" }))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
    await expect(readAcceptedReviewedFillSource(harness([bindingEvent(), bindingEvent()]).client, scope))
      .rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
    const corrupt = harness([{ id: "event_1", data: { ...bindingEvent().data, extra: true } }])
    await expect(readAcceptedReviewedFillSource(corrupt.client, scope)).rejects.toBeInstanceOf(ReviewedFillSourceBindingError)
  })

  it("writes the exact source marker into a queued fill Turn without replacing other input", async () => {
    const fake = harness()
    await persistReviewedSourceOnFillTurn(fake.client, {
      turnId: "fill_turn_1", userId: "user_1", sessionId: "session_1", clientMessageId: "fill_1", sourceTurnId: "source_turn_1",
    })
    expect(fake.fillTurn.input).toMatchObject({
      clientMessageId: "fill_1", goal: "Fill, then stop for review.",
      reviewedApplicationMaterialSource: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, sourceTurnId: "source_turn_1" },
    })
    await expect(acceptedFillTurnMatchesReviewedSource(fake.client, {
      turnId: "fill_turn_1", userId: "user_1", sessionId: "session_1", sourceTurnId: "source_turn_1",
    })).resolves.toBe(true)
  })
})
