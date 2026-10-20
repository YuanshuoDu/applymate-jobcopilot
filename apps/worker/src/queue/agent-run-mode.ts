import type pg from "pg"

import type { LeasePool } from "../runtime/turns/lease.js"

export const AGENT_RUN_EXECUTION_MODES = ["canonical_task_graph", "legacy_pipeline_adapter"] as const
export type AgentRunExecutionMode = typeof AGENT_RUN_EXECUTION_MODES[number]

export type AgentRunModeIdentity = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
}

export class AgentRunModeError extends Error {
  constructor(readonly code: "owner_mismatch" | "invalid_stored_mode" | "conflicting_evidence") {
    super(`Agent run mode could not be resolved: ${code}`)
    this.name = "AgentRunModeError"
  }
}

type Evidence = { canonical: boolean; legacy: boolean }
type OutboxRow = { topic: string; aggregateId: string; payload: unknown }
type TurnRow = { executionMode: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isMode(value: unknown): value is AgentRunExecutionMode {
  return AGENT_RUN_EXECUTION_MODES.includes(value as AgentRunExecutionMode)
}

async function readEvidence(client: pg.PoolClient, identity: AgentRunModeIdentity): Promise<Evidence> {
  const dispatch = await client.query<OutboxRow>(
    `SELECT "topic", "aggregateId", "payload" FROM "agent_outbox"
     WHERE "idempotencyKey" = $1 FOR UPDATE`,
    [`turn-dispatch:${identity.turnId}`],
  )
  let canonical = false
  if (dispatch.rows[0]) {
    const row = dispatch.rows[0]
    const payload = isRecord(row.payload) ? row.payload : null
    if (row.topic !== "agent.turn.dispatch" || row.aggregateId !== identity.sessionId
      || payload?.turnId !== identity.turnId || payload.sessionId !== identity.sessionId) {
      throw new AgentRunModeError("conflicting_evidence")
    }
    canonical = true
  }

  const pipelineReceipt = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM "agent_items"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'tool_call'
         AND "content"->>'toolName' = 'pipeline.run'
     ) AS "present"`,
    [identity.sessionId, identity.turnId],
  )
  return { canonical, legacy: pipelineReceipt.rows[0]?.present === true }
}

/** Atomically pins and returns the runner choice for one owner-fenced Turn. */
export async function pinAgentRunMode(
  pool: LeasePool,
  identity: AgentRunModeIdentity,
  canonicalAutomationEnabled: boolean,
): Promise<AgentRunExecutionMode> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const session = await client.query<{ id: string }>(
      `SELECT "id" FROM "agent_sessions"
       WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
      [identity.sessionId, identity.userId],
    )
    const turn = await client.query<TurnRow>(
      `SELECT "executionMode" FROM "agent_turns"
       WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
      [identity.turnId, identity.sessionId, identity.userId],
    )
    if (!session.rows[0] || !turn.rows[0]) throw new AgentRunModeError("owner_mismatch")

    const storedMode = turn.rows[0].executionMode
    if (storedMode !== null && !isMode(storedMode)) throw new AgentRunModeError("invalid_stored_mode")
    const evidence = await readEvidence(client, identity)
    if (evidence.canonical && evidence.legacy) throw new AgentRunModeError("conflicting_evidence")

    if (storedMode === "canonical_task_graph" && evidence.legacy
      || storedMode === "legacy_pipeline_adapter" && evidence.canonical) {
      throw new AgentRunModeError("conflicting_evidence")
    }

    if (storedMode) {
      await client.query("COMMIT")
      return storedMode
    }

    const selected: AgentRunExecutionMode = evidence.canonical
      ? "canonical_task_graph"
      : evidence.legacy
        ? "legacy_pipeline_adapter"
        : canonicalAutomationEnabled ? "canonical_task_graph" : "legacy_pipeline_adapter"
    const pinned = await client.query(
      `UPDATE "agent_turns" SET "executionMode" = $4
       WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "executionMode" IS NULL`,
      [identity.turnId, identity.sessionId, identity.userId, selected],
    )
    if (pinned.rowCount !== 1) throw new AgentRunModeError("owner_mismatch")
    await client.query("COMMIT")
    return selected
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
