import type { Pool, PoolClient } from "pg"
import { RUNNABLE_SESSION } from "../runtime/session-gate.js"

export type AgentArtifactTaskFence = {
  readonly taskId: string
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly parentTaskId: string | null
  readonly leaseOwner: string
  readonly attemptCount: number
}

export type AgentArtifactLifecycle = "base" | "draft"

export type AgentArtifactRow = { readonly id: string; readonly userId: string; readonly jobId: string; readonly artifactType: string; readonly lifecycle: AgentArtifactLifecycle; readonly baseId: string | null; readonly baseHash: string | null; readonly content: unknown; readonly hash: string; readonly constraintHash: string; readonly provenanceRefs: string[]; readonly evidenceRefs: string[]; readonly previousHash: string | null; readonly version: number; readonly createdAt: Date; readonly updatedAt: Date }

export type AgentArtifactVersionRow = {
  readonly id: string; readonly artifactId: string; readonly version: number; readonly userId: string; readonly sessionId: string; readonly jobId: string; readonly artifactType: string; readonly content: unknown
  readonly contentHash: string; readonly sourceDigest: string; readonly constraintHash: string; readonly provenanceRefs: string[]; readonly evidenceRefs: string[]; readonly baseId: string; readonly baseHash: string
  readonly previousHash: string | null; readonly taskId: string; readonly toolCallId: string; readonly requestHash: string; readonly createdAt: Date
}

export type AgentArtifactReviewRow = {
  readonly id: string; readonly artifactVersionId: string; readonly userId: string; readonly sessionId: string; readonly jobId: string; readonly artifactId: string; readonly version: number
  readonly contentHash: string; readonly sourceDigest: string; readonly currentSourceDigest: string; readonly status: "passed" | "needs_revision" | "rejected" | "stale"; readonly findings: unknown; readonly evidenceRefs: string[]
  readonly taskId: string; readonly toolCallId: string; readonly requestHash: string; readonly reviewHash: string; readonly createdAt: Date
}

export type AgentArtifactBaseInsert = { readonly id: string; readonly userId: string; readonly jobId: string; readonly artifactType: string; readonly content: unknown; readonly hash: string; readonly constraintHash: string; readonly provenanceRefs: readonly string[]; readonly evidenceRefs: readonly string[] }

export type AgentArtifactDraftWrite = AgentArtifactBaseInsert & { readonly sessionId: string; readonly baseId: string; readonly baseHash: string; readonly previousHash: string | null; readonly sourceDigest: string; readonly taskId: string; readonly toolCallId: string; readonly requestHash: string; readonly taskFence: AgentArtifactTaskFence; readonly expectedPreviousHash?: string | null }

export type AgentArtifactReviewWrite = { readonly userId: string; readonly sessionId: string; readonly jobId: string; readonly artifactId: string; readonly version: number; readonly contentHash: string; readonly sourceDigest: string; readonly currentSourceDigest: string; readonly status: AgentArtifactReviewRow["status"]; readonly findings: unknown; readonly evidenceRefs: readonly string[]; readonly taskId: string; readonly toolCallId: string; readonly requestHash: string; readonly reviewHash: string; readonly taskFence: AgentArtifactTaskFence }

export class AgentArtifactRepositoryError extends Error {
  constructor(readonly code: "not_found" | "stale_hash" | "invalid_provenance" | "precondition_failed" | "receipt_conflict" | "stale_source" | "task_fence_denied", message: string) {
    super(message)
    this.name = "AgentArtifactRepositoryError"
  }
}

function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [] }
function date(value: unknown): Date { return value instanceof Date ? value : new Date(String(value)) }

export function toAgentArtifactRow(row: Record<string, unknown>): AgentArtifactRow {
  const lifecycle = row.lifecycle === "base" || row.lifecycle === "draft" ? row.lifecycle : null
  if (!lifecycle || typeof row.id !== "string" || typeof row.userId !== "string" || typeof row.jobId !== "string" || typeof row.artifactType !== "string" || typeof row.hash !== "string" || typeof row.constraintHash !== "string") {
    throw new AgentArtifactRepositoryError("precondition_failed", "The database returned an invalid artifact record.")
  }
  return {
    id: row.id, userId: row.userId, jobId: row.jobId, artifactType: row.artifactType, lifecycle,
    baseId: typeof row.baseId === "string" ? row.baseId : null,
    baseHash: typeof row.baseHash === "string" ? row.baseHash : null,
    content: row.content, hash: row.hash, constraintHash: row.constraintHash,
    provenanceRefs: strings(row.provenanceRefs), evidenceRefs: strings(row.evidenceRefs),
    previousHash: typeof row.previousHash === "string" ? row.previousHash : null,
    version: typeof row.version === "number" ? row.version : Number(row.version),
    createdAt: date(row.createdAt), updatedAt: date(row.updatedAt),
  }
}

