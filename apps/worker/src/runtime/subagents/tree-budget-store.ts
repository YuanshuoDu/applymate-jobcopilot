import { randomUUID } from "node:crypto"
import type pg from "pg"

import {
  type TreeBudgetReservation,
  type TreeBudgetReservationStore,
  type TreeBudgetReservationStatus,
  type TreeBudgetReserveInput,
  type TreeBudgetExecutionLimits,
  type TreeBudgetRootIdentity,
  type TreeBudgetSettleInput,
} from "./tree-budget-types.js"

type Client = Pick<pg.PoolClient, "query" | "release">
type Pool = Pick<pg.Pool, "connect">
type QueryResult<T> = { rows: T[]; rowCount: number | null }
type Snapshot = Record<string, unknown>
type RootRow = { id: string; sessionId: string; turnId: string; rootTaskId: string; budgetSnapshot: unknown; status: string; interruptRequestedAt: Date | string | null }
type Row = Omit<TreeBudgetReservation, "status" | "createdAt" | "updatedAt" | "settledAt"> & {
  status: string; createdAt: Date | string; updatedAt: Date | string; settledAt: Date | string | null
}

export class TreeBudgetStoreError extends Error {
  constructor(readonly code: "invalid_input" | "root_not_found" | "lineage_rejected" | "tree_step_budget_exhausted" | "reservation_conflict" | "reservation_missing" | "settlement_conflict", message: string = code) {
    super(message)
    this.name = "TreeBudgetStoreError"
  }
}

const ACTIVE_ROOT = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const ACTIVE_TURN = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])
const OPEN_SESSION = `"status" NOT IN ('aborted', 'archived')`

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 256) throw new TreeBudgetStoreError("invalid_input", `${name} is invalid`)
  return value
}

function positiveInt(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) throw new TreeBudgetStoreError("invalid_input", `${name} is invalid`)
  return Number(value)
}

function now(value: Date | undefined): Date {
  const result = value ?? new Date()
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) throw new TreeBudgetStoreError("invalid_input", "now is invalid")
  return result
}

function record(value: unknown): Snapshot {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Snapshot : {}
}

function maxSteps(value: unknown): number {
  const root = record(value)
  const limits = record(root.limits)
  const candidate = limits.maxSteps ?? root.maxSteps
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0 && Number(candidate) <= 2_147_483_647 ? Number(candidate) : 32
}

function executionLimits(value: unknown): TreeBudgetExecutionLimits | undefined {
  const root = record(value)
  const limits = record(root.limits ?? root)
  const result: { maxSteps?: number; maxToolCalls?: number } = {}
  for (const key of ["maxSteps", "maxToolCalls"] as const) {
    const candidate = limits[key]
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) result[key] = candidate
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function date(value: Date | string | null): Date | null {
  if (!value) return null
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (!Number.isFinite(result.getTime())) throw new TreeBudgetStoreError("reservation_conflict", "stored reservation date is invalid")
  return result
}

function reservation(value: Row): TreeBudgetReservation {
  return { ...value, status: value.status as TreeBudgetReservationStatus, units: 1, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt), settledAt: date(value.settledAt) }
}

function identityMatches(row: TreeBudgetReservation, input: TreeBudgetReserveInput | TreeBudgetSettleInput): boolean {
  return row.userId === input.userId && row.sessionId === input.sessionId && row.turnId === input.turnId
    && row.rootTaskId === input.rootTaskId && row.taskId === input.taskId && row.stepId === input.stepId
    && row.attempt === input.attempt && row.units === 1 && row.idempotencyKey === input.idempotencyKey
}

