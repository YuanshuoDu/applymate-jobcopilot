import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"
import { redactAgentEvent, redactSensitiveValue } from "@jobcopilot/shared"

import { appendAgentEventWithOutboxInTransaction } from "./fact-store"
import {
  parseCanonicalQuestionPayload,
  prepareCanonicalQuestionInTransaction,
} from "./canonical-question-dual-write"
import { mapLegacyTranscriptToV2 } from "./legacy-v2-mapping"
import { insertProjectedTranscript } from "./transcript-projector"
import type { AgentSessionStatus } from "./types"
import type { AppendTranscriptEventInput } from "./repository"
import { ensureV2Turn, lockOpenSession, type EnsureV2TurnInput, type V2TurnHandle } from "./v2-turn"
import { AgentExecutionCancelledError } from "../execution-control"

export interface RawPipelineEvent {
  name: string
  payload: unknown
}

export interface DualWriteFinalizeInput {
  status: Extract<AgentSessionStatus, "completed" | "failed" | "aborted" | "waiting_for_user">
  finalResponse?: string | null
  error?: string | null
}

export interface DualWriteSession extends V2TurnHandle {
  record(input: AppendTranscriptEventInput, raw?: RawPipelineEvent): Promise<unknown>
  finalize(input: DualWriteFinalizeInput): Promise<boolean>
}

const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const
const TERMINAL_DRAIN_STATUSES = ["completed", "failed", "waiting_for_user"] as const
type DualWriteOwnership = { executionAttempt: { id: string; attemptCount: number }; signal?: AbortSignal }

function json(value: unknown): Prisma.InputJsonValue {
  return (value ?? null) as Prisma.InputJsonValue
}

function restoreLegacyResponse(value: unknown, data: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  return { ...(value as Record<string, unknown>), data: data ?? null }
}

function v2Status(status: DualWriteFinalizeInput["status"]): "completed" | "failed" | "interrupted" | "waiting_for_user" {
  return status === "aborted" ? "interrupted" : status
}

function turnInput(input: EnsureV2TurnInput) {
  return {
    sessionId: input.sessionId,
    userId: input.userId,
    goal: input.goal,
    source: input.source,
    turnId: input.turnId,
    legacyResumeQuestionId: input.legacyResumeQuestionId,
  }
}

/**
 * Creates the V2 handle for an existing legacy Session. The handle is
 * request-scoped, so no mutable global state can cross user sessions.
 */
