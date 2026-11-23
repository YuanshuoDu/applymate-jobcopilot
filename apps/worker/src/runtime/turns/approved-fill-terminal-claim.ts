import type pg from "pg"
import { readCanonicalApprovedApplicationSubmitResumeProof, type CanonicalApprovedApplicationSubmitResumeProof } from "../canonical-approved-application-submit-resume-proof.js"
import { LeaseUnavailable, transaction } from "./lease-transaction.js"
import { parseTurnJobPayload, TURN_MAX_LEASE_MS, type LeasePool, type TurnJobPayload, type TurnLease } from "./lease.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Claimed = Readonly<{ lease: TurnLease; proof: CanonicalApprovedApplicationSubmitResumeProof }>
const claims = new WeakMap<TurnLease, CanonicalApprovedApplicationSubmitResumeProof>()
const requeues = new WeakMap<ApprovedFillTerminalClaimRequeue, TurnLease>()

export type ApprovedFillTerminalClaimFallback = (input: {
  readonly pool: LeasePool
  readonly payload: TurnJobPayload
  readonly now: Date
  readonly leaseMs: number
  readonly dispatchGeneration?: number
}) => Promise<TurnLease | null>

export class ApprovedFillTerminalClaimRequeue extends Error {
  readonly reasonCode = "approved_application_fill_resume_proof_changed" as const
  constructor() {
    super("Approved application Fill proof changed after its terminal-only lease claim")
    this.name = "ApprovedFillTerminalClaimRequeue"
  }
}

export function approvedFillTerminalClaimRequeue(lease: TurnLease): ApprovedFillTerminalClaimRequeue {
  if (!claims.has(lease)) throw new Error("approved_fill_terminal_claim_marker_missing")
  const error = new ApprovedFillTerminalClaimRequeue()
  requeues.set(error, lease)
  return error
}

export function isApprovedFillTerminalClaimRequeue(error: unknown, lease: TurnLease): error is ApprovedFillTerminalClaimRequeue {
  return error instanceof ApprovedFillTerminalClaimRequeue && requeues.get(error) === lease && claims.has(lease)
}

/** Returns the private, same-process witness only for the exact lease object that was claimed. */
export function getApprovedFillTerminalClaim(lease: TurnLease): CanonicalApprovedApplicationSubmitResumeProof | undefined {
  return claims.get(lease)
}

/** Claims only a queued Fill Turn resumed from its exact approved submission Wait. */
export async function claimApprovedFillTerminalLease(input: {
  readonly pool: LeasePool
  readonly payload: TurnJobPayload
  readonly now: Date
  readonly leaseMs: number
  readonly dispatchGeneration?: number
}): Promise<TurnLease | null> {
  const { pool, payload, now, leaseMs, dispatchGeneration } = input
  if (!parseTurnJobPayload(payload) || !validDate(now) || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > TURN_MAX_LEASE_MS) return null
  let claimed: Claimed
  try {
    claimed = await transaction(pool, null, async client => {
      const session = await client.query<{ userId: string }>(
        `SELECT session."userId" FROM "agent_sessions" AS session
         WHERE session."id" = $1 AND session."status" = 'waiting_for_user'
           AND EXISTS (SELECT 1 FROM "agent_turns" AS turn
             WHERE turn."id" = $2 AND turn."sessionId" = session."id" AND turn."userId" = session."userId")
         FOR UPDATE`,
        [payload.sessionId, payload.turnId],
      )
      if (session.rows.length !== 1 || !validId(session.rows[0]?.userId)) throw new LeaseUnavailable("Approved Fill session is not claimable")
      const userId = session.rows[0]!.userId
      await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
      const update = await client.query<Row>(
        `UPDATE "agent_turns" AS turn
         SET "status" = 'in_progress', "leaseOwnerId" = $4, "leaseStartedAt" = $5,
             "leaseExpiresAt" = $5 + ($6 * INTERVAL '1 millisecond'),
             "leaseVersion" = turn."leaseVersion" + 1, "revision" = turn."revision" + 1,
             "startedAt" = COALESCE(turn."startedAt", $5), "updatedAt" = $5
         WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
           AND turn."status" = 'queued' AND (turn."leaseOwnerId" IS NULL OR turn."leaseExpiresAt" <= $5)
           AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
             WHERE session."id" = turn."sessionId" AND session."userId" = turn."userId"
               AND session."status" = 'waiting_for_user'
               AND NOT EXISTS (
                 SELECT 1 FROM "agent_events" AS pause_request
                 WHERE pause_request."sessionId" = session."id" AND pause_request."turnId" = $1
                   AND pause_request."type" = 'session.pause_requested'
                   AND NOT EXISTS (
                     SELECT 1 FROM "agent_events" AS resumed
                     WHERE resumed."sessionId" = pause_request."sessionId" AND resumed."turnId" = pause_request."turnId"
                       AND resumed."type" = 'session.resume_requested' AND resumed."sequence" > pause_request."sequence"
                   )
               ))
         RETURNING turn."id", turn."sessionId", turn."userId", turn."rootTaskId", turn."leaseOwnerId",
                   turn."leaseVersion", turn."leaseStartedAt", turn."leaseExpiresAt"`,
        [payload.turnId, payload.sessionId, userId, payload.ownerId, now, leaseMs],
      )
      if (update.rows.length !== 1) throw new LeaseUnavailable("Approved Fill Turn is no longer queued")
      const lease = turnLease(update.rows[0]!, payload)
      const rootTaskId = update.rows[0]!.rootTaskId
      if (!lease || !validId(rootTaskId)) throw new LeaseUnavailable("Approved Fill lease identity is invalid")
      const proof = await readCanonicalApprovedApplicationSubmitResumeProof(client, { lease, rootTaskId, now })
      if (!proof || proof.state !== "form_filled" || proof.workerTaskId !== null || proof.outboxId !== null
        || proof.rootTaskId !== rootTaskId
        || !await exactApprovedWakeupReplay(client, { lease, payload, proof, dispatchGeneration })) {
        throw new LeaseUnavailable("Approved Fill wakeup proof is unavailable or changed")
      }
      return { lease, proof }
    })
  } catch (error: unknown) {
    if (error instanceof LeaseUnavailable) return null
    throw error
  }
  claims.set(claimed.lease, Object.freeze({ ...claimed.proof }))
  return claimed.lease
}