async function transaction<T>(pool: Pool, userId: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await work(client)
    await client.query("COMMIT"); committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function lockRoot(client: Client, input: TreeBudgetRootIdentity, active = false): Promise<RootRow> {
  const result = await client.query<RootRow>(`SELECT root_task."id" AS "id", root_task."sessionId" AS "sessionId", root_task."turnId" AS "turnId", root_task."rootTaskId" AS "rootTaskId", root_task."budgetSnapshot" AS "budgetSnapshot", root_task."status" AS "status", root_task."interruptRequestedAt" AS "interruptRequestedAt"
    FROM "sub_agent_tasks" AS root_task JOIN "agent_sessions" AS session ON session."id" = root_task."sessionId"
    WHERE root_task."id" = $1 AND root_task."sessionId" = $2 AND root_task."turnId" = $3
      AND root_task."rootTaskId" = $1 AND session."userId" = $4 FOR UPDATE OF root_task`,
  [input.rootTaskId, input.sessionId, input.turnId, input.userId]) as QueryResult<RootRow>
  if (!result.rows[0]) throw new TreeBudgetStoreError("root_not_found")
  if (active && (!ACTIVE_ROOT.has(result.rows[0].status) || result.rows[0].interruptRequestedAt !== null)) throw new TreeBudgetStoreError("lineage_rejected")
  return result.rows[0]
}

async function lockTurn(client: Client, input: TreeBudgetRootIdentity, active: boolean): Promise<void> {
  const result = await client.query<{ id: string; rootTaskId: string | null; status: string }>(
    `SELECT "id", "rootTaskId", "status" FROM "agent_turns"
     WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
    [input.turnId, input.sessionId, input.userId],
  ) as QueryResult<{ id: string; rootTaskId: string | null; status: string }>
  const turn = result.rows[0]
  if (!turn || turn.rootTaskId !== input.rootTaskId || (active && !ACTIVE_TURN.has(turn.status))) throw new TreeBudgetStoreError("lineage_rejected")
}

async function lockSession(client: Client, input: Pick<TreeBudgetRootIdentity, "userId" | "sessionId">, active = true): Promise<void> {
  const result = await client.query<{ id: string; userId: string; status: string }>(
    `SELECT "id", "userId", "status" FROM "agent_sessions"
     WHERE "id" = $1 AND "userId" = $2 ${active ? `AND ${OPEN_SESSION}` : ""} FOR UPDATE`,
    [input.sessionId, input.userId],
  ) as QueryResult<{ id: string; userId: string; status: string }>
  if (!result.rows[0]) throw new TreeBudgetStoreError("root_not_found")
}

async function lockOwnerAndStep(client: Client, input: TreeBudgetReserveInput, active: boolean): Promise<void> {
  const taskValues = active
    ? [input.taskId, input.sessionId, input.turnId, input.rootTaskId, input.attempt]
    : [input.taskId, input.sessionId, input.turnId, input.rootTaskId]
  const tasks = await client.query<{ id: string }>(
    `SELECT "id" FROM "sub_agent_tasks"
     WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
       ${active ? `AND "status" = 'running' AND "interruptRequestedAt" IS NULL AND "attemptCount" = $5
         AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" > CURRENT_TIMESTAMP` : ""} FOR UPDATE`,
    taskValues,
  ) as QueryResult<{ id: string }>
  if (!tasks.rows[0]) throw new TreeBudgetStoreError("lineage_rejected")
  const stepValues = active
    ? [input.stepId, input.sessionId, input.turnId, input.taskId, input.attempt]
    : [input.stepId, input.sessionId, input.turnId, input.taskId]
  const steps = await client.query<{ id: string }>(
    `SELECT "id" FROM "agent_steps"
     WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4
       ${active ? `AND "status" = 'streaming' AND "attempt" = $5` : ""} FOR UPDATE`,
    stepValues,
  ) as QueryResult<{ id: string }>
  if (!steps.rows[0]) throw new TreeBudgetStoreError("lineage_rejected")
}

async function findExisting(client: Client, input: TreeBudgetReserveInput): Promise<TreeBudgetReservation | null> {
  const result = await client.query<Row>(`SELECT * FROM "agent_tree_budget_reservations"
    WHERE ("rootTaskId" = $1 AND "taskId" = $2 AND "stepId" = $3 AND "attempt" = $4)
       OR ("sessionId" = $5 AND "idempotencyKey" = $6)`, [input.rootTaskId, input.taskId, input.stepId, input.attempt, input.sessionId, input.idempotencyKey]) as QueryResult<Row>
  if (!result.rows[0]) return null
  const found = reservation(result.rows[0])
  if (result.rows.some(row => !identityMatches(found, reservation(row))) || !identityMatches(found, input)) throw new TreeBudgetStoreError("reservation_conflict")
  if (found.status === "released") throw new TreeBudgetStoreError("reservation_conflict")
  return found
}

async function countActive(client: Client, input: TreeBudgetReserveInput): Promise<number> {
  const result = await client.query<{ units: number | string }>(`SELECT COALESCE(SUM("units"), 0)::int AS "units"
    FROM "agent_tree_budget_reservations"
    WHERE "sessionId" = $1 AND "rootTaskId" = $2 AND "status" IN ('reserved', 'consumed')`, [input.sessionId, input.rootTaskId]) as QueryResult<{ units: number | string }>
  return Number(result.rows[0]?.units ?? 0)
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505")
}

export function createPgTreeBudgetReservationStore(pool: Pool): TreeBudgetReservationStore {
  return {
    async readRootLimits(raw): Promise<TreeBudgetExecutionLimits | undefined> {
      const input = {
        userId: text(raw.userId, "userId"), sessionId: text(raw.sessionId, "sessionId"),
        turnId: text(raw.turnId, "turnId"), rootTaskId: text(raw.rootTaskId, "rootTaskId"),
      }
      return transaction(pool, input.userId, async client => {
        await lockSession(client, input)
        await lockTurn(client, input, false)
        const root = await lockRoot(client, input)
        return executionLimits(root.budgetSnapshot)
      })
    },
    async reserve(raw): Promise<TreeBudgetReservation> {
      const input = { ...raw, userId: text(raw.userId, "userId"), sessionId: text(raw.sessionId, "sessionId"), turnId: text(raw.turnId, "turnId"), rootTaskId: text(raw.rootTaskId, "rootTaskId"), taskId: text(raw.taskId, "taskId"), stepId: text(raw.stepId, "stepId"), attempt: positiveInt(raw.attempt, "attempt"), idempotencyKey: text(raw.idempotencyKey, "idempotencyKey") }
      const timestamp = now(input.now)
      return transaction(pool, input.userId, async client => {
        await lockSession(client, input)
        await lockTurn(client, input, true)
        const root = await lockRoot(client, input, true)
        const existing = await findExisting(client, input)
        if (existing) return existing
        await lockOwnerAndStep(client, input, true)
        const used = await countActive(client, input)
        if (used + 1 > maxSteps(root.budgetSnapshot)) throw new TreeBudgetStoreError("tree_step_budget_exhausted")
        try {
          const result = await client.query<Row>(`INSERT INTO "agent_tree_budget_reservations"
            ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "attempt", "units", "status", "idempotencyKey", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'reserved', $9, $10, $10) RETURNING *`,
          [`tree-step-${randomUUID()}`, input.userId, input.sessionId, input.turnId, input.rootTaskId, input.taskId, input.stepId, input.attempt, input.idempotencyKey, timestamp]) as QueryResult<Row>
          if (!result.rows[0]) throw new TreeBudgetStoreError("reservation_conflict")
          return reservation(result.rows[0])
        } catch (error: unknown) {
          if (isUniqueViolation(error)) throw new TreeBudgetStoreError("reservation_conflict")
          throw error
        }
      })
    },
    async settle(raw): Promise<TreeBudgetReservation> {
      if (raw.status !== "consumed" && raw.status !== "released") throw new TreeBudgetStoreError("invalid_input", "status is invalid")
      const input = { ...raw, userId: text(raw.userId, "userId"), sessionId: text(raw.sessionId, "sessionId"), turnId: text(raw.turnId, "turnId"), rootTaskId: text(raw.rootTaskId, "rootTaskId"), taskId: text(raw.taskId, "taskId"), stepId: text(raw.stepId, "stepId"), attempt: positiveInt(raw.attempt, "attempt"), id: text(raw.id, "id"), idempotencyKey: text(raw.idempotencyKey, "idempotencyKey") }
      const timestamp = now(input.now)
      return transaction(pool, input.userId, async client => {
        await lockSession(client, input, false)
        await lockTurn(client, input, false)
        await lockRoot(client, input, false)
        await lockOwnerAndStep(client, input, false)
        const result = await client.query<Row>(`SELECT * FROM "agent_tree_budget_reservations" WHERE "id" = $1 FOR UPDATE`, [input.id]) as QueryResult<Row>
        if (!result.rows[0]) throw new TreeBudgetStoreError("reservation_missing")
        const current = reservation(result.rows[0])
        if (!identityMatches(current, input)) throw new TreeBudgetStoreError("reservation_conflict")
        if (current.status === input.status) return current
        if (current.status !== "reserved") throw new TreeBudgetStoreError("settlement_conflict")
        const updated = await client.query<Row>(`UPDATE "agent_tree_budget_reservations"
          SET "status" = $2, "settledAt" = $3, "updatedAt" = $3 WHERE "id" = $1 AND "status" = 'reserved' RETURNING *`, [input.id, input.status, timestamp]) as QueryResult<Row>
        if (!updated.rows[0]) throw new TreeBudgetStoreError("settlement_conflict")
        return reservation(updated.rows[0])
      })
    },
  }
}
