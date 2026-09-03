import { createHash, randomUUID } from "node:crypto"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { assertSnapshotIntegrity, snapshotCanonicalJson, snapshotChecksum } from "./context-snapshot-canonical.js"
import type {
  ContextSnapshotContent,
} from "./context-snapshot-types.js"
import type { AgentContextSnapshot } from "./context-snapshot-types.js"
import {
  ContextForkError,
  type ForkEvent,
  type ForkItem,
  type ForkPlan,
  type ForkRequest,
  type ForkSource,
  type ForkTurn,
} from "./context-fork-types.js"

export * from "./context-fork-types.js"

const ACTIVE_TURN_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting_for_dependency",
  "waiting_for_approval",
  "waiting_for_user",
])

const SIDE_EFFECT_TYPES = new Set([
  "action_receipt",
  "approval_receipt",
  "lease_acquired",
  "lease_released",
  "action_reservation",
  "pending_action",
  "pending_input",
])

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextForkError("invalid_request", `${field} must be non-empty`)
  return value.trim()
}

function time(value: Date | string | number): number {
  const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(result) ? result : 0
}

function sequence(value: bigint | number | string): bigint {
  try {
    const result = BigInt(value)
    if (result < 0n) throw new Error("negative")
    return result
  } catch {
    throw new ContextForkError("invalid_request", "Event sequence must be a non-negative integer")
  }
}

function targetId(scope: TenantScope, request: ForkRequest): string {
  const source = `${scope.userId}:${request.sourceSessionId}:${request.clientMessageId}`
  return `fork-${createHash("sha256").update(source, "utf8").digest("hex").slice(0, 32)}`
}

function excludedType(type: string): boolean {
  const normalized = type.trim().toLowerCase()
  return SIDE_EFFECT_TYPES.has(normalized)
    || normalized.includes("receipt")
    || normalized.includes("lease")
    || normalized.includes("reservation")
    || normalized === "input.pending"
}

function excludedItem(item: ForkItem): boolean {
  return excludedType(item.type) || ["pending", "in_progress"].includes(item.status)
}

function restoredContent(content: ContextSnapshotContent, sessionId: string, throughSequence: bigint): ContextSnapshotContent {
  return {
    ...content,
    sessionId,
    throughSequence: throughSequence.toString(),
    pendingApprovals: [],
    consumedInputIds: [...content.consumedInputIds],
    references: content.references.map((reference) => ({ ...reference })),
  }
}

export function restoreCanonicalSnapshot(
  snapshot: AgentContextSnapshot,
  sessionId: string,
  throughSequence: bigint,
  now = new Date(),
): AgentContextSnapshot {
  required(sessionId, "sessionId")
  if (throughSequence < 0n) throw new ContextForkError("invalid_request", "throughSequence must be non-negative")
  assertSnapshotIntegrity(snapshot)
  const content = restoredContent(snapshot.content, sessionId, throughSequence)
  const restored = {
    sessionId,
    throughSequence,
    version: 1,
    schemaVersion: snapshot.schemaVersion,
    content,
    summary: snapshot.summary,
    memorySummary: snapshot.memorySummary,
    checksum: "",
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    estimatedCostUsd: snapshot.estimatedCostUsd,
    tokenAccounting: content.tokenAccounting,
    canonicalJson: "",
    createdAt: now,
  } satisfies AgentContextSnapshot
  const canonicalJson = snapshotCanonicalJson(restored)
  return { ...restored, canonicalJson, checksum: snapshotChecksum(restored) }
}

export function planFork(source: ForkSource, request: ForkRequest, id: () => string = randomUUID): ForkPlan {
  const sourceSessionId = required(request.sourceSessionId, "sourceSessionId")
  const clientMessageId = required(request.clientMessageId, "clientMessageId")
  const lastTurnId = required(request.lastTurnId, "lastTurnId")
  if (source.sessionId !== sourceSessionId || source.ownerId !== source.scope.userId) throw new ContextForkError("owner_mismatch", "Fork source is outside the tenant scope")

  const orderedTurns = [...source.turns].sort((left, right) => time(left.createdAt) - time(right.createdAt))
  const boundaryIndex = orderedTurns.findIndex((turn) => turn.id === lastTurnId)
  if (boundaryIndex < 0) throw new ContextForkError("boundary_not_found", `Turn ${lastTurnId} is not in the source session`)
  const boundary = orderedTurns[boundaryIndex]
  if (ACTIVE_TURN_STATUSES.has(boundary.status)) throw new ContextForkError("boundary_active", "Fork boundary must be a terminal Turn")

  const targetSessionId = targetId(source.scope, { sourceSessionId, lastTurnId, clientMessageId })
  const selectedTurns = orderedTurns.slice(0, boundaryIndex + 1)
  const turnIds = new Set(selectedTurns.map((turn) => turn.id))
  const turnMap = new Map(selectedTurns.map((turn) => [turn.id, id()]))
  const items = source.items.filter((item) => turnIds.has(item.turnId) && !excludedItem(item))
  const itemMap = new Map(items.map((item) => [item.id, id()]))
  const events = source.events
    .filter((event) => turnIds.has(event.turnId) && !excludedType(event.type))
    .sort((left, right) => (sequence(left.sequence) < sequence(right.sequence) ? -1 : 1))
    .map((event, index) => ({
      ...event,
      id: id(),
      sourceId: event.id,
      turnId: turnMap.get(event.turnId) as string,
      itemId: event.itemId && itemMap.has(event.itemId) ? itemMap.get(event.itemId) ?? null : null,
      taskId: null,
      sequence: BigInt(index + 1),
      idempotencyKey: `fork-history:${targetSessionId}:${event.id}`,
    }))
  const copiedItems = items.map((item) => ({
    ...item,
    id: itemMap.get(item.id) as string,
    sourceId: item.id,
    turnId: turnMap.get(item.turnId) as string,
    stepId: null,
    taskId: null,
  }))
  const copiedTurns = selectedTurns.map((turn) => ({
    ...turn,
    id: turnMap.get(turn.id) as string,
    sourceId: turn.id,
    leaseOwnerId: null,
    leaseExpiresAt: null,
    leaseStartedAt: null,
    leaseVersion: 0 as const,
    revision: 0 as const,
  }))
  const nextEventSequence = BigInt(events.length)
  const snapshot = source.snapshot
    ? restoreCanonicalSnapshot(source.snapshot, targetSessionId, nextEventSequence)
    : null
  return {
    targetSessionId,
    sourceSessionId,
    lastTurnId,
    clientMessageId,
    goal: source.goal,
    turns: copiedTurns,
    items: copiedItems,
    events,
    snapshot,
    nextEventSequence,
    excluded: { leases: true, receipts: true, pendingInputs: true, approvals: true, reservations: true, outbox: true },
  }
}

export type ForkIdempotencyRecord = {
  readonly sourceSessionId: string
  readonly lastTurnId: string
  readonly clientMessageId: string
  readonly targetSessionId: string
}

export function assertForkIdempotency(record: ForkIdempotencyRecord, request: ForkRequest): string {
  if (record.sourceSessionId !== request.sourceSessionId || record.lastTurnId !== request.lastTurnId || record.clientMessageId !== request.clientMessageId) {
    throw new ContextForkError("idempotency_conflict", "The idempotency key was already used for a different fork")
  }
  return record.targetSessionId
}
