import { createHash, randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { canonicalJson } from "./context-snapshot-json.js"
import type { ContextSnapshotAdapterStore } from "./context-snapshot-adapter.js"
import type { StepContextSnapshot } from "./step-context-builder.js"

const MAX_SNAPSHOT_BYTES = 256 * 1024
const MAX_TEXT_BYTES = 256
const SNAPSHOT_REF = /^[0-9a-f]{64}$/
type Pool = Pick<pg.Pool, "connect">
type Client = Pick<pg.PoolClient, "query" | "release">
type QueryResult<T> = { readonly rows: T[]; readonly rowCount: number | null }
type Identity = { readonly userId: string; readonly sessionId: string; readonly turnId: string; readonly stepId: string; readonly idempotencyKey: string }
type SnapshotRow = Identity & { readonly id: string; readonly snapshotRef: string; readonly snapshot: unknown; readonly byteCount: number | string; readonly createdAt: Date | string }
type StoredRow = Identity & { readonly snapshotRef: string; readonly snapshot: StepContextSnapshot; readonly byteCount: number; readonly createdAt: Date }

export class ContextSnapshotAdapterStoreError extends Error {
  constructor(readonly code: "invalid_input" | "snapshot_too_large" | "snapshot_scope_error" | "snapshot_conflict" | "snapshot_corrupt" | "snapshot_reference_mismatch", message: string = code) {
    super(message)
    this.name = "ContextSnapshotAdapterStoreError"
  }
}

const COLUMNS = `"id", "userId", "sessionId", "turnId", "stepId", "idempotencyKey", "snapshotRef", "snapshot", "byteCount", "createdAt"`

function text(value: unknown, name: string, code: "invalid_input" | "snapshot_corrupt" = "invalid_input"): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) throw new ContextSnapshotAdapterStoreError(code, `${name} is invalid`)
  return value
}

function scopeUser(scope: TenantScope): string { return text(scope?.userId, "scope.userId") }

function validShape(value: unknown): value is StepContextSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const keys = ["system", "profile", "goal", "steerHistory", "businessRefs", "toolObservations"]
  return Object.keys(row).every(key => keys.includes(key))
    && ["system", "profile", "steerHistory", "businessRefs", "toolObservations"].every(key => Array.isArray(row[key]))
    && (row.goal === undefined || (!!row.goal && typeof row.goal === "object" && !Array.isArray(row.goal)))
}

function snapshotData(value: unknown, failureCode: "invalid_input" | "snapshot_corrupt" = "invalid_input"): { readonly snapshot: StepContextSnapshot; readonly encoded: string; readonly byteCount: number } {
  if (!validShape(value)) throw new ContextSnapshotAdapterStoreError(failureCode, "snapshot shape is invalid")
  let encoded: string
  try { encoded = canonicalJson(value) } catch { throw new ContextSnapshotAdapterStoreError(failureCode, "snapshot is not safe JSON") }
  const byteCount = Buffer.byteLength(encoded, "utf8")
  if (byteCount > MAX_SNAPSHOT_BYTES) throw new ContextSnapshotAdapterStoreError("snapshot_too_large", "snapshot exceeds the 256 KiB runtime bound")
  return { snapshot: JSON.parse(encoded) as StepContextSnapshot, encoded, byteCount }
}

function ref(identity: Identity, snapshot: StepContextSnapshot, failureCode: "invalid_input" | "snapshot_corrupt" = "invalid_input"): string {
  try { return createHash("sha256").update(canonicalJson({ ...identity, snapshot }), "utf8").digest("hex") } catch {
    throw new ContextSnapshotAdapterStoreError(failureCode, "snapshot identity is not safe JSON")
  }
}

function expectedIdentity(input: { readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string; readonly stepId: string; readonly idempotencyKey: string }): Identity {
  return { userId: scopeUser(input.scope), sessionId: text(input.sessionId, "sessionId"), turnId: text(input.turnId, "turnId"), stepId: text(input.stepId, "stepId"), idempotencyKey: text(input.idempotencyKey, "idempotencyKey") }
}

