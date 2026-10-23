import { createHash } from "node:crypto"
import type pg from "pg"

export const SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA = "agent-harness.v2.scheduled-taskgraph-gate-binding.v1" as const
export const SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT = "agent.plan.scheduled_gate_binding" as const

export type ScheduledGateRegistrationOwner = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  rootAttemptCount: number
  executionId: string
  executionAttemptCount: number
}>
export type ScheduledGateRegistrationReceipt = Readonly<{
  schemaVersion: typeof SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA
  owner: ScheduledGateRegistrationOwner
  continuationKey: string
  snapshotDigest: string
  evidenceDigest: string
  checkpointDigest: string
  analyzeGraphRevision: number
  prepareScheduleRevision: number
  prepareWaitId: string
  gateTaskId: string
  gateAppendRevision: number
}>

const RECEIPT_KEYS = ["schemaVersion", "owner", "continuationKey", "snapshotDigest", "evidenceDigest", "checkpointDigest",
  "analyzeGraphRevision", "prepareScheduleRevision", "prepareWaitId", "gateTaskId", "gateAppendRevision"] as const
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"] as const
const ID = /^[^\u0000-\u001f\u007f]+$/
type Queryable = Pick<pg.PoolClient, "query">

export function scheduledGateRegistrationReceiptKey(continuationKey: string, gateTaskId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([continuationKey, gateTaskId]), "utf8").digest("hex")
  return `scheduled-gate-binding:${digest}`
}

export async function readScheduledGateRegistrationReceipt(client: Queryable, input: Readonly<{
  userId: string; sessionId: string; turnId: string; owner: ScheduledGateRegistrationOwner; gateTaskId: string
}>): Promise<ScheduledGateRegistrationReceipt | null> {
  const result = await client.query(`SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id"
        OR outbox."payload"->>'eventId' = event."id") AS "hasOutbox"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND session."userId" = $4 AND turn."userId" = $4`, [input.sessionId, input.turnId, SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT, input.userId])
  if (result.rows.length !== 1) return null
  const row = record(result.rows[0]), receipt = parseScheduledGateRegistrationReceipt(row?.payload)
  return row && row.itemId === null && row.taskId === null && row.actor === "system" && row.hasOutbox === false
    && row.idempotencyKey === scheduledGateRegistrationReceiptKey(receipt?.continuationKey ?? "", input.gateTaskId)
    && receipt?.gateTaskId === input.gateTaskId && sameOwner(receipt.owner, input.owner) ? receipt : null
}

export function buildScheduledGateRegistrationReceipt(value: unknown): ScheduledGateRegistrationReceipt | null {
  return parseScheduledGateRegistrationReceipt(value)
}

export function parseScheduledGateRegistrationReceipt(value: unknown): ScheduledGateRegistrationReceipt | null {
  const row = record(value), owner = parseOwner(row?.owner)
  if (!row || !owner || !exact(row, RECEIPT_KEYS) || row.schemaVersion !== SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA
    || !id(row.continuationKey, /^scheduled-taskgraph:sha256:[a-f0-9]{64}$/)
    || !id(row.snapshotDigest, /^sha256:[a-f0-9]{64}$/) || !id(row.evidenceDigest, /^[a-f0-9]{64}$/)
    || !id(row.checkpointDigest, /^[a-f0-9]{64}$/) || !id(row.prepareWaitId) || !id(row.gateTaskId)
    || !positive(row.analyzeGraphRevision) || row.prepareScheduleRevision !== Number(row.analyzeGraphRevision) + 1
    || !positive(row.gateAppendRevision) || Number(row.gateAppendRevision) <= Number(row.prepareScheduleRevision)) return null
  return Object.freeze({ schemaVersion: SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA, owner, continuationKey: row.continuationKey,
    snapshotDigest: row.snapshotDigest, evidenceDigest: row.evidenceDigest, checkpointDigest: row.checkpointDigest,
    analyzeGraphRevision: Number(row.analyzeGraphRevision), prepareScheduleRevision: Number(row.prepareScheduleRevision),
    prepareWaitId: row.prepareWaitId, gateTaskId: row.gateTaskId, gateAppendRevision: Number(row.gateAppendRevision) })
}

function parseOwner(value: unknown): ScheduledGateRegistrationOwner | null {
  const row = record(value)
  if (!row || !exact(row, OWNER_KEYS) || !OWNER_KEYS.slice(0, 4).every(key => id(row[key]))
    || !positive(row.rootAttemptCount) || !nonNegative(row.executionAttemptCount)) return null
  return Object.freeze({ userId: row.userId as string, sessionId: row.sessionId as string, turnId: row.turnId as string,
    rootTaskId: row.rootTaskId as string, rootAttemptCount: Number(row.rootAttemptCount), executionId: row.executionId as string,
    executionAttemptCount: Number(row.executionAttemptCount) })
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string")) return null
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
    }
    return value as Record<string, unknown>
  } catch { return null }
}
function exact(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(row)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function id(value: unknown, pattern?: RegExp): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && ID.test(value)
    && (!pattern || pattern.test(value))
}
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function sameOwner(left: ScheduledGateRegistrationOwner, right: ScheduledGateRegistrationOwner): boolean {
  return OWNER_KEYS.every(key => left[key] === right[key])
}
