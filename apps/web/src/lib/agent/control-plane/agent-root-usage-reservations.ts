import { Prisma } from "@prisma/client"

export type RootUsageOwner =
  | { kind: "turn"; leaseOwnerId: string; leaseVersion: number }
  | { kind: "task"; taskId: string; rootTaskId: string; ownerId: string; attemptCount: number }

export type RootUsageQuery = { $queryRaw<T>(query: Prisma.Sql): Promise<T> }
export type RootUsageScopeInput = { userId: string; sessionId: string; turnId: string; stepId: string }
export type RootUsageScope = RootUsageScopeInput & {
  rootTaskId: string; taskId: string; attempt: number; budgetSnapshot: unknown; outputTokenReservationVersion: number | null
  executionOwnerKind: "turn" | "task"; executionOwnerId: string; executionOwnerVersion: number
}
export type RootUsageReservationRef = {
  id: string; userId: string; sessionId: string; turnId: string; rootTaskId: string; taskId: string; stepId: string
  executionOwnerKind: "turn" | "task"; executionOwnerId: string; executionOwnerVersion: number; outputReservationRequired: boolean
  attempt: number; attemptId: string; provider: string; model: string; reservedOutputTokens: number
  status: string; actualOutputTokens: number | null; outcomeStatus: string | null; errorCode: string | null
}
export type RootOutputAdmission = { required: false; maxOutputTokens: null } | { required: true; maxOutputTokens: number }

export class RootUsageReservationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = "RootUsageReservationError" }
}

const ACTIVE_TURN = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"]
const ACTIVE_ROOT = ["queued", "running", "retrying", "waiting", "waiting_for_user"]
const SUPPORTED_OUTPUT_ROUTES = new Set(["anthropic", "minimax"])

function rowObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { throw new RootUsageReservationError("root_usage_limit_invalid") } }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RootUsageReservationError("root_usage_limit_invalid")
  return value as Record<string, unknown>
}

function safeCount(value: unknown): number {
  try {
    const n = typeof value === "bigint" ? value : typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : value
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n
    if (typeof n === "bigint" && n >= BigInt(0) && n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n)
  } catch { /* invalid aggregate */ }
  throw new RootUsageReservationError("root_usage_invalid", 503)
}

function limits(snapshot: unknown): Record<string, unknown> {
  const value = rowObject(snapshot)
  if (!Object.prototype.hasOwnProperty.call(value, "limits") || value.limits === null) return value
  return rowObject(value.limits)
}

function outputLimit(snapshot: unknown): number | null {
  const value = limits(snapshot)
  for (const key of ["maxInputTokens", "maxCostUsd"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== null) throw new RootUsageReservationError("root_usage_budget_unsupported", 403)
  }
  if (!Object.prototype.hasOwnProperty.call(value, "maxOutputTokens")) return null
  const cap = value.maxOutputTokens
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 0) throw new RootUsageReservationError("root_usage_limit_invalid", 409)
  return cap
}

async function lockSession(tx: RootUsageQuery, input: RootUsageScopeInput, active: boolean): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status" FROM "agent_sessions" WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId} FOR UPDATE`)
  if (!rows[0] || (active && (rows[0].status === "aborted" || rows[0].status === "archived"))) throw new RootUsageReservationError("usage_fence_rejected")
}