function loadIdentity(input: { readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string }): Pick<Identity, "userId" | "sessionId" | "turnId"> {
  return { userId: scopeUser(input.scope), sessionId: text(input.sessionId, "sessionId"), turnId: text(input.turnId, "turnId") }
}

function snapshotRef(value: unknown, code: "invalid_input" | "snapshot_corrupt" = "invalid_input"): string {
  const result = text(value, "snapshotRef", code)
  if (!SNAPSHOT_REF.test(result)) throw new ContextSnapshotAdapterStoreError(code, "snapshotRef is not a lowercase SHA-256 reference")
  return result
}

function rowDate(value: Date | string, name: string): Date {
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (!Number.isFinite(result.getTime())) throw new ContextSnapshotAdapterStoreError("snapshot_corrupt", `${name} is invalid`)
  return result
}

function rowBytes(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_SNAPSHOT_BYTES) throw new ContextSnapshotAdapterStoreError("snapshot_corrupt", "byteCount is invalid")
  return result
}

function mapRow(row: SnapshotRow): StoredRow {
  const identity: Identity = { userId: text(row.userId, "userId", "snapshot_corrupt"), sessionId: text(row.sessionId, "sessionId", "snapshot_corrupt"), turnId: text(row.turnId, "turnId", "snapshot_corrupt"), stepId: text(row.stepId, "stepId", "snapshot_corrupt"), idempotencyKey: text(row.idempotencyKey, "idempotencyKey", "snapshot_corrupt") }
  text(row.id, "id", "snapshot_corrupt")
  const persistedRef = snapshotRef(row.snapshotRef, "snapshot_corrupt")
  const data = snapshotData(row.snapshot, "snapshot_corrupt")
  const byteCount = rowBytes(row.byteCount)
  if (byteCount !== data.byteCount) throw new ContextSnapshotAdapterStoreError("snapshot_corrupt", "byteCount does not match canonical snapshot")
  if (ref(identity, data.snapshot, "snapshot_corrupt") !== persistedRef) throw new ContextSnapshotAdapterStoreError("snapshot_reference_mismatch", "snapshotRef does not match snapshot identity")
  return { ...identity, snapshotRef: persistedRef, snapshot: data.snapshot, byteCount, createdAt: rowDate(row.createdAt, "createdAt") }
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId && left.stepId === right.stepId && left.idempotencyKey === right.idempotencyKey
}