export function toAgentArtifactVersionRow(row: Record<string, unknown>): AgentArtifactVersionRow {
  return {
    id: String(row.id), artifactId: String(row.artifactId), version: Number(row.version), userId: String(row.userId),
    sessionId: String(row.sessionId), jobId: String(row.jobId), artifactType: String(row.artifactType), content: row.content,
    contentHash: String(row.contentHash), sourceDigest: String(row.sourceDigest), constraintHash: String(row.constraintHash),
    provenanceRefs: strings(row.provenanceRefs), evidenceRefs: strings(row.evidenceRefs), baseId: String(row.baseId),
    baseHash: String(row.baseHash), previousHash: typeof row.previousHash === "string" ? row.previousHash : null,
    taskId: String(row.taskId), toolCallId: String(row.toolCallId), requestHash: String(row.requestHash), createdAt: date(row.createdAt),
  }
}

export function toAgentArtifactReviewRow(row: Record<string, unknown>): AgentArtifactReviewRow {
  if (row.status !== "passed" && row.status !== "needs_revision" && row.status !== "rejected" && row.status !== "stale") {
    throw new AgentArtifactRepositoryError("precondition_failed", "The database returned an invalid artifact review.")
  }
  return {
    id: String(row.id), artifactVersionId: String(row.artifactVersionId), userId: String(row.userId), sessionId: String(row.sessionId),
    jobId: String(row.jobId), artifactId: String(row.artifactId), version: Number(row.version), contentHash: String(row.contentHash),
    sourceDigest: String(row.sourceDigest), currentSourceDigest: String(row.currentSourceDigest), status: row.status, findings: row.findings, evidenceRefs: strings(row.evidenceRefs),
    taskId: String(row.taskId), toolCallId: String(row.toolCallId), requestHash: String(row.requestHash),
    reviewHash: String(row.reviewHash), createdAt: date(row.createdAt),
  }
}

const TERMINAL_TURN = "('completed', 'failed', 'interrupted', 'cancelled')"
const TERMINAL_TASK = "('completed', 'failed', 'interrupted', 'cancelled', 'closed')"
const CURRENT_TASK = `SELECT task."id" FROM "sub_agent_tasks" AS task
  JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
  JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
  JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
  WHERE task."id" = $1 AND session."userId" = $2 AND turn."userId" = $2 AND task."sessionId" = $3 AND task."turnId" = $4
    AND task."rootTaskId" = $5 AND task."parentTaskId" IS NOT DISTINCT FROM $6
    AND task."status" = 'running' AND task."leaseOwner" = $7 AND task."attemptCount" = $8
    AND task."leaseExpiresAt" > clock_timestamp() AND task."interruptRequestedAt" IS NULL
    AND ${RUNNABLE_SESSION} AND turn."status" NOT IN ${TERMINAL_TURN}
    AND turn."rootTaskId" = root."id" AND root."rootTaskId" = root."id"
    AND root."status" NOT IN ${TERMINAL_TASK} AND root."interruptRequestedAt" IS NULL
    AND task."context"->'selectedJobPreparation'->>'jobId' = $9
  FOR UPDATE OF session, turn, root, task`

type QueryClient = Pick<Pool, "query">

export async function withArtifactTransaction<T>(pool: Pool, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error: unknown) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

/** Locks every authority row until the artifact transaction commits or rolls back. */
export async function artifactTaskFenceIsCurrent(client: QueryClient, fence: AgentArtifactTaskFence, jobId: string): Promise<boolean> {
  if (![fence.taskId, fence.userId, fence.sessionId, fence.turnId, fence.rootTaskId, fence.leaseOwner, jobId].every(value => typeof value === "string" && value.trim().length > 0)
    || !Number.isSafeInteger(fence.attemptCount) || fence.attemptCount < 1
    || (fence.parentTaskId !== null && (typeof fence.parentTaskId !== "string" || !fence.parentTaskId.trim()))) return false
  const current = await client.query(CURRENT_TASK, [fence.taskId, fence.userId, fence.sessionId, fence.turnId, fence.rootTaskId, fence.parentTaskId, fence.leaseOwner, fence.attemptCount, jobId])
  if (current.rows.length !== 1) return false
  if (fence.parentTaskId === null) return fence.taskId === fence.rootTaskId
  const parent = await client.query(
    `SELECT parent."id" FROM "sub_agent_tasks" AS parent WHERE parent."id" = $1 AND parent."sessionId" = $2
      AND parent."turnId" = $3 AND parent."rootTaskId" = $4 AND parent."status" NOT IN ${TERMINAL_TASK}
      AND parent."interruptRequestedAt" IS NULL FOR UPDATE`,
    [fence.parentTaskId, fence.sessionId, fence.turnId, fence.rootTaskId],
  )
  return parent.rows.length === 1
}

/** Rechecks wall-clock expiry immediately before the surrounding transaction commits. */
export async function artifactTaskLeaseIsLive(client: QueryClient, fence: AgentArtifactTaskFence): Promise<boolean> {
  const result = await client.query<{ live: boolean }>(
    `SELECT "leaseExpiresAt" > clock_timestamp() AS "live" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $4`,
    [fence.taskId, fence.sessionId, fence.leaseOwner, fence.attemptCount],
  )
  return result.rows[0]?.live === true
}