export async function lockRootUsageAdmissionScope(
  tx: RootUsageQuery,
  input: RootUsageScopeInput,
  owner: RootUsageOwner,
  reservation?: RootUsageReservationRef,
): Promise<RootUsageScope> {
  await lockSession(tx, input, true)
  const turns = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT "id", "rootTaskId", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt",
      ("leaseExpiresAt" > CURRENT_TIMESTAMP) AS "leaseValid"
    FROM "agent_turns" WHERE "id" = ${input.turnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId} FOR UPDATE`)
  const turn = turns[0]
  if (!turn) throw new RootUsageReservationError("usage_fence_rejected")
  const rootTaskId = owner.kind === "task" ? owner.rootTaskId : String(turn.rootTaskId ?? "")
  if (!rootTaskId || (owner.kind === "task" && String(turn.rootTaskId ?? "") !== rootTaskId)) throw new RootUsageReservationError("usage_fence_rejected")
  const roots = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT "id", "budgetSnapshot", "outputTokenReservationVersion", "status", "interruptRequestedAt", "attemptCount", "leaseOwner", "leaseExpiresAt",
      ("leaseExpiresAt" > CURRENT_TIMESTAMP) AS "leaseValid"
    FROM "sub_agent_tasks" WHERE "id" = ${rootTaskId} AND "sessionId" = ${input.sessionId} AND "turnId" = ${input.turnId}
      AND "rootTaskId" = ${rootTaskId} FOR UPDATE`)
  const root = roots[0]
  if (!root || !ACTIVE_ROOT.includes(String(root.status)) || root.interruptRequestedAt) throw new RootUsageReservationError("usage_fence_rejected")
  let taskId = rootTaskId
  let attempt = 1
  if (owner.kind === "turn") {
    if (turn.status !== "in_progress" || turn.leaseOwnerId !== owner.leaseOwnerId || Number(turn.leaseVersion) !== owner.leaseVersion || turn.leaseValid !== true ||
        root.status !== "running" || root.leaseOwner !== owner.leaseOwnerId || root.leaseValid !== true) throw new RootUsageReservationError("usage_fence_rejected")
  } else {
    const tasks = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT "id", "rootTaskId", "turnId", "status", "interruptRequestedAt", "attemptCount", "leaseOwner", "leaseExpiresAt",
        ("leaseExpiresAt" > CURRENT_TIMESTAMP) AS "leaseValid"
      FROM "sub_agent_tasks" WHERE "id" = ${owner.taskId} AND "sessionId" = ${input.sessionId} AND "turnId" = ${input.turnId} FOR UPDATE`)
    const task = tasks[0]
    if (!task || task.id === rootTaskId || task.rootTaskId !== rootTaskId || task.status !== "running" || task.interruptRequestedAt ||
        task.leaseOwner !== owner.ownerId || Number(task.attemptCount) !== owner.attemptCount || task.leaseValid !== true || !ACTIVE_TURN.includes(String(turn.status))) {
      throw new RootUsageReservationError("usage_fence_rejected")
    }
    taskId = owner.taskId
    attempt = owner.attemptCount
  }
  const steps = await tx.$queryRaw<Array<{ id: string; taskId: string | null; attempt: number; status: string }>>(Prisma.sql`
    SELECT "id", "taskId", "attempt", "status" FROM "agent_steps"
    WHERE "id" = ${input.stepId} AND "turnId" = ${input.turnId} AND "sessionId" = ${input.sessionId} FOR UPDATE`)
  const step = steps[0]
  if (!step || step.status !== "streaming" || (owner.kind === "task" && step.taskId !== taskId) ||
      (owner.kind === "turn" && step.taskId !== null && step.taskId !== rootTaskId) || (owner.kind === "task" && step.attempt !== attempt)) {
    throw new RootUsageReservationError("usage_fence_rejected")
  }
  attempt = step.attempt
  const executionOwnerId = owner.kind === "turn" ? owner.leaseOwnerId : owner.ownerId
  const executionOwnerVersion = owner.kind === "turn" ? owner.leaseVersion : owner.attemptCount
  const scope = { ...input, rootTaskId, taskId, attempt, budgetSnapshot: root.budgetSnapshot, outputTokenReservationVersion: root.outputTokenReservationVersion === null ? null : Number(root.outputTokenReservationVersion), executionOwnerKind: owner.kind, executionOwnerId, executionOwnerVersion }
  if (reservation && (reservation.userId !== input.userId || reservation.sessionId !== input.sessionId || reservation.turnId !== input.turnId ||
      reservation.stepId !== input.stepId || reservation.rootTaskId !== rootTaskId || reservation.taskId !== taskId || reservation.attempt !== attempt ||
      reservation.executionOwnerKind !== owner.kind || reservation.executionOwnerId !== executionOwnerId || reservation.executionOwnerVersion !== executionOwnerVersion)) {
    throw new RootUsageReservationError("usage_fence_rejected")
  }
  return scope
}

export async function lockRootUsageReservationScope(tx: RootUsageQuery, row: RootUsageReservationRef): Promise<void> {
  const input = { userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, stepId: row.stepId }
  await lockSession(tx, input, false)
  const turns = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_turns" WHERE "id" = ${row.turnId} AND "sessionId" = ${row.sessionId} AND "userId" = ${row.userId} FOR UPDATE`)
  if (!turns[0]) throw new RootUsageReservationError("usage_attempt_missing")
  const roots = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "sub_agent_tasks" WHERE "id" = ${row.rootTaskId} AND "sessionId" = ${row.sessionId}
      AND "turnId" = ${row.turnId} AND "rootTaskId" = ${row.rootTaskId} FOR UPDATE`)
  if (!roots[0]) throw new RootUsageReservationError("usage_attempt_missing")
  if (row.taskId !== row.rootTaskId) {
    const tasks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "sub_agent_tasks" WHERE "id" = ${row.taskId} AND "sessionId" = ${row.sessionId}
        AND "turnId" = ${row.turnId} AND "rootTaskId" = ${row.rootTaskId} FOR UPDATE`)
    if (!tasks[0]) throw new RootUsageReservationError("usage_attempt_missing")
  }
  const steps = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_steps" WHERE "id" = ${row.stepId} AND "turnId" = ${row.turnId} AND "sessionId" = ${row.sessionId} FOR UPDATE`)
  if (!steps[0]) throw new RootUsageReservationError("usage_attempt_missing")
}

