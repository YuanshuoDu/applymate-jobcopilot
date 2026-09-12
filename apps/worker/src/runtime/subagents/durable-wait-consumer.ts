import { redactSensitiveText, redactSensitiveValue } from "@jobcopilot/shared"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type pg from "pg"

import type { TurnLease } from "../turns/lease.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Projection = { readonly id: string; readonly content: RepositoryJsonValue }

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const MAX_RESULT_BYTES = 8 * 1024

export type DurableWaitConsumerInput = {
  readonly client: Queryable
  readonly lease: TurnLease
  readonly turn: Row
  readonly now: Date
}

function object(value: unknown): Row {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return {} } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {}
}
function ids(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return [] } })() : value
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : []
}
function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed : null
}
function fence(input: DurableWaitConsumerInput): void {
  const { lease, turn, now } = input
  if (String(turn.id) !== lease.turnId || String(turn.userId) !== lease.userId || String(turn.sessionId) !== lease.sessionId
    || String(turn.status) !== "in_progress" || String(turn.leaseOwnerId) !== lease.ownerId
    || Number(turn.leaseVersion) !== lease.leaseVersion || (date(turn.leaseExpiresAt)?.getTime() ?? 0) <= now.getTime()) {
    throw new Error("wait_consume_turn_fenced")
  }
}
function projection(wait: Row, outcome: RepositoryJsonValue): Projection {
  return {
    id: `wait-result:${String(wait.id)}`,
    content: {
      toolCallId: `wait:${String(wait.id)}`, toolName: "wait_subagents", input: { taskIds: ids(wait.targetTaskIds), mode: String(wait.mode) },
      status: "completed", output: outcome, errorCode: null,
    },
  }
}
function safeResult(value: unknown): RepositoryJsonValue {
  const redacted = redactSensitiveValue(value)
  const encoded = JSON.stringify(redacted)
  const bytes = Buffer.byteLength(encoded, "utf8")
  if (bytes <= MAX_RESULT_BYTES) return redacted
  return { truncated: true, byteLength: bytes, summary: redactSensitiveText(encoded.slice(0, 1_000)) }
}
function outcome(wait: Row, targets: readonly Row[]): RepositoryJsonValue {
  const targetIds = ids(wait.targetTaskIds).sort()
  const byId = new Map(targets.map(target => [String(target.id), target]))
  return {
    waitId: String(wait.id), status: String(wait.status), matchedTaskIds: ids(wait.matchedTaskIds).sort(), targetTaskIds: targetIds,
    tasks: targetIds.map(taskId => {
      const target = byId.get(taskId)
      return {
        taskId, status: String(target?.status ?? "unknown"),
        result: safeResult(target?.result ?? null),
        failureReason: target?.failureReason === null || target?.failureReason === undefined ? null : redactSensitiveText(String(target.failureReason)).slice(0, 500),
      }
    }),
  }
}
function storedOutcome(wait: Row): RepositoryJsonValue | null {
  const value = object(wait.result).outcome
  return value && typeof value === "object" && !Array.isArray(value) ? redactSensitiveValue(value) : null
}

/** Consumes ready waits once while the newly claimed parent Turn is locked. */
export async function consumeDurableWaitOutcomes(input: DurableWaitConsumerInput): Promise<readonly Projection[]> {
  fence(input)
  if (typeof input.turn.rootTaskId !== "string" || input.turn.rootTaskId.length === 0) return []
  const waits = await input.client.query<Row>(
    `SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "targetTaskIds", "mode", "status", "matchedTaskIds", "result", "suspendedAt", "consumedAt"
     FROM "agent_wait_conditions"
     WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3
       AND "parentTaskId" = $4 AND "status" IN ('ready', 'timed_out') AND "suspendedAt" IS NOT NULL
       AND ("consumedAt" IS NULL OR ("result" ? 'outcome'))
     ORDER BY "resolvedAt" ASC NULLS LAST, "id" ASC FOR UPDATE`,
    [input.lease.userId, input.lease.sessionId, input.lease.turnId, input.turn.rootTaskId],
  )
  const projections: Projection[] = []
  for (const wait of waits.rows) {
    const prior = wait.consumedAt ? storedOutcome(wait) : null
    if (prior) { projections.push(projection(wait, prior)); continue }
    const parent = (await input.client.query<Row>(
      `SELECT task."id", task."rootTaskId", task."turnId", task."sessionId", session."userId" AS "userId"
       FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
       WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4 FOR SHARE`,
      [wait.parentTaskId, input.lease.sessionId, input.lease.turnId, input.lease.userId],
    )).rows[0]
    if (!parent || String(parent.id) !== input.turn.rootTaskId || String(parent.rootTaskId ?? parent.id) !== input.turn.rootTaskId) continue
    const step = (await input.client.query<Row>(
      `SELECT "id", "taskId", "attempt", "status" FROM "agent_steps"
       WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3 AND ("taskId" = $4 OR "taskId" IS NULL) FOR SHARE`,
      [wait.stepId, input.lease.turnId, input.lease.sessionId, input.turn.rootTaskId],
    )).rows[0]
    if (!step || String(step.status) !== "waiting_for_tool" || Number(step.attempt) !== 1) continue
    const targetIds = ids(wait.targetTaskIds)
    if (targetIds.length === 0 || targetIds.length > 8) continue
    const targets = await input.client.query<Row>(
      `SELECT task."id", task."rootTaskId", task."turnId", task."sessionId", task."status", task."result", task."failureReason", session."userId" AS "userId"
       FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
       WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4`,
      [targetIds, input.lease.sessionId, input.lease.turnId, input.lease.userId],
    )
    if (targets.rows.length !== targetIds.length || targets.rows.some(target => String(target.rootTaskId ?? target.id) !== input.turn.rootTaskId || String(target.id) === input.turn.rootTaskId)) continue
    const value = outcome(wait, targets.rows)
    const updated = await input.client.query(
      `UPDATE "agent_wait_conditions" SET "result" = jsonb_set(COALESCE("result", '{}'::jsonb), '{outcome}', $1::jsonb, true),
         "consumedAt" = $2, "updatedAt" = $2
       WHERE "id" = $3 AND "userId" = $4 AND "sessionId" = $5 AND "turnId" = $6 AND "consumedAt" IS NULL
       RETURNING "id"`,
      [JSON.stringify(value), input.now, wait.id, input.lease.userId, input.lease.sessionId, input.lease.turnId],
    )
    if (updated.rowCount === 1) projections.push(projection(wait, value))
  }
  return projections
}
