import type pg from "pg"

import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import {
  type PgSubagentPool,
  type SubagentTaskRecord,
} from "./types.js"
import { rowToTask, transaction } from "./pg-store-persistence.js"
import { RUNNABLE_SESSION } from "../session-gate.js"

const SELECT_RECOVERABLE = `SELECT task.*, session."userId" AS "userId", session."status" AS "sessionStatus"
  FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
  WHERE task."status" = 'running'
    AND (session."status" IN ('aborted', 'archived') OR ${RUNNABLE_SESSION})
    AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= $1)
    AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP)
  ORDER BY task."updatedAt" ASC, task."id" ASC`

export async function interruptTree(
  pool: PgSubagentPool,
  input: { sessionId: string; rootTaskId: string; now: Date },
): Promise<number> {
  const client = await pool.connect()
  try {
    const result = await client.query(`UPDATE "sub_agent_tasks" SET
      "interruptRequestedAt" = COALESCE("interruptRequestedAt", $3),
      "status" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE "status" END,
      "nextAttemptAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE "nextAttemptAt" END,
      "completedAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $3 ELSE "completedAt" END,
      "updatedAt" = $3 WHERE "sessionId" = $1 AND "rootTaskId" = $2
        AND "status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')`, [input.sessionId, input.rootTaskId, input.now])
    return result.rowCount ?? 0
  } finally { client.release() }
}

export async function interruptTurn(
  pool: PgSubagentPool,
  input: { userId: string; sessionId: string; turnId: string; now: Date },
): Promise<number> {
  const client = await pool.connect()
  try {
    const result = await client.query(`UPDATE "sub_agent_tasks" AS task SET
      "interruptRequestedAt" = COALESCE(task."interruptRequestedAt", $4),
      "status" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE task."status" END,
      "nextAttemptAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE task."nextAttemptAt" END,
      "completedAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $4 ELSE task."completedAt" END,
      "updatedAt" = $4
      FROM "agent_sessions" AS session
      WHERE task."sessionId" = $1 AND task."turnId" = $2 AND session."id" = task."sessionId"
        AND session."userId" = $3 AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')`,
    [input.sessionId, input.turnId, input.userId, input.now])
    return result.rowCount ?? 0
  } finally { client.release() }
}

export async function interruptSubtree(
  pool: PgSubagentPool,
  input: { sessionId: string; rootTaskId: string; targetPath: string; now: Date },
): Promise<number> {
  return transaction(pool, async client => {
    const session = await client.query(`SELECT "id", "status" FROM "agent_sessions"
      WHERE "id" = $1 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [input.sessionId])
    const sessionStatus = String(session.rows[0]?.status ?? "")
    if (!session.rows[0] || sessionStatus === "aborted" || sessionStatus === "archived") return 0
    const result = await client.query(`UPDATE "sub_agent_tasks" SET
      "interruptRequestedAt" = COALESCE("interruptRequestedAt", $4),
      "status" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE "status" END,
      "nextAttemptAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE "nextAttemptAt" END,
      "completedAt" = CASE WHEN "status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $4 ELSE "completedAt" END,
      "updatedAt" = $4 WHERE "sessionId" = $1 AND "rootTaskId" = $2
        AND ("path" = $3 OR "path" LIKE $3 || '/%')
        AND "status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')`,
    [input.sessionId, input.rootTaskId, input.targetPath, input.now])
    return result.rowCount ?? 0
  })
}

export async function recoverExpired(
  pool: PgSubagentPool,
  input: { now: Date; limit: number },
): Promise<SubagentTaskRecord[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new RangeError("Recovery limit must be positive")
  return transaction(pool, async client => {
    const rows = await client.query(`${SELECT_RECOVERABLE} LIMIT $2 FOR UPDATE SKIP LOCKED`, [input.now, input.limit])
    const recovered: SubagentTaskRecord[] = []
    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const sessionClosed = row.sessionStatus === "aborted" || row.sessionStatus === "archived"
      const interrupted = sessionClosed || row.interruptRequestedAt !== null
      const terminal = interrupted || Number(row.attemptCount) >= Number(row.maxAttempts)
      const status = terminal ? (interrupted ? "interrupted" : "failed") : "queued"
      const nextAttemptAt = terminal ? null : computeSubagentNextAttemptAt(Number(row.attemptCount), input.now)
      await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
        "nextAttemptAt" = $4, "completedAt" = CASE WHEN $5 THEN $6 ELSE NULL END, "updatedAt" = $6 WHERE "id" = $1 AND "sessionId" = $2`,
      [row.id, row.sessionId, status, nextAttemptAt, terminal, input.now])
      recovered.push({ ...rowToTask(row), status, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null })
    }
    return recovered
  })
}
