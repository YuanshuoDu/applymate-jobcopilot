import { afterEach, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"
import {
  OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA,
  OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT,
  OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION,
} from "@jobcopilot/agent-protocol"

import * as transaction from "./transaction"
import { ObjectiveApplicationReviewCommandService } from "./objective-application-review"

const selection = {
  schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA,
  sourceTurnId: "source-turn-1", rootTaskId: "source-root-1", graphItemId: "graph-item-1", graphRevision: 7, slotOrdinals: [1],
}
const command = { userId: "user-1", sessionId: "session-1", clientMessageId: "objective-review-1", selection }
const graphContent = {
  schemaVersion: "agent-harness.v2.task-graph",
  nodes: [
    { key: "scout-1", templateId: "scout", verificationDisposition: "typed", dependsOn: [] },
    { key: "analyst-1", templateId: "analyst", verificationDisposition: "typed", dependsOn: ["scout-1"] },
    { key: "writer-1", templateId: "cover_letter_writer", dependsOn: ["analyst-1"] },
    { key: "reviewer-1", templateId: "cover_letter_reviewer", dependsOn: ["writer-1"] },
  ],
  objectiveTailor: {
    schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: 2,
    slots: [{ slotId: "tailor-1", sourceAnalystNodeKey: "analyst-1", writerNodeKey: "writer-1", reviewerNodeKey: "reviewer-1" }],
  },
}
const source = {
  id: selection.sourceTurnId, rootTaskId: selection.rootTaskId, turnStatus: "completed", turnSource: "user",
  executionMode: "canonical_task_graph", rootStatus: "completed", rootRole: "orchestrator", rootTaskType: "root", rootDepth: 0,
}

function makeDb(options: { existing?: unknown; savedInput?: unknown; sourceRows?: unknown[]; graphRows?: unknown[]; revision?: number } = {}) {
  const raw = vi.fn()
    .mockResolvedValueOnce([{ id: command.sessionId }])
    .mockResolvedValueOnce(options.sourceRows ?? [source])
    .mockResolvedValueOnce(options.graphRows ?? [{ id: selection.graphItemId, revision: options.revision ?? selection.graphRevision, content: graphContent }])
  const agentTurnFindFirst = vi.fn(async (args: { where?: { id?: string } }) => {
    if (args.where?.id) return options.savedInput ? { input: options.savedInput, executionMode: "canonical_task_graph" } : null
    return null
  })
  const tx = {
    $queryRaw: raw,
    agentInput: { findFirst: vi.fn().mockResolvedValue(options.existing ?? null) },
    agentTurn: { findFirst: agentTurnFindFirst, create: vi.fn().mockResolvedValue({ id: "review-turn-1" }) },
    agentOutbox: { create: vi.fn().mockResolvedValue({ id: "outbox-1" }) },
    agentEvent: { findFirst: vi.fn().mockResolvedValue({ sequence: BigInt(19), payload: { disposition: "started" } }) },
  }
  const db = { $transaction: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(tx)) }
  return { db: db as unknown as PrismaClient, tx }
}

afterEach(() => vi.restoreAllMocks())

describe("ObjectiveApplicationReviewCommandService", () => {
  it("starts a distinct canonical Turn from only the exact source selector and dispatches atomically", async () => {
    const { db, tx } = makeDb()
    vi.spyOn(transaction, "acceptInputFacts").mockResolvedValue({ inputId: "input-1", turnId: "review-turn-1", sequence: "19" })
    await expect(new ObjectiveApplicationReviewCommandService(db).start(command)).resolves.toMatchObject({
      turnId: "review-turn-1", disposition: "started",
    })
    const data = tx.agentTurn.create.mock.calls[0]?.[0]?.data
    expect(data).toMatchObject({ source: "user", executionMode: "canonical_task_graph", input: {
      clientMessageId: command.clientMessageId,
      intent: { ...OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT, selection },
    } })
    expect(data?.input).not.toHaveProperty("selectedJobPreparation")
    expect(data?.input).not.toHaveProperty("jobId")
    expect(tx.agentOutbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      topic: "agent.turn.dispatch", aggregateId: command.sessionId, idempotencyKey: "turn-dispatch:review-turn-1",
    }) }))
    const sourceSql = (tx.$queryRaw.mock.calls[1]?.[0] as { sql?: string } | undefined)?.sql ?? ""
    for (const predicate of ['source."userId" =', 'source."sessionId" =', 'source."source" = \'user\'',
      'source."executionMode" = \'canonical_task_graph\'', 'source."status" = \'completed\'', 'root."status" = \'completed\'']) {
      expect(sourceSql).toContain(predicate)
    }
  })

  it("replays the exact persisted command before refreshing a now-stale source", async () => {
    const existing = { id: "input-1", targetTurnId: "review-turn-1", delivery: "follow_up", acceptedSequence: BigInt(19) }
    const savedInput = { clientMessageId: command.clientMessageId, goal: "old", content: [],
      intent: { ...OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT, selection } }
    const { db, tx } = makeDb({ existing, savedInput })
    await expect(new ObjectiveApplicationReviewCommandService(db).start(command)).resolves.toMatchObject({
      turnId: "review-turn-1", disposition: "duplicate",
    })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
  })

  it("rejects a same-key different slot selection before source refresh", async () => {
    const existing = { id: "input-1", targetTurnId: "review-turn-1", delivery: "follow_up", acceptedSequence: BigInt(19) }
    const savedInput = { clientMessageId: command.clientMessageId, goal: "old", content: [], intent: {
      ...OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT, selection: { ...selection, slotOrdinals: [2] },
    } }
    const { db, tx } = makeDb({ existing, savedInput })
    await expect(new ObjectiveApplicationReviewCommandService(db).start(command)).rejects.toMatchObject({ code: "invalid_command" })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
  })

  it.each([
    ["stale graph revision", { revision: 8 }, selection],
    ["slot without an exact marker", {}, { ...selection, slotOrdinals: [2] }],
  ])("rejects %s without creating a review Turn", async (_label, options, selected) => {
    const { db, tx } = makeDb(options)
    vi.spyOn(transaction, "acceptInputFacts")
    await expect(new ObjectiveApplicationReviewCommandService(db).start({ ...command, selection: selected })).rejects.toMatchObject({ code: "invalid_command" })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects client Job/material claims and malformed selection intents", async () => {
    const { db, tx } = makeDb()
    await expect(new ObjectiveApplicationReviewCommandService(db).start({ ...command, jobId: "client-job" })).rejects.toMatchObject({ code: "invalid_command" })
    await expect(new ObjectiveApplicationReviewCommandService(db).start({ ...command, selection: { ...selection, artifactId: "client-artifact" } })).rejects.toMatchObject({ code: "invalid_command" })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
  })
})
