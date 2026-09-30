import { Prisma } from "@prisma/client"

import { waitItemId } from "../broker/item-ids"
import {
  classifyLegacyQuestionBridge,
  type LegacyQuestionBridgeItem,
  type LegacyQuestionBridgeTurn,
} from "../legacy-question-bridge"
import type { AppendTranscriptEventInput } from "./repository"

export interface CanonicalQuestionPayload {
  id: string
  stage: string
  question: string
  options: unknown[]
}

export interface CanonicalQuestionTurn extends LegacyQuestionBridgeTurn {
  revision: number
}

export interface CanonicalQuestionBridgeInput {
  tx: Prisma.TransactionClient
  session: { id: string; userId: string }
  turn: CanonicalQuestionTurn
  question: CanonicalQuestionPayload
  sourcePayload: unknown
  legacy: AppendTranscriptEventInput
  safeLegacy: { body: string; data: unknown }
}

export interface CanonicalQuestionBridgeResult {
  itemId: string
}

const QUESTION_TURN_CREATE_STATUSES = new Set(["queued", "in_progress", "waiting_for_dependency"])

function json(value: unknown): Prisma.InputJsonValue {
  return (value ?? null) as Prisma.InputJsonValue
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function storedQuestionProvenance(item: LegacyQuestionBridgeItem) {
  const content = record(item.content)
  return content ? { sourceEvent: content.sourceEvent, sourcePayload: content.sourcePayload } : null
}

/** The raw event is a proof input; extra keys or incomplete values are rejected. */
export function parseCanonicalQuestionPayload(value: unknown): CanonicalQuestionPayload | null {
  const payload = record(value)
  if (!payload) return null
  const keys = Object.keys(payload)
  if (keys.length !== 4 || keys.some((key) => !["id", "stage", "question", "options"].includes(key))) return null
  if (typeof payload.id !== "string" || payload.id.length === 0) return null
  if (typeof payload.stage !== "string" || payload.stage.length === 0) return null
  if (typeof payload.question !== "string" || payload.question.length === 0) return null
  if (!Array.isArray(payload.options)) return null
  return {
    id: payload.id,
    stage: payload.stage,
    question: payload.question,
    options: payload.options,
  }
}

function itemContent(
  input: CanonicalQuestionBridgeInput,
  sourceEvent: string,
) {
  const legacy = {
    type: input.legacy.type,
    speaker: input.legacy.speaker,
    title: input.legacy.title ?? null,
    body: input.safeLegacy.body,
    durationMs: input.legacy.durationMs ?? null,
    data: input.safeLegacy.data,
  }
  return {
    waitKind: "question",
    questionId: input.question.id,
    toolCallId: null,
    stage: input.question.stage,
    question: input.question.question,
    options: input.question.options,
    answer: null,
    answerAvailable: false,
    sourceEvent,
    sourcePayload: input.sourcePayload,
    legacy,
    sessionId: input.session.id,
    turnId: input.turn.id,
  }
}

export async function prepareCanonicalQuestionInTransaction(
  input: CanonicalQuestionBridgeInput,
): Promise<CanonicalQuestionBridgeResult | null> {
  const itemId = waitItemId("question", input.question.id)
  const existing = await input.tx.agentItem.findFirst({
    where: { id: itemId },
    select: { id: true, sessionId: true, turnId: true, type: true, status: true, content: true },
  }) as LegacyQuestionBridgeItem | null
  const provenance = existing
    ? storedQuestionProvenance(existing)
    : { sourceEvent: "orchestrator_question", sourcePayload: input.sourcePayload }
  const proof = classifyLegacyQuestionBridge({
    question: {
      ...input.question,
      userId: input.session.userId,
      runId: input.session.id,
    },
    userId: input.session.userId,
    session: input.session,
    activeTurns: [input.turn],
    item: existing,
    provenance,
  })

  if (proof.disposition === "legacy_only") return null
  if (proof.disposition === "bridged" && input.turn.status === "waiting_for_user") {
    return { itemId: proof.itemId }
  }
  if (!QUESTION_TURN_CREATE_STATUSES.has(input.turn.status)) return null
  if (proof.disposition === "bridge_pending" && proof.reason !== "canonical_item_missing") return null
  if (proof.disposition === "bridge_pending") {
    await input.tx.agentItem.create({
      data: {
        id: itemId,
        sessionId: input.session.id,
        turnId: input.turn.id,
        taskId: input.legacy.taskId ?? null,
        type: "question",
        status: "started",
        phase: "commentary",
        revision: 0,
        content: json(itemContent(input, "orchestrator_question")),
        startedAt: new Date(),
      },
    })
  }

  const updated = await input.tx.agentTurn.updateMany({
    where: {
      id: input.turn.id,
      sessionId: input.session.id,
      userId: input.session.userId,
      status: input.turn.status,
      revision: input.turn.revision,
    },
    data: { status: "waiting_for_user", revision: { increment: 1 }, completedAt: null },
  })
  if (updated.count !== 1) throw new Error("Cannot publish canonical question wait")
  return { itemId }
}
