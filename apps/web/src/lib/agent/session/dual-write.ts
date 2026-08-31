import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"
import { redactAgentEvent, redactSensitiveValue } from "@jobcopilot/shared"

import { appendAgentEventWithOutboxInTransaction } from "./fact-store"
import { mapLegacyTranscriptToV2 } from "./legacy-v2-mapping"
import { insertProjectedTranscript } from "./transcript-projector"
import type { AgentSessionStatus } from "./types"
import type { AppendTranscriptEventInput } from "./repository"
import { ensureV2Turn, type EnsureV2TurnInput, type V2TurnHandle } from "./v2-turn"

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
  finalize(input: DualWriteFinalizeInput): Promise<void>
}

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
  }
}

/**
 * Creates the V2 handle for an existing legacy Session. The handle is
 * request-scoped, so no mutable global state can cross user sessions.
 */
export async function createDualWriteSession(
  db: PrismaClient,
  input: EnsureV2TurnInput,
): Promise<DualWriteSession> {
  const turn = await ensureV2Turn(db, turnInput(input))

  return {
    ...turn,
    async record(legacy, raw) {
      return db.$transaction(async (tx) => {
        const session = await tx.agentSession.findFirst({
          where: { id: turn.sessionId, userId: turn.userId },
          select: { id: true },
        })
        const currentTurn = await tx.agentTurn.findFirst({
          where: { id: turn.turnId, sessionId: turn.sessionId, userId: turn.userId },
          select: { id: true },
        })
        if (!session || !currentTurn) throw new Error("Cannot dual-write an unauthorized agent turn")

        const mapping = mapLegacyTranscriptToV2(legacy, raw?.name)
        const safeLegacy = redactAgentEvent(legacy)
        const safeSourcePayload = redactSensitiveValue(raw?.payload ?? legacy.data ?? null)
        const eventIdempotencyKey = `legacy-transcript:${turn.turnId}:${randomUUID()}`
        const itemId = randomUUID()
        const timestamp = new Date()
        const content = {
          legacyType: legacy.type,
          speaker: legacy.speaker,
          title: legacy.title ?? null,
          body: safeLegacy.body,
          durationMs: legacy.durationMs ?? null,
          data: safeLegacy.data,
          sourceEvent: raw?.name ?? legacy.type,
          sourcePayload: safeSourcePayload,
          opaque: mapping.opaque,
        }
        await tx.agentItem.create({
          data: {
            id: itemId,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            taskId: legacy.taskId ?? null,
            type: mapping.itemType,
            status: mapping.itemStatus,
            phase: mapping.phase,
            revision: 0,
            content: json(content),
            startedAt: mapping.itemStatus === "started" ? timestamp : null,
            completedAt: mapping.itemStatus === "completed" || mapping.itemStatus === "failed" ? timestamp : null,
          },
        })

        const { event } = await appendAgentEventWithOutboxInTransaction(tx, {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          itemId,
          taskId: legacy.taskId ?? null,
          type: mapping.eventType,
          actor: mapping.actor,
          correlationId: turn.turnId,
          causationId: null,
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
            sourceEvent: raw?.name ?? legacy.type,
            sourcePayload: safeSourcePayload,
            opaque: mapping.opaque,
          }),
          outboxTopic: "agent.session.event",
        })
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
        const projected = await insertProjectedTranscript(tx, event)
        return restoreLegacyResponse(projected, safeLegacy.data)
      })
    },
    async finalize(finalizeInput) {
      await db.$transaction(async (tx) => {
        const ownedTurn = await tx.agentTurn.findFirst({
          where: { id: turn.turnId, sessionId: turn.sessionId, userId: turn.userId },
          select: { id: true },
        })
        if (!ownedTurn) throw new Error("Cannot finalize an unauthorized agent turn")
        await tx.agentTurn.update({
          where: { id: turn.turnId },
          data: {
            status: v2Status(finalizeInput.status),
            completedAt: finalizeInput.status === "waiting_for_user" ? null : new Date(),
            finalResponse: finalizeInput.finalResponse ?? null,
            error: finalizeInput.error ?? null,
          },
        })
      })
    },
  }
}