export async function createDualWriteSession(
  db: PrismaClient,
  input: EnsureV2TurnInput,
  ownership?: DualWriteOwnership,
  precreatedTurn?: V2TurnHandle,
): Promise<DualWriteSession> {
  const turn = precreatedTurn ?? await ensureV2Turn(db, turnInput(input), ownership)
  const hasExplicitTurn = typeof input.turnId === "string" && input.turnId.length > 0

  return {
    ...turn,
    async record(legacy, raw) {
      return db.$transaction(async (tx) => {
        await lockOpenSession(tx, turn)
        const lockedTurn = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
          SELECT "id", "status" FROM "agent_turns"
          WHERE "id" = ${turn.turnId} AND "sessionId" = ${turn.sessionId} AND "userId" = ${turn.userId}
          FOR UPDATE
        `)
        if (!lockedTurn[0] || !ACTIVE_TURN_STATUSES.includes(lockedTurn[0].status as (typeof ACTIVE_TURN_STATUSES)[number])) {
          throw new AgentExecutionCancelledError()
        }
        if (ownership) {
          const allowedStatuses = ownership.signal?.aborted
            ? [...TERMINAL_DRAIN_STATUSES]
            : ["running", ...TERMINAL_DRAIN_STATUSES]
          const claimed = await tx.agentExecution.updateMany({
            where: {
              id: ownership.executionAttempt.id,
              userId: turn.userId,
              sessionId: turn.sessionId,
              attemptCount: ownership.executionAttempt.attemptCount,
              status: { in: allowedStatuses },
            },
            data: { updatedAt: new Date() },
          })
          if (claimed.count !== 1) throw new AgentExecutionCancelledError()
          const current = await tx.agentExecution.findFirst({
            where: { id: ownership.executionAttempt.id, userId: turn.userId, sessionId: turn.sessionId, attemptCount: ownership.executionAttempt.attemptCount },
            select: { status: true },
          })
          if (!current || (ownership.signal?.aborted && current.status === "running")) throw new AgentExecutionCancelledError()
        }
        const currentTurn = await tx.agentTurn.findFirst({
          where: { id: turn.turnId, sessionId: turn.sessionId, userId: turn.userId },
          select: { id: true, sessionId: true, userId: true, status: true, revision: true },
        })
        if (!currentTurn) throw new Error("Cannot dual-write an unauthorized agent turn")

        const mapping = mapLegacyTranscriptToV2(legacy, raw?.name)
        const safeLegacy = redactAgentEvent(legacy)
        const safeSourcePayload = redactSensitiveValue(raw?.payload ?? legacy.data ?? null)
        const question = hasExplicitTurn && raw?.name === "orchestrator_question"
          ? parseCanonicalQuestionPayload(raw.payload)
          : null
        const canonical = question && currentTurn
          ? await prepareCanonicalQuestionInTransaction({
            tx,
            session: { id: turn.sessionId, userId: turn.userId },
            turn: currentTurn,
            question,
            sourcePayload: safeSourcePayload,
            legacy,
            safeLegacy,
          })
          : null
        const questionMapping = canonical
          ? { eventType: "item.started", actor: "orchestrator" as const, itemType: "question", itemStatus: "started" as const, phase: "commentary" as const, opaque: false }
          : null
        const eventMapping = questionMapping ?? mapping
        const sourceEvent = canonical ? "orchestrator_question" : raw?.name ?? legacy.type
        const eventIdempotencyKey = canonical
          ? `agent-wait:${canonical.itemId}:started`
          : `legacy-transcript:${turn.turnId}:${randomUUID()}`
        const itemId = canonical?.itemId ?? randomUUID()
        const timestamp = new Date()
        const content = {
          legacyType: legacy.type,
          speaker: legacy.speaker,
          title: legacy.title ?? null,
          body: safeLegacy.body,
          durationMs: legacy.durationMs ?? null,
          data: safeLegacy.data,
          sourceEvent,
          sourcePayload: safeSourcePayload,
          opaque: eventMapping.opaque,
        }
        if (!canonical) {
          await tx.agentItem.create({
            data: {
              id: itemId,
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              taskId: legacy.taskId ?? null,
              type: eventMapping.itemType,
              status: eventMapping.itemStatus,
              phase: eventMapping.phase,
              revision: 0,
              content: json(content),
              startedAt: eventMapping.itemStatus === "started" ? timestamp : null,
              completedAt: eventMapping.itemStatus === "completed" || eventMapping.itemStatus === "failed" ? timestamp : null,
            },
          })
        }

        const { event, duplicate } = await appendAgentEventWithOutboxInTransaction(tx, {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          itemId,
          taskId: legacy.taskId ?? null,
          type: eventMapping.eventType,
          actor: eventMapping.actor,
          correlationId: canonical ? itemId : turn.turnId,
          causationId: canonical ? question?.id ?? null : null,
          idempotencyKey: eventIdempotencyKey,
          payload: json({
            legacy: {
              type: legacy.type,
              speaker: legacy.speaker,
              title: legacy.title ?? null,
              body: safeLegacy.body,
              durationMs: legacy.durationMs ?? null,
              data: safeLegacy.data,
            },
            sourceEvent,
            sourcePayload: safeSourcePayload,
            opaque: eventMapping.opaque,
          }),
          outboxTopic: "agent.session.event",
        })
        const eventTurnId = event.turnId
        if (eventTurnId === null) throw new Error("Cannot project a session-scoped event into a Turn transcript")
        if (legacy.type === "user_message") {
          await tx.agentInput.create({
            data: {
              id: randomUUID(),
              sessionId: turn.sessionId,
              targetTurnId: turn.turnId,
              userId: turn.userId,
              clientMessageId: `legacy-transcript:${event.id}`,
              delivery: "follow_up",
              status: "accepted",
              content: json({ text: legacy.body }),
              acceptedSequence: event.sequence,
            },
          })
        }
        const projected = duplicate ? restoreLegacyResponse(legacy, safeLegacy.data) : await insertProjectedTranscript(tx, { ...event, turnId: eventTurnId })
        return restoreLegacyResponse(projected, safeLegacy.data)
      })
    },
    async finalize(finalizeInput) {
      return db.$transaction(async (tx) => {
        await lockOpenSession(tx, turn)
        const terminalized = await tx.agentTurn.updateMany({
          where: {
            id: turn.turnId,
            sessionId: turn.sessionId,
            userId: turn.userId,
            status: { in: [...ACTIVE_TURN_STATUSES] },
          },
          data: {
            status: v2Status(finalizeInput.status),
            completedAt: finalizeInput.status === "waiting_for_user" ? null : new Date(),
            finalResponse: finalizeInput.finalResponse ?? null,
            error: finalizeInput.error ?? null,
          },
        })
        return terminalized.count === 1
      })
    },
  }
}