function turnLease(row: Row, payload: TurnJobPayload): TurnLease | null {
  const leaseStartedAt = date(row.leaseStartedAt), leaseExpiresAt = date(row.leaseExpiresAt)
  const leaseVersion = Number(row.leaseVersion)
  if (row.id !== payload.turnId || row.sessionId !== payload.sessionId || !validId(row.userId)
    || row.leaseOwnerId !== payload.ownerId || !Number.isSafeInteger(leaseVersion) || leaseVersion < 1
    || !leaseStartedAt || !leaseExpiresAt || leaseExpiresAt <= leaseStartedAt) return null
  return { ...payload, userId: row.userId, leaseVersion, leaseStartedAt, leaseExpiresAt }
}

async function exactApprovedWakeupReplay(client: Client, input: {
  readonly lease: TurnLease
  readonly payload: TurnJobPayload
  readonly proof: CanonicalApprovedApplicationSubmitResumeProof
  readonly dispatchGeneration?: number
}): Promise<boolean> {
  const { lease, proof } = input
  const wakeups = await client.query<Row>(
    `SELECT "id", "sessionId", "turnId", "itemId", "taskId", "sequence"::text AS "sequence",
            "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "type" = 'turn.wakeup'
     LIMIT 2 FOR SHARE`,
    [lease.sessionId, lease.turnId, proof.waitItemId],
  )
  if (wakeups.rows.length !== 1) return false
  const wake = wakeups.rows[0]!
  const payload = exact(wake.payload, "answerAvailable,itemId,nextTurnRevision,status,toolCallId,turnId,waitId,waitKind")
  const normalizedWakePayload = payload && (payload.answerAvailable === false || payload.answerAvailable === "[REDACTED]")
    ? { ...payload, answerAvailable: false } : null
  const nextTurnRevision = Number(payload?.nextTurnRevision)
  if (!validId(wake.id) || wake.sessionId !== lease.sessionId || wake.turnId !== lease.turnId || wake.itemId !== proof.waitItemId
    || wake.taskId !== null || wake.type !== "turn.wakeup" || wake.actor !== "user" || wake.correlationId !== lease.turnId
    || !validId(wake.causationId) || !validId(wake.idempotencyKey) || !sequence(wake.sequence)
    || !payload || payload.waitKind !== "approval" || payload.waitId !== proof.approvalId || payload.itemId !== proof.waitItemId
    || payload.turnId !== lease.turnId || payload.status !== "approved" || !normalizedWakePayload
    || !validId(payload.toolCallId) || !Number.isSafeInteger(nextTurnRevision) || nextTurnRevision < 1
    || !validId(wake.idempotencyKey) || !wake.idempotencyKey.startsWith("agent-wait-command:") || !wake.idempotencyKey.endsWith(":wakeup")) return false

  const approvals = await client.query<Row>(
    `SELECT "toolCallId" FROM "agent_approvals"
     WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4
       AND "taskId" = $5 AND "type" = 'submit_application' AND "status" = 'approved'
     LIMIT 2 FOR SHARE`,
    [proof.approvalId, lease.userId, lease.sessionId, lease.turnId, proof.applicationTaskId],
  )
  if (approvals.rows.length !== 1 || approvals.rows[0]?.toolCallId !== payload.toolCallId) return false

  const resolvedRows = await client.query<Row>(
    `SELECT "id", "sessionId", "turnId", "itemId", "taskId", "sequence"::text AS "sequence",
            "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
       AND "itemId" = $4 AND "type" = 'approval.resolved' LIMIT 2 FOR SHARE`,
    [wake.causationId, lease.sessionId, lease.turnId, proof.waitItemId],
  )
  const resolved = resolvedRows.rows[0]
  const resolvedPayload = exact(resolved?.payload, "answerAvailable,itemId,nextTurnRevision,status,toolCallId,turnId,waitId,waitKind")
  if (resolvedRows.rows.length !== 1 || !resolved || resolved.actor !== "user" || resolved.taskId !== proof.applicationTaskId
    || resolved.correlationId !== proof.approvalId || resolved.causationId !== proof.waitItemId
    || resolved.idempotencyKey + ":wakeup" !== wake.idempotencyKey
    || !resolvedPayload || resolvedPayload.answerAvailable !== false
    || !sameValue(resolvedPayload, normalizedWakePayload) || !before(resolved.sequence, wake.sequence)) return false

  const resumedRows = await client.query<Row>(
    `SELECT "id", "sessionId", "turnId", "itemId", "taskId", "sequence"::text AS "sequence",
            "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3
       AND "type" = 'turn.resumed' AND "causationId" = $4 LIMIT 2 FOR SHARE`,
    [lease.sessionId, lease.turnId, proof.waitItemId, wake.id],
  )
  const resumed = resumedRows.rows[0]
  const resumedPayload = exact(resumed?.payload, "itemId,resumedFromEventId,status,toolCallId,turnId,waitId,waitKind")
  if (resumedRows.rows.length !== 1 || !resumed || resumed.taskId !== null || resumed.actor !== "system"
    || resumed.correlationId !== lease.turnId || resumed.idempotencyKey !== "agent-wakeup:" + wake.id + ":resumed"
    || !resumedPayload || resumedPayload.itemId !== proof.waitItemId || resumedPayload.resumedFromEventId !== wake.id
    || resumedPayload.turnId !== lease.turnId || resumedPayload.waitKind !== "approval"
    || resumedPayload.waitId !== proof.approvalId || resumedPayload.toolCallId !== payload.toolCallId
    || resumedPayload.status !== "approved" || !after(resumed.sequence, wake.sequence)) return false

  const dispatches = await client.query<Row>(
    `SELECT "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt", "attemptCount"
     FROM "agent_outbox" WHERE "topic" = 'agent.turn.dispatch'
       AND "aggregateId" = $1 AND "idempotencyKey" = $2 LIMIT 2 FOR SHARE`,
    [lease.sessionId, "turn-dispatch:" + lease.turnId],
  )
  const dispatch = dispatches.rows[0], dispatchPayload = exact(dispatch?.payload, "ownerId,sessionId,turnId")
  const attemptCount = Number(dispatch?.attemptCount), generation = input.dispatchGeneration
  return dispatches.rows.length === 1 && dispatch?.topic === "agent.turn.dispatch" && dispatch.aggregateId === lease.sessionId
    && dispatch.idempotencyKey === "turn-dispatch:" + lease.turnId && Number.isSafeInteger(attemptCount) && attemptCount >= 0
    && Number.isSafeInteger(generation) && generation! >= 0
    && (dispatch.publishedAt == null ? generation === attemptCount : generation === attemptCount - 1)
    && sameValue(dispatchPayload, input.payload) && dispatchPayload?.sessionId === lease.sessionId
    && dispatchPayload.turnId === lease.turnId
}

function exact(value: unknown, keys: string): Row | null {
  const row = record(value)
  return row && Object.keys(row).sort().join(",") === keys ? row : null
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { return Object.getPrototypeOf(parsed) === Object.prototype ? parsed as Row : null } catch { return null }
}
function sameValue(left: unknown, right: unknown): boolean { return stable(left) === stable(right) }
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]"
  const row = record(value)
  return row ? "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + stable(row[key])).join(",") + "}"
    : JSON.stringify(value) ?? "null"
}
function sequence(value: unknown): value is string { return typeof value === "string" && /^[0-9]+$/.test(value) }
function before(left: unknown, right: unknown): boolean { return sequence(left) && sequence(right) && BigInt(left) < BigInt(right) }
function after(left: unknown, right: unknown): boolean { return sequence(left) && sequence(right) && BigInt(left) > BigInt(right) }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function date(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}