async function transaction<T>(pool: Pool, userId: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function assertTurn(client: Client, identity: Pick<Identity, "userId" | "sessionId" | "turnId">): Promise<void> {
  const result = await client.query<{ id: string }>(`SELECT turn."id"
    FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2
      AND turn."userId" = $3 AND session."userId" = $3
    FOR SHARE`, [identity.turnId, identity.sessionId, identity.userId]) as QueryResult<{ id: string }>
  if (!result.rows[0]) throw new ContextSnapshotAdapterStoreError("snapshot_scope_error", "turn is outside the tenant scope")
}

async function assertStep(client: Client, identity: Identity): Promise<void> {
  const result = await client.query<{ id: string }>(`SELECT step."id"
    FROM "agent_steps" AS step
    JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
    WHERE step."id" = $1 AND step."turnId" = $2 AND step."sessionId" = $3
      AND turn."userId" = $4 AND session."userId" = $4
    FOR SHARE`, [identity.stepId, identity.turnId, identity.sessionId, identity.userId]) as QueryResult<{ id: string }>
  if (!result.rows[0]) throw new ContextSnapshotAdapterStoreError("snapshot_scope_error", "step is outside the tenant scope")
}

async function identityRow(client: Client, identity: Identity): Promise<SnapshotRow | undefined> {
  const result = await client.query<SnapshotRow>(`SELECT ${COLUMNS} FROM "agent_context_compaction_snapshots"
    WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "stepId" = $4 AND "idempotencyKey" = $5
    FOR UPDATE`, [identity.userId, identity.sessionId, identity.turnId, identity.stepId, identity.idempotencyKey]) as QueryResult<SnapshotRow>
  return result.rows[0]
}

function output(row: StoredRow): { readonly snapshotRef: string; readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string } {
  return { snapshotRef: row.snapshotRef, scope: { userId: row.userId }, sessionId: row.sessionId, turnId: row.turnId }
}

export function createPgContextSnapshotAdapterStore(pool: Pool): ContextSnapshotAdapterStore {
  return {
    async save(input): Promise<ReturnType<ContextSnapshotAdapterStore["save"]> extends Promise<infer T> ? T : never> {
      const identity = expectedIdentity(input)
      const data = snapshotData(input.snapshot)
      const expectedRef = snapshotRef(input.snapshotRef)
      if (expectedRef !== ref(identity, data.snapshot)) throw new ContextSnapshotAdapterStoreError("snapshot_reference_mismatch", "snapshotRef does not match snapshot identity")
      return transaction(pool, identity.userId, async client => {
        await assertStep(client, identity)
        const inserted = await client.query<SnapshotRow>(`INSERT INTO "agent_context_compaction_snapshots"
          (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
          ON CONFLICT ("userId", "sessionId", "turnId", "stepId", "idempotencyKey") DO NOTHING
          RETURNING ${COLUMNS}`, [`context-compaction-${randomUUID()}`, identity.userId, identity.sessionId, identity.turnId, identity.stepId, identity.idempotencyKey, expectedRef, data.encoded, data.byteCount, new Date()]) as QueryResult<SnapshotRow>
        const current = inserted.rows[0] ?? await identityRow(client, identity)
        if (!current) {
          throw new ContextSnapshotAdapterStoreError("snapshot_conflict", "snapshotRef is already bound to another identity")
        }
        const persisted = mapRow(current)
        if (!sameIdentity(persisted, identity) || persisted.snapshotRef !== expectedRef || persisted.byteCount !== data.byteCount || canonicalJson(persisted.snapshot) !== data.encoded) {
          throw new ContextSnapshotAdapterStoreError("snapshot_conflict", "snapshot identity already has different content")
        }
        return output(persisted)
      })
    },

    async load(input): Promise<Awaited<ReturnType<ContextSnapshotAdapterStore["load"]>>> {
      const identity = loadIdentity(input)
      const requestedRef = snapshotRef(input.snapshotRef)
      return transaction(pool, identity.userId, async client => {
        await assertTurn(client, identity)
        const result = await client.query<SnapshotRow>(`SELECT ${COLUMNS} FROM "agent_context_compaction_snapshots"
          WHERE "snapshotRef" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4`, [requestedRef, identity.userId, identity.sessionId, identity.turnId]) as QueryResult<SnapshotRow>
        const current = result.rows[0]
        if (!current) return null
        const persisted = mapRow(current)
        if (persisted.userId !== identity.userId || persisted.sessionId !== identity.sessionId || persisted.turnId !== identity.turnId || persisted.snapshotRef !== requestedRef) throw new ContextSnapshotAdapterStoreError("snapshot_scope_error", "snapshot is outside the requested identity")
        return { snapshot: persisted.snapshot, scope: { userId: persisted.userId }, sessionId: persisted.sessionId, turnId: persisted.turnId }
      })
    },

    async loadByIdempotencyKey(input): Promise<Awaited<ReturnType<ContextSnapshotAdapterStore["loadByIdempotencyKey"]>>> {
      const identity = expectedIdentity(input)
      return transaction(pool, identity.userId, async client => {
        await assertStep(client, identity)
        const current = await identityRow(client, identity)
        if (!current) return null
        const persisted = mapRow(current)
        if (!sameIdentity(persisted, identity)) throw new ContextSnapshotAdapterStoreError("snapshot_scope_error", "snapshot is outside the requested identity")
        return {
          scope: { userId: persisted.userId },
          sessionId: persisted.sessionId,
          turnId: persisted.turnId,
          stepId: persisted.stepId,
          idempotencyKey: persisted.idempotencyKey,
          snapshotRef: persisted.snapshotRef,
          snapshot: persisted.snapshot,
        }
      })
    },
  }
}
