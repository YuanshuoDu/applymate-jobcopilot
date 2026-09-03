import { createHash, randomUUID } from "node:crypto"

import { Prisma, type PrismaClient } from "@prisma/client"
import type { InputContentPart } from "@jobcopilot/agent-protocol"

import { createRootTurn, acceptInputFacts, lockOwnedSession, type CommandTransaction } from "./transaction"
import { forkBoundaryActive, forkBoundaryNotFound, forkIdempotencyConflict, invalidCommand, isUniqueViolation, sessionNotFound } from "./errors"
import type { ForkCommand, ForkResult } from "./types"

const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
const SIDE_EFFECT_TYPES = /receipt|lease|reservation|pending/i

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalidCommand(`${field} must be non-empty`)
  return value.trim()
}

function targetId(command: ForkCommand): string {
  const key = `${command.userId}:${command.sessionId}:${command.clientMessageId}`
  return `fork-${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`
}

function editFingerprint(command: ForkCommand): string {
  return canonical(command.editContent ?? null)
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function snapshotContent(value: unknown, sessionId: string, throughSequence: bigint): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const content: Record<string, unknown> = { ...(value as Record<string, unknown>), sessionId, throughSequence: throughSequence.toString(), pendingApprovals: [] }
  const context = content.context
  if (context && typeof context === "object" && !Array.isArray(context)) {
    const seeds = { ...(context as Record<string, unknown>) }
    const observations = seeds.toolObservations
    if (Array.isArray(observations)) seeds.toolObservations = observations.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true
      const status = (item as { status?: unknown }).status
      return status !== "pending" && status !== "in_progress"
    })
    content.context = seeds
  }
  return content
}

async function duplicateResult(tx: CommandTransaction, command: ForkCommand, sessionId: string): Promise<ForkResult> {
  const marker = await tx.agentEvent.findFirst({
    where: { sessionId, idempotencyKey: `fork-command:${command.clientMessageId}` },
    select: { payload: true },
  })
  if (!marker || typeof marker.payload !== "object" || marker.payload === null || Array.isArray(marker.payload)) throw forkIdempotencyConflict()
  const payload = marker.payload as Record<string, unknown>
  if (payload.sourceSessionId !== command.sessionId || payload.lastTurnId !== command.lastTurnId || payload.editFingerprint !== editFingerprint(command)) throw forkIdempotencyConflict()
  const turnId = payload.resultTurnId
  if (typeof turnId !== "string") throw forkIdempotencyConflict()
  return { sessionId, turnId, lastTurnId: command.lastTurnId, disposition: "duplicate" }
}

export class AgentForkService {
  constructor(private readonly db: PrismaClient) {}

  async fork(command: ForkCommand): Promise<ForkResult> {
    required(command.sessionId, "sessionId")
    required(command.userId, "userId")
    required(command.clientMessageId, "clientMessageId")
    const lastTurnId = required(command.lastTurnId, "lastTurnId")
    if (command.editContent && command.editContent.length === 0) throw invalidCommand("editContent must not be empty")
    return this.retryUnique(() => this.forkOnce({ ...command, lastTurnId }))
  }

