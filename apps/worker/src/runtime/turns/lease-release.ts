import type pg from "pg"
import { OPEN_SESSION } from "../session-gate.js"
import { acquireRootTaskHistoryChronologyLock, appendRootTaskHistoryChronologyWitness, readRootTaskHistoryChronologyWitness } from "../context/root-task-history-chronology-witness.js"
import type { LeasePool, LeaseReleaseStatus, TurnLease } from "./lease.js"
import { hasPersistedNoProgressTerminalReceipt, LeaseUnavailable, transaction, withOpenLease } from "./lease-transaction.js"

type Row = Record<string, unknown>
type Client = pg.PoolClient
function conflict(): Error {
  const error = new Error("TurnEngine persistence conflict: root terminal chronology receipt")
  error.name = "TurnEnginePersistenceConflict"
  return error
}
function terminalRoot(row: Row | undefined, rootTaskId: string, status: "failed" | "interrupted"): boolean {
  return !!row && row.id === rootTaskId && row.rootTaskId === rootTaskId && row.parentTaskId === null
    && row.role === "orchestrator" && row.taskType === "root" && row.status === status
    && row.leaseOwner === null && row.leaseExpiresAt === null && Number(row.attemptCount) === 1
    && row.completedAt != null && row.closedAt == null && row.nextAttemptAt == null
}
async function sessionLock(client: Client, current: TurnLease): Promise<void> {
  const result = await client.query(`SELECT session."id" FROM "agent_sessions" AS session
    WHERE session."id"=$1 AND session."userId"=$2 AND ${OPEN_SESSION} FOR UPDATE`, [current.sessionId, current.userId])
  if (!result.rows[0]) throw new LeaseUnavailable("Turn session is no longer open")
}
async function appendTerminalWitness(client: Client, current: TurnLease, status: "failed" | "interrupted", rootTaskId: unknown, lock: Awaited<ReturnType<typeof acquireRootTaskHistoryChronologyLock>>): Promise<void> {
  if (typeof rootTaskId !== "string" || !rootTaskId.trim()) return
  const rootResult = await client.query<Row>(`SELECT "id","rootTaskId","parentTaskId","role","taskType","status","leaseOwner","leaseExpiresAt",
    "attemptCount","completedAt","closedAt","nextAttemptAt" FROM "sub_agent_tasks"
    WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "rootTaskId"=$1 FOR UPDATE`, [rootTaskId, current.sessionId, current.turnId])
  if (rootResult.rows.length !== 1 || !terminalRoot(rootResult.rows[0], rootTaskId, status)) return
  const type = status === "failed" ? "turn.failed" : "turn.interrupted"
  const key = status === "failed" ? `turn:${current.turnId}:event:turn-failed:` : `turn:${current.turnId}:event:turn-interrupted`
  const events = await client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "taskId"=$3
    AND "type"=$4 AND "actor"='orchestrator' AND "correlationId"=$2
    AND (("type"='turn.failed' AND left("idempotencyKey",char_length($5))=$5) OR ("type"='turn.interrupted' AND "idempotencyKey"=$5))
    AND "payload"->>'turnId'=$2 AND "payload"->>'taskId'=$3 FOR SHARE`,
  [current.sessionId, current.turnId, rootTaskId, type, key])
  if (events.rows.length !== 1 || typeof events.rows[0]?.id !== "string") return
  const input = { userId: current.userId, sessionId: current.sessionId, turnId: current.turnId, rootTaskId,
    boundary: "root_terminal" as const, boundaryEventId: events.rows[0].id }
  if (await readRootTaskHistoryChronologyWitness(client, input)) return
  await appendRootTaskHistoryChronologyWitness(client, input, lock)
}
async function noProgressReplayWitness(client: Client, current: TurnLease): Promise<void> {
  if (!await hasPersistedNoProgressTerminalReceipt(client, current)) throw new LeaseUnavailable("Turn lease is no longer owned")
  const rows = await client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2
    AND "idempotencyKey"=$3 AND "type"='turn.failed' AND "actor"='orchestrator' AND "taskId" IS NOT NULL FOR SHARE`,
  [current.sessionId, current.turnId, `turn:${current.turnId}:event:turn-failed:no_progress`])
  if (rows.rows.length !== 1 || typeof rows.rows[0]?.id !== "string") throw conflict()
  const rootTaskId = await client.query<Row>(`SELECT "rootTaskId" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 AND "leaseVersion"=$4`,
    [current.turnId, current.sessionId, current.userId, current.leaseVersion])
  if (typeof rootTaskId.rows[0]?.rootTaskId !== "string") throw conflict()
  await readRootTaskHistoryChronologyWitness(client, { userId: current.userId, sessionId: current.sessionId, turnId: current.turnId,
    rootTaskId: rootTaskId.rows[0].rootTaskId, boundary: "root_terminal", boundaryEventId: rows.rows[0].id })
}
async function terminalRelease(pool: LeasePool, current: TurnLease, status: "failed" | "interrupted", now: Date): Promise<boolean> {
  return transaction(pool, current.userId, async client => {
    const chronologyLock = await acquireRootTaskHistoryChronologyLock(client, current.userId)
    await sessionLock(client, current)
    const result = await client.query<Row>(`UPDATE "agent_turns"
      SET "status"=$5,"leaseOwnerId"=NULL,"leaseExpiresAt"=NULL,"leaseStartedAt"=NULL,
        "revision"="revision"+CASE WHEN "status"=$5 THEN 0 ELSE 1 END,"completedAt"=$6,"updatedAt"=$6
      WHERE "id"=$1 AND "sessionId"=$2 AND "leaseOwnerId"=$3 AND "leaseVersion"=$4 AND "userId"=$7 AND "leaseExpiresAt">$6
        AND ("status"='in_progress' OR ("status"='waiting_for_user' AND $5='waiting_for_user')
          OR ("status"='waiting_for_approval' AND $5='waiting_for_approval')) RETURNING "rootTaskId"`,
    [current.turnId, current.sessionId, current.ownerId, current.leaseVersion, status, now, current.userId])
    if (result.rowCount !== 1) {
      if (status === "failed") { await noProgressReplayWitness(client, current); return true }
      throw new LeaseUnavailable("Turn lease is no longer owned")
    }
    await client.query(`UPDATE "agent_inputs" SET "status"='cancelled',"cancelledAt"=$4
      WHERE "sessionId"=$1 AND "userId"=$2 AND "targetTurnId"=$3 AND "delivery"='follow_up'
        AND "status" IN ('accepted','queued','consumed') AND "cancelledAt" IS NULL`,
    [current.sessionId, current.userId, current.turnId, now])
    await appendTerminalWitness(client, current, status, result.rows[0]?.rootTaskId, chronologyLock)
    return true
  }).catch((error: unknown) => {
    if (error instanceof LeaseUnavailable) return false
    throw error
  })
}