export async function reserveRootOutputTokens(
  tx: RootUsageQuery,
  scope: RootUsageScope,
  input: { operationId: string; attemptId: string; provider: string; model: string; requestedOutputTokens?: number; startProtocolVersion: 0 | 1 },
): Promise<RootOutputAdmission> {
  const limit = outputLimit(scope.budgetSnapshot)
  const strict = limit !== null
  if (strict && scope.outputTokenReservationVersion !== 1) throw new RootUsageReservationError("root_usage_unmarked", 409)
  if (input.startProtocolVersion !== 1) {
    if (strict) throw new RootUsageReservationError("usage_start_protocol_required", 409)
    return { required: false, maxOutputTokens: null }
  }
  let required = false, maxOutputTokens = 0
  if (strict) {
    if (!SUPPORTED_OUTPUT_ROUTES.has(input.provider)) throw new RootUsageReservationError("output_route_unsupported", 403)
    const requested = input.requestedOutputTokens
    if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1 || requested > 2_147_483_647) throw new RootUsageReservationError("output_reservation_unknown", 403)
    const sums = await tx.$queryRaw<Array<{ used: number | bigint | string }>>(Prisma.sql`
      SELECT COALESCE(SUM(CASE WHEN "status" = 'settled' THEN "actualOutputTokens" ELSE "reservedOutputTokens" END), 0)::bigint AS "used"
      FROM "agent_root_usage_reservations"
      WHERE "userId" = ${scope.userId} AND "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId}
        AND "rootTaskId" = ${scope.rootTaskId} AND "status" IN ('reserved', 'started', 'settled')`)
    const used = safeCount(sums[0]?.used ?? 0)
    const remaining = limit! - used
    if (remaining <= 0) throw new RootUsageReservationError("output_budget_exhausted", 429)
    maxOutputTokens = Math.min(requested, remaining)
    required = true
  }
  await tx.$queryRaw(Prisma.sql`
    INSERT INTO "agent_root_usage_reservations"
      ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId", "executionOwnerVersion",
       "attempt", "attemptId", "provider", "model", "outputReservationRequired", "reservedOutputTokens", "actualOutputTokens", "status", "idempotencyKey", "createdAt", "updatedAt")
    VALUES (${input.operationId}, ${scope.userId}, ${scope.sessionId}, ${scope.turnId}, ${scope.rootTaskId}, ${scope.taskId}, ${scope.stepId},
      ${scope.executionOwnerKind}, ${scope.executionOwnerId}, ${scope.executionOwnerVersion}, ${scope.attempt}, ${input.attemptId}, ${input.provider},
      ${input.model}, ${required}, ${maxOutputTokens}, NULL, 'reserved', ${input.operationId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
  return required ? { required: true, maxOutputTokens } : { required: false, maxOutputTokens: null }
}

export async function findRootOutputReservation(tx: RootUsageQuery, id: string, userId: string): Promise<RootUsageReservationRef | null> {
  const rows = await tx.$queryRaw<RootUsageReservationRef[]>(Prisma.sql`
    SELECT "id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId", "executionOwnerVersion",
      "attempt", "attemptId", "provider", "model", "outputReservationRequired", "reservedOutputTokens", "status", "actualOutputTokens", "outcomeStatus", "errorCode"
    FROM "agent_root_usage_reservations" WHERE "id" = ${id} AND "userId" = ${userId}`)
  return rows[0] ?? null
}

export async function lockRootUsageReservation(tx: RootUsageQuery, row: RootUsageReservationRef): Promise<RootUsageReservationRef> {
  const rows = await tx.$queryRaw<RootUsageReservationRef[]>(Prisma.sql`
    SELECT "id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId", "executionOwnerVersion",
      "attempt", "attemptId", "provider", "model", "outputReservationRequired", "reservedOutputTokens", "status", "actualOutputTokens", "outcomeStatus", "errorCode"
    FROM "agent_root_usage_reservations" WHERE "id" = ${row.id} AND "userId" = ${row.userId} FOR UPDATE`)
  if (!rows[0]) throw new RootUsageReservationError("usage_attempt_missing")
  return rows[0]
}

export async function startRootOutputReservation(tx: RootUsageQuery, identity: RootUsageReservationRef): Promise<number> {
  const row = await lockRootUsageReservation(tx, identity)
  if (row.status !== "reserved") throw new RootUsageReservationError("usage_start_replayed")
  const result = await tx.$queryRaw<Array<{ reservedOutputTokens: number }>>(Prisma.sql`
    UPDATE "agent_root_usage_reservations" SET "status" = 'started', "startedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${row.id} AND "status" = 'reserved' RETURNING "reservedOutputTokens"`)
  if (!result[0]) throw new RootUsageReservationError("usage_start_replayed")
  return Number(result[0].reservedOutputTokens)
}