  private async retryUnique<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error
      return work()
    }
  }

  private forkOnce(command: ForkCommand): Promise<ForkResult> {
    return this.db.$transaction(async (tx) => {
      await lockOwnedSession(tx, command.sessionId, command.userId)
      const id = targetId(command)
      const existing = await tx.agentSession.findFirst({ where: { id, userId: command.userId }, select: { id: true } })
      if (existing) return duplicateResult(tx, command, id)

      const source = await tx.agentSession.findFirst({
        where: { id: command.sessionId, userId: command.userId },
        select: {
          id: true, userId: true, goal: true, source: true, memorySummary: true,
          turns: { orderBy: { createdAt: "asc" } },
          items: { orderBy: { createdAt: "asc" } },
          events: { orderBy: { sequence: "asc" } },
          contextSnapshots: { orderBy: { throughSequence: "desc" }, take: 20 },
        },
      })
      if (!source) throw sessionNotFound(command.sessionId)
      const boundaryIndex = source.turns.findIndex((turn) => turn.id === command.lastTurnId)
      if (boundaryIndex < 0) throw forkBoundaryNotFound(command.lastTurnId)
      const boundary = source.turns[boundaryIndex]
      if (!TERMINAL_STATUSES.has(boundary.status)) throw forkBoundaryActive(command.lastTurnId)

      const selectedTurns = source.turns.slice(0, boundaryIndex + 1)
      const selectedTurnIds = new Set(selectedTurns.map((turn) => turn.id))
      const turnMap = new Map(selectedTurns.map((turn) => [turn.id, randomUUID()]))
      const sourceItems = source.items.filter((item) => selectedTurnIds.has(item.turnId) && !SIDE_EFFECT_TYPES.test(item.type) && !["pending", "in_progress"].includes(item.status))
      const itemMap = new Map(sourceItems.map((item) => [item.id, randomUUID()]))
      const sourceEvents = source.events.filter((event) => selectedTurnIds.has(event.turnId) && !SIDE_EFFECT_TYPES.test(event.type) && (!event.itemId || itemMap.has(event.itemId)))
      const eventMap = new Map(sourceEvents.map((event) => [event.id, randomUUID()]))
      const copiedEvents = sourceEvents.map((event, index) => ({
        id: eventMap.get(event.id) as string, sessionId: id, turnId: turnMap.get(event.turnId) as string,
        itemId: event.itemId && itemMap.has(event.itemId) ? itemMap.get(event.itemId) ?? null : null,
        taskId: null, sequence: BigInt(index + 1), type: event.type, actor: event.actor,
        correlationId: turnMap.get(event.correlationId) ?? event.correlationId,
        causationId: event.causationId ? eventMap.get(event.causationId) ?? null : null,
        idempotencyKey: `fork-history:${id}:${event.id}`, payload: json(event.payload), createdAt: event.createdAt,
      }))
      const copiedSnapshot = source.contextSnapshots.find((snapshot) => snapshot.throughSequence <= (sourceEvents[sourceEvents.length - 1]?.sequence ?? BigInt(0)))
      const transformedContent = copiedSnapshot ? snapshotContent(copiedSnapshot.content, id, BigInt(copiedEvents.length)) : null
      const snapshotId = transformedContent ? randomUUID() : null

      await tx.agentSession.create({ data: {
        id, userId: command.userId, goal: source.goal, source: source.source, status: "running",
        memorySummary: source.memorySummary, eventSequence: BigInt(copiedEvents.length), currentTaskId: null, completedAt: null,
      } })
      if (transformedContent && snapshotId) {
        const restored = { schemaVersion: copiedSnapshot?.schemaVersion ?? "agent-harness.context.v1", sessionId: id, throughSequence: BigInt(copiedEvents.length), version: 1, content: transformedContent }
        await tx.agentContextSnapshot.create({ data: {
          id: snapshotId, sessionId: id, throughSequence: BigInt(copiedEvents.length), version: 1,
          schemaVersion: restored.schemaVersion, content: json(transformedContent), summary: copiedSnapshot?.summary ?? source.memorySummary,
          checksum: createHash("sha256").update(canonical(restored), "utf8").digest("hex"), inputTokens: copiedSnapshot?.inputTokens ?? 0,
          outputTokens: copiedSnapshot?.outputTokens ?? 0, estimatedCostUsd: copiedSnapshot?.estimatedCostUsd ?? 0, tokenAccounting: copiedSnapshot?.tokenAccounting ?? {},
        } })
      }
      await tx.agentTurn.createMany({ data: selectedTurns.map((turn) => ({
        id: turnMap.get(turn.id) as string, sessionId: id, userId: command.userId, status: turn.status, source: turn.source,
        input: json(turn.input), finalResponse: turn.finalResponse, error: turn.error, rootTaskId: null,
        contextSnapshotId: snapshotId, modelProfileSnapshot: json(turn.modelProfileSnapshot), toolPolicySnapshot: json({}), budgetSnapshot: json({}),
        revision: 0, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, estimatedCostUsd: turn.estimatedCostUsd,
        durationMs: turn.durationMs, startedAt: turn.startedAt, completedAt: turn.completedAt, leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null, leaseVersion: 0,
      })) })
      await tx.agentItem.createMany({ data: sourceItems.map((item) => ({
        id: itemMap.get(item.id) as string, sessionId: id, turnId: turnMap.get(item.turnId) as string, stepId: null, taskId: null,
        type: item.type, status: item.status, phase: item.phase, revision: 0, content: json(item.content), startedAt: item.startedAt, completedAt: item.completedAt, createdAt: item.createdAt,
      })) })
      if (copiedEvents.length > 0) await tx.agentEvent.createMany({ data: copiedEvents })

      let resultTurnId = turnMap.get(command.lastTurnId) as string
      if (command.editContent) {
        const edit = await createRootTurn(tx, { ...command, sessionId: id }, command.editContent)
        await acceptInputFacts(tx, { ...command, sessionId: id }, command.editContent, edit, "follow_up", "started", true)
        resultTurnId = edit.id
      }
      const markerSequence = BigInt(copiedEvents.length) + (command.editContent ? BigInt(3) : BigInt(1))
      await tx.agentEvent.create({ data: {
        id: randomUUID(), sessionId: id, turnId: resultTurnId, itemId: null, taskId: null, sequence: markerSequence,
        type: "session.forked", actor: "user", correlationId: resultTurnId, causationId: null,
        idempotencyKey: `fork-command:${command.clientMessageId}`,
        payload: json({ sourceSessionId: command.sessionId, lastTurnId: command.lastTurnId, resultTurnId, clientMessageId: command.clientMessageId, editFingerprint: editFingerprint(command) }),
      } })
      await tx.agentSession.update({ where: { id }, data: { eventSequence: markerSequence } })
      return { sessionId: id, turnId: resultTurnId, lastTurnId: command.lastTurnId, disposition: "forked" }
    })
  }
}