export async function releaseTurnLease(pool: LeasePool, current: TurnLease, status: LeaseReleaseStatus, now = new Date()): Promise<boolean> {
  if (status === "failed" || status === "interrupted") return terminalRelease(pool, current, status, now)
  return withOpenLease(pool, current, false, async client => {
    const result = await client.query(`UPDATE "agent_turns"
      SET "status"=$5,"leaseOwnerId"=NULL,"leaseExpiresAt"=NULL,"leaseStartedAt"=NULL,
        "revision"="revision"+CASE WHEN "status"=$5 THEN 0 ELSE 1 END,
        "completedAt"=CASE WHEN $5 IN ('interrupted','failed','completed') THEN $6 ELSE NULL END,"updatedAt"=$6
      WHERE "id"=$1 AND "sessionId"=$2 AND "leaseOwnerId"=$3 AND "leaseVersion"=$4 AND "userId"=$7 AND "leaseExpiresAt">$6
        AND ("status"='in_progress' OR ("status"='waiting_for_user' AND $5='waiting_for_user')
          OR ("status"='waiting_for_approval' AND $5='waiting_for_approval'))`,
    [current.turnId, current.sessionId, current.ownerId, current.leaseVersion, status, now, current.userId])
    if (result.rowCount !== 1) {
      if (status === "completed") {
        const receipt = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3
          AND "leaseVersion"=$4 AND "status"='completed' AND "leaseOwnerId" IS NULL AND "leaseExpiresAt" IS NULL`,
        [current.turnId, current.sessionId, current.userId, current.leaseVersion])
        if (receipt.rows[0]) return true
      }
      throw new LeaseUnavailable("Turn lease is no longer owned")
    }
    return true
  })
}