export async function releaseRootOutputReservation(tx: RootUsageQuery, identity: RootUsageReservationRef): Promise<void> {
  const row = await lockRootUsageReservation(tx, identity)
  if (row.status === "released") return
  if (row.status !== "reserved") throw new RootUsageReservationError("usage_attempt_started")
  await tx.$queryRaw(Prisma.sql`
    UPDATE "agent_root_usage_reservations" SET "status" = 'released', "releasedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${row.id} AND "status" = 'reserved'`)
}

export async function settleRootOutputReservation(
  tx: RootUsageQuery,
  identity: RootUsageReservationRef,
  outcome: { status: "success" | "error"; outputTokens: number | null; errorCode: string | null },
): Promise<void> {
  const row = await lockRootUsageReservation(tx, identity)
  if (row.status === "settled") {
    if (row.actualOutputTokens !== outcome.outputTokens || row.outcomeStatus !== outcome.status || row.errorCode !== outcome.errorCode) {
      throw new RootUsageReservationError("usage_settlement_conflict")
    }
    return
  }
  if (row.status !== "started") throw new RootUsageReservationError("usage_attempt_not_started")
  if (row.outcomeStatus !== null && (row.outcomeStatus !== outcome.status || row.errorCode !== outcome.errorCode)) {
    throw new RootUsageReservationError("usage_settlement_conflict")
  }
  if (outcome.outputTokens === null) {
    await tx.$queryRaw(Prisma.sql`
      UPDATE "agent_root_usage_reservations" SET "outcomeStatus" = ${outcome.status}, "errorCode" = ${outcome.errorCode}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${row.id} AND "status" = 'started' AND "outcomeStatus" IS NULL`)
    return
  }
  if (!Number.isSafeInteger(outcome.outputTokens) || outcome.outputTokens < 0) throw new RootUsageReservationError("usage_settlement_invalid", 400)
  await tx.$queryRaw(Prisma.sql`
    UPDATE "agent_root_usage_reservations" SET "status" = 'settled', "actualOutputTokens" = ${outcome.outputTokens},
      "outcomeStatus" = ${outcome.status}, "errorCode" = ${outcome.errorCode}, "settledAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${row.id} AND "status" = 'started'`)
}
