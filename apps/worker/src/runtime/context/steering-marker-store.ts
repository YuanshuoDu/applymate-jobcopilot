import type pg from "pg"

import {
  STEERING_MARKER_EVENT_TYPE,
  STEERING_MARKER_MAX_BYTES,
  STEERING_MARKER_MAX_EVENTS,
  parseSteeringMarkerPayload,
  steeringMarkerIdempotencyKey,
  type SteeringMarkerPayload,
} from "./steering-marker.js"

const EVENT_TOPIC = "agent.events"
const MAX_KEY = 512

export type SteeringMarkerContext = {
  readonly taskId: string
  readonly obligationId: string
  readonly goalRevision: number
  readonly planRevision: number | null
}
export type SteeringMarkerWrite = {
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly stepId: string
  readonly payload: unknown
  readonly lease?: { readonly ownerId: string; readonly leaseVersion: number; readonly now: Date }
}
export type SteeringMarkerDatabaseScope = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly lease?: { readonly ownerId: string; readonly now: Date }
}
export type SteeringMarkerInput = { readonly id: string; readonly acceptedSequence: bigint }
export type AppliedSteeringMarkerEntry = { readonly key: string; readonly payload: SteeringMarkerPayload }
export type SteeringMarkerTransaction = {
  readonly appendObservedSteeringMarker?: (input: SteeringMarkerWrite) => Promise<void>
}
type QueryClient = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

