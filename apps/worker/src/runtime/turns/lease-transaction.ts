import type pg from "pg"

import { OPEN_SESSION } from "../session-gate.js"
import type { LeasePool, TurnLease } from "./lease.js"

export class LeaseUnavailable extends Error {}

async function rollback(client: pg.PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined)
}

export async function transaction<T>(pool: LeasePool, userId: string | null, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await work(client)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await rollback(client)
    throw error
  } finally {
    client.release()
  }
}

async function lockOpenSession(client: pg.PoolClient, sessionId: string, userId: string): Promise<void> {
  const result = await client.query(
    `SELECT session."id" FROM "agent_sessions" AS session
     WHERE session."id" = $1 AND session."userId" = $2 AND ${OPEN_SESSION}
     FOR UPDATE`,
    [sessionId, userId],
  )
  if (!result.rows[0] && result.rowCount !== 1) throw new LeaseUnavailable("Turn session is no longer open")
}

export async function withOpenLease<T>(pool: LeasePool, current: TurnLease, fallback: T, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await transaction(pool, current.userId, async client => {
      await lockOpenSession(client, current.sessionId, current.userId)
      return work(client)
    })
  } catch (error: unknown) {
    if (error instanceof LeaseUnavailable) return fallback
    throw error
  }
}

export async function hasPersistedNoProgressTerminalReceipt(client: pg.PoolClient, current: TurnLease): Promise<boolean> {
  const result = await client.query<{ id: string }>(`SELECT turn."id"
    FROM "agent_turns" AS turn
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
      AND root."turnId" = turn."id" AND root."rootTaskId" = root."id"
    JOIN "agent_steps" AS step ON step."sessionId" = turn."sessionId" AND step."turnId" = turn."id" AND step."taskId" = root."id"
      AND step."attempt" = 1 AND step."status" = 'failed' AND step."errorCode" = 'no_progress'
      AND step."inputTokens" = 0 AND step."outputTokens" = 0 AND step."estimatedCostUsd" = 0
    JOIN "agent_events" AS step_start ON step_start."sessionId" = turn."sessionId" AND step_start."turnId" = turn."id"
      AND step_start."taskId" = root."id" AND step_start."type" = 'step.started' AND step_start."actor" = 'orchestrator'
      AND step_start."correlationId" = step."id" AND step_start."itemId" IS NULL
      AND step_start."idempotencyKey" = 'turn:' || turn."id" || ':event:step-started:' || step."id"
      AND step_start."payload" = jsonb_build_object('stepId', step."id", 'ordinal', step."ordinal", 'taskId', root."id")
    JOIN "agent_events" AS step_failed ON step_failed."sessionId" = turn."sessionId" AND step_failed."turnId" = turn."id"
      AND step_failed."taskId" = root."id" AND step_failed."type" = 'step.completed' AND step_failed."actor" = 'orchestrator'
      AND step_failed."correlationId" = step."id" AND step_failed."itemId" IS NULL
      AND step_failed."idempotencyKey" = 'turn:' || turn."id" || ':event:step-failed:' || step."id"
      AND step_failed."payload" = jsonb_build_object('stepId', step."id", 'status', 'failed', 'errorCode', 'no_progress', 'taskId', root."id")
      AND step_failed."causationId" = step_start."id"
    JOIN "agent_events" AS no_progress ON no_progress."sessionId" = turn."sessionId" AND no_progress."turnId" = turn."id"
      AND no_progress."taskId" = root."id" AND no_progress."type" = 'turn.no_progress' AND no_progress."actor" = 'orchestrator'
      AND no_progress."correlationId" = turn."id" AND no_progress."itemId" IS NULL
      AND no_progress."idempotencyKey" = 'turn:' || turn."id" || ':event:turn-no-progress'
      AND no_progress."payload" = jsonb_build_object('reasonCode', 'repeated_signature', 'signature', 'task_graph_terminal_denial',
        'stateFingerprint', 'task_graph_terminal_denial', 'taskId', root."id")
      AND no_progress."causationId" = step_failed."id"
    JOIN "agent_items" AS final_item ON final_item."sessionId" = turn."sessionId" AND final_item."turnId" = turn."id"
      AND final_item."taskId" = root."id" AND final_item."stepId" = step."id" AND final_item."type" = 'agent_message'
      AND final_item."status" = 'completed' AND final_item."phase" = 'final_answer' AND final_item."revision" = 1
    JOIN "agent_events" AS final_started ON final_started."sessionId" = turn."sessionId" AND final_started."turnId" = turn."id"
      AND final_started."taskId" = root."id" AND final_started."type" = 'item.started' AND final_started."actor" = 'orchestrator'
      AND final_started."itemId" = final_item."id" AND final_started."correlationId" = step."id"
      AND final_started."idempotencyKey" = 'turn:' || turn."id" || ':event:item-started:' || final_item."id"
      AND final_started."payload" = jsonb_build_object('itemId', final_item."id", 'type', 'agent_message', 'phase', 'final_answer')
      AND final_started."causationId" = no_progress."id"
    JOIN "agent_events" AS final_completed ON final_completed."sessionId" = turn."sessionId" AND final_completed."turnId" = turn."id"
      AND final_completed."taskId" = root."id" AND final_completed."type" = 'item.completed' AND final_completed."actor" = 'orchestrator'
      AND final_completed."itemId" = final_item."id" AND final_completed."correlationId" = final_item."id"
      AND final_completed."idempotencyKey" = 'turn:' || turn."id" || ':event:final-completed:' || final_item."id" || ':1'
      AND final_completed."payload" = jsonb_build_object('itemId', final_item."id", 'status', 'completed', 'content', final_item."content")
      AND final_completed."causationId" = final_started."id"
    JOIN "agent_events" AS turn_failed ON turn_failed."sessionId" = turn."sessionId" AND turn_failed."turnId" = turn."id"
      AND turn_failed."taskId" = root."id" AND turn_failed."type" = 'turn.failed' AND turn_failed."actor" = 'orchestrator'
      AND turn_failed."itemId" = final_item."id" AND turn_failed."correlationId" = turn."id"
      AND turn_failed."idempotencyKey" = 'turn:' || turn."id" || ':event:turn-failed:no_progress'
      AND turn_failed."causationId" = final_completed."id"
      AND turn_failed."payload" = jsonb_build_object('turnId', turn."id", 'taskId', root."id", 'errorCode', 'no_progress',
        'finalItemId', final_item."id", 'final', turn_failed."payload"->'final')
      AND turn_failed."payload"->'final'->>'schemaVersion' = 'agent-harness.v2.final'
      AND turn_failed."payload"->'final'->>'terminalReason' = 'no_progress'
      AND turn_failed."payload"->'final'->'completed' = 'false'::jsonb
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."leaseVersion" = $4
      AND turn."status" = 'failed' AND turn."error" = 'no_progress' AND turn."finalResponse" IS NOT NULL AND turn."completedAt" IS NOT NULL
      AND turn."leaseOwnerId" IS NULL AND turn."leaseExpiresAt" IS NULL AND turn."leaseStartedAt" IS NULL
      AND root."status" = 'failed' AND root."failureReason" = 'no_progress' AND root."leaseOwner" IS NULL
      AND root."leaseExpiresAt" IS NULL AND root."completedAt" IS NOT NULL AND root."attemptCount" = 1
      AND jsonb_typeof(root."result") = 'object' AND jsonb_typeof(root."result"->'stepCount') = 'number'
      AND jsonb_typeof(root."result"->'toolCallCount') = 'number' AND root."result"->'waitId' = 'null'::jsonb
      AND root."result" = jsonb_build_object('status', 'failed', 'stepCount', root."result"->'stepCount',
        'toolCallCount', root."result"->'toolCallCount', 'finalItemId', final_item."id", 'waitId', 'null'::jsonb)
      AND final_item."content" = jsonb_build_object('text', turn_failed."payload"->'final'->'response', 'final', turn_failed."payload"->'final')
      AND turn_failed."payload"->'final' = turn."finalResponse"::jsonb
      AND step_start."sequence" < step_failed."sequence" AND step_failed."sequence" < no_progress."sequence"
      AND no_progress."sequence" < final_started."sequence" AND final_started."sequence" < final_completed."sequence"
      AND final_completed."sequence" < turn_failed."sequence"`,
  [current.turnId, current.sessionId, current.userId, current.leaseVersion])
  return result.rows[0]?.id === current.turnId
}
