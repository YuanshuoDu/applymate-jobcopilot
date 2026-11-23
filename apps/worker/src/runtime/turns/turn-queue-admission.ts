import { getApprovedFillTerminalClaim, type ApprovedFillTerminalClaimFallback } from "./approved-fill-terminal-claim.js"
import { claimTurnLease, TurnLeaseError, type LeasePool, type TurnJobPayload, type TurnLease } from "./lease.js"

export async function claimTurnLeaseWithApprovedFillFallback(input: {
  readonly pool: LeasePool
  readonly payload: TurnJobPayload
  readonly now: Date
  readonly leaseMs: number
  readonly dispatchGeneration?: number
  readonly approvedFillFallback?: ApprovedFillTerminalClaimFallback
}): Promise<TurnLease> {
  try {
    return await claimTurnLease(input.pool, input.payload, input.now, input.leaseMs)
  } catch (error: unknown) {
    if (!(error instanceof TurnLeaseError) || error.code !== "lease_not_available" || !input.approvedFillFallback) throw error
    const lease = await input.approvedFillFallback({ pool: input.pool, payload: input.payload, now: input.now,
      leaseMs: input.leaseMs, dispatchGeneration: input.dispatchGeneration })
    if (!lease) throw error
    if (!getApprovedFillTerminalClaim(lease)) throw new Error("approved_fill_terminal_claim_marker_missing")
    return lease
  }
}

export function dispatchGenerationFromJobId(jobId: unknown, turnId: string): number | undefined {
  if (typeof jobId !== "string") return undefined
  const prefix = `agent-turn-${Buffer.from(turnId, "utf8").toString("base64url")}-`
  if (!jobId.startsWith(prefix)) return undefined
  const suffix = jobId.slice(prefix.length)
  if (!/^(0|[1-9][0-9]*)$/.test(suffix)) return undefined
  const generation = Number(suffix)
  return Number.isSafeInteger(generation) ? generation : undefined
}

export async function markTurnDispatchClaimed(pool: LeasePool, payload: TurnJobPayload): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(
      `UPDATE "agent_outbox"
       SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
       WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1
         AND "aggregateId" = $2 AND "publishedAt" IS NULL`,
      ["turn-dispatch:" + payload.turnId, payload.sessionId],
    )
  } finally {
    client.release()
  }
}

export async function assertCanonicalAutomationMode(pool: LeasePool, payload: TurnJobPayload): Promise<void> {
  const client = await pool.connect()
  try {
    const result = await client.query<{ source: string; executionMode: string | null }>(
      `SELECT turn."source", turn."executionMode"
       FROM "agent_turns" AS turn
       JOIN "agent_sessions" AS session
         ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
       WHERE turn."id" = $1 AND turn."sessionId" = $2`,
      [payload.turnId, payload.sessionId],
    )
    const row = result.rows[0]
    if (row?.source === "automation" && row.executionMode !== "canonical_task_graph") {
      const error = new Error("Canonical Turn queue rejected an automation Turn without a canonical execution pin")
      error.name = "AgentRunModeQueueError"
      Object.assign(error, { code: "automation_mode_not_canonical" })
      throw error
    }
  } finally {
    client.release()
  }
}