export class SteeringMarkerStoreError extends Error {
  readonly recoverable = false
  constructor(readonly code: "invalid_marker" | "scope_conflict" | "idempotency_conflict" | "write_failed", message: string) {
    super(message)
    this.name = "SteeringMarkerStoreError"
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}
function sameJson(left: unknown, right: unknown): boolean { try { return stableJson(left) === stableJson(right) } catch { return false } }
function eventId(key: string): string {
  if (key.length > MAX_KEY) throw new SteeringMarkerStoreError("invalid_marker", "Steering marker idempotency key is too long")
  return `steering-marker-event:${key}`
}
function outboxKey(id: string): string { return `agent-event:${id}` }
function outboxPayload(input: { eventId: string; payload: SteeringMarkerPayload; sequence: string }): string {
  return JSON.stringify({ eventId: input.eventId, sessionId: input.payload.sessionId, turnId: input.payload.turnId, taskId: input.payload.taskId, itemId: null, sequence: input.sequence, type: STEERING_MARKER_EVENT_TYPE, actor: "system", correlationId: input.payload.turnId, causationId: null, idempotencyKey: input.payload.idempotencyKey, payload: input.payload })
}
function validatedPayload(input: SteeringMarkerWrite, scope: SteeringMarkerDatabaseScope): SteeringMarkerPayload {
  const payload = parseSteeringMarkerPayload(input.payload)
  if (!payload || payload.kind !== "observed" || payload.status !== "observed") throw new SteeringMarkerStoreError("invalid_marker", "Observed steering marker payload is invalid")
  if (input.sessionId !== scope.sessionId || input.turnId !== scope.turnId || input.taskId !== scope.taskId || payload.sessionId !== scope.sessionId || payload.turnId !== scope.turnId || payload.taskId !== scope.taskId || payload.stepId !== input.stepId) {
    throw new SteeringMarkerStoreError("scope_conflict", "Observed steering marker is outside the fenced Step")
  }
  if (payload.idempotencyKey !== steeringMarkerIdempotencyKey(payload)) throw new SteeringMarkerStoreError("invalid_marker", "Observed steering marker key is not derived")
  return payload
}

async function writeOutbox(client: QueryClient, payload: SteeringMarkerPayload, id: string, sequence: string): Promise<void> {
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`, [
    `steering-marker-outbox:${id}`, EVENT_TOPIC, payload.sessionId, outboxKey(id), outboxPayload({ eventId: id, payload, sequence }),
  ])
}

export async function persistObservedSteeringMarker(client: QueryClient, scope: SteeringMarkerDatabaseScope, input: SteeringMarkerWrite): Promise<void> {
  const payload = validatedPayload(input, scope)
  const id = eventId(payload.idempotencyKey)
  const task = await client.query<Row>(`SELECT task."id" FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4
      AND task."status" = 'running' AND ($5::text IS NULL OR (task."leaseOwner" = $5 AND task."leaseExpiresAt" > $6)) FOR UPDATE`,
  [scope.taskId, scope.sessionId, scope.turnId, scope.userId, scope.lease?.ownerId ?? null, scope.lease?.now ?? new Date()])
  if (!task.rows[0]) throw new SteeringMarkerStoreError("scope_conflict", "Observed steering marker task is not owned by the active Turn")
  const existing = await client.query<Row>(`SELECT "id", "turnId", "taskId", "type", "actor", "correlationId", "payload", "sequence" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [scope.sessionId, payload.idempotencyKey])
  const row = existing.rows[0]
  if (row) {
    const persisted = parseSteeringMarkerPayload(row.payload)
    if (String(row.id) !== id || row.turnId !== scope.turnId || row.taskId !== scope.taskId || row.type !== STEERING_MARKER_EVENT_TYPE || row.actor !== "system" || row.correlationId !== scope.turnId || !persisted || !sameJson(persisted, payload)) throw new SteeringMarkerStoreError("idempotency_conflict", "Observed steering marker key was reused with different content")
    const sequence = String(row.sequence)
    await writeOutbox(client, payload, id, sequence)
    return
  }
  const sequenceResult = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [scope.sessionId, scope.userId])
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw new SteeringMarkerStoreError("write_failed", "Session event sequence was not advanced")
  const normalizedSequence = BigInt(sequence).toString()
  const inserted = await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, NULL, $4, $5, $6, 'system', $3, NULL, $7, $8::jsonb)`, [id, scope.sessionId, scope.turnId, scope.taskId, normalizedSequence, STEERING_MARKER_EVENT_TYPE, payload.idempotencyKey, JSON.stringify(payload)])
  if (inserted.rowCount !== 1) throw new SteeringMarkerStoreError("write_failed", "Observed steering marker event was not persisted")
  await writeOutbox(client, payload, id, normalizedSequence)
}

export function buildObservedSteeringMarker(input: { readonly sessionId: string; readonly turnId: string; readonly stepId: string; readonly context: SteeringMarkerContext; readonly markerInput: SteeringMarkerInput }): SteeringMarkerPayload {
  const sequence = input.markerInput.acceptedSequence
  if (sequence < 0n) throw new SteeringMarkerStoreError("invalid_marker", "Steering input sequence is negative")
  const payload: SteeringMarkerPayload = {
    schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: input.sessionId, turnId: input.turnId,
    taskId: input.context.taskId, stepId: input.stepId, inputId: input.markerInput.id,
    idempotencyKey: steeringMarkerIdempotencyKey(input.sessionId, input.turnId, input.markerInput.id), obligationId: input.context.obligationId,
    goalRevision: input.context.goalRevision, planRevision: input.context.planRevision, acceptedSequence: sequence.toString(),
  }
  if (!parseSteeringMarkerPayload(payload)) throw new SteeringMarkerStoreError("invalid_marker", "Steering marker construction failed validation")
  return payload
}

export function buildAppliedSteeringMarker(input: { readonly marker: SteeringMarkerPayload; readonly stepId: string }): SteeringMarkerPayload {
  const marker = parseSteeringMarkerPayload(input.marker)
  if (!marker || marker.kind !== "observed" || marker.status !== "observed") throw new SteeringMarkerStoreError("invalid_marker", "Applied marker source is invalid")
  const payload: SteeringMarkerPayload = { ...marker, kind: "applied", status: "applied", stepId: input.stepId }
  if (!parseSteeringMarkerPayload(payload)) throw new SteeringMarkerStoreError("invalid_marker", "Applied steering marker construction failed validation")
  return payload
}

export function appliedSteeringMarkerEntries(input: {
  readonly markers: readonly SteeringMarkerPayload[]
  readonly context: SteeringMarkerContext
  readonly stepId: string
}): readonly AppliedSteeringMarkerEntry[] {
  if (!Array.isArray(input.markers) || input.markers.length > STEERING_MARKER_MAX_EVENTS) throw new SteeringMarkerStoreError("invalid_marker", "Applied steering marker count exceeds the server bound")
  const entries: AppliedSteeringMarkerEntry[] = [], seen = new Map<string, string>()
  for (const candidate of input.markers) {
    const marker = parseSteeringMarkerPayload(candidate)
    if (!marker) throw new SteeringMarkerStoreError("invalid_marker", "Active steering marker is invalid")
    if (marker.kind !== "observed" || marker.status !== "observed") throw new SteeringMarkerStoreError("invalid_marker", "Applied marker source is not active")
    if (marker.taskId !== input.context.taskId || marker.obligationId !== input.context.obligationId || marker.goalRevision !== input.context.goalRevision || marker.planRevision !== input.context.planRevision) continue
    const fingerprint = JSON.stringify(marker), prior = seen.get(marker.idempotencyKey)
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new SteeringMarkerStoreError("idempotency_conflict", "Active steering marker is conflicting")
      continue
    }
    seen.set(marker.idempotencyKey, fingerprint)
    const payload = buildAppliedSteeringMarker({ marker, stepId: input.stepId })
    entries.push({ key: `steering-marker-applied:${marker.inputId}:${input.context.obligationId}:${input.context.goalRevision}:${input.context.planRevision ?? "none"}`, payload })
  }
  entries.sort((left, right) => left.payload.idempotencyKey.localeCompare(right.payload.idempotencyKey))
  const bytes = Buffer.byteLength(JSON.stringify(entries), "utf8")
  if (bytes > STEERING_MARKER_MAX_BYTES) throw new SteeringMarkerStoreError("invalid_marker", "Applied steering markers exceed the byte bound")
  return entries
}

export async function appendNewObservedSteeringMarkers(input: {
  readonly transaction: SteeringMarkerTransaction
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly context: SteeringMarkerContext
  readonly inputs: readonly SteeringMarkerInput[]
  readonly newlyClaimedInputIds: readonly string[]
  readonly rootInputId?: string
  readonly lease?: SteeringMarkerWrite["lease"]
}): Promise<void> {
  const append = input.transaction.appendObservedSteeringMarker
  if (!append) throw new SteeringMarkerStoreError("write_failed", "Observed steering marker transaction seam is unavailable")
  const claimed = new Set(input.newlyClaimedInputIds)
  if (claimed.size !== input.newlyClaimedInputIds.length || [...claimed].some(id => id !== input.rootInputId && !input.inputs.some(markerInput => markerInput.id === id))) throw new SteeringMarkerStoreError("invalid_marker", "Newly claimed steering input is missing from the claim result")
  for (const markerInput of input.inputs) {
    if (!claimed.has(markerInput.id) || markerInput.id === input.rootInputId) continue
    const payload = buildObservedSteeringMarker({ sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId, context: input.context, markerInput })
    await append({ sessionId: input.sessionId, turnId: input.turnId, taskId: input.context.taskId, stepId: input.stepId, payload, lease: input.lease })
  }
}
