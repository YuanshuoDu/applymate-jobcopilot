import type { Pool, PoolClient } from "pg"
import { randomUUID } from "node:crypto"
import type { AgentArtifactDraftHead, AgentArtifactDraftHeadScope, AgentArtifactReviewReceipt, AgentArtifactReviewReceiptScope } from "./agent-artifact-repo.js"
import { artifactTaskFenceIsCurrent, artifactTaskLeaseIsLive } from "./agent-artifact-prepare-wait-fence.js"

export type AgentArtifactTaskFence = {
  readonly taskId: string
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly parentTaskId: string | null
  readonly leaseOwner: string
  readonly attemptCount: number
  readonly taskFenceMode?: "selected_job" | "scheduled_prepare"
  readonly turnLeaseOwnerId?: string
  readonly turnLeaseVersion?: number
  readonly rootAttemptCount?: number
}
export type AgentArtifactScope = Readonly<{ userId: string; jobId: string; artifactType: string; lifecycle: AgentArtifactLifecycle }>

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
export type AgentArtifactDraftTransactionWrite = AgentArtifactDraftWrite & { readonly expectedPreviousVersion?: number }

export type AgentArtifactReviewWrite = { readonly userId: string; readonly sessionId: string; readonly jobId: string; readonly artifactId: string; readonly version: number; readonly contentHash: string; readonly sourceDigest: string; readonly currentSourceDigest: string; readonly status: AgentArtifactReviewRow["status"]; readonly findings: unknown; readonly evidenceRefs: readonly string[]; readonly taskId: string; readonly toolCallId: string; readonly requestHash: string; readonly reviewHash: string; readonly taskFence: AgentArtifactTaskFence }

export class AgentArtifactRepositoryError extends Error {
  constructor(readonly code: "not_found" | "stale_hash" | "invalid_provenance" | "precondition_failed" | "receipt_conflict" | "stale_source" | "task_fence_denied", message: string) {
    super(message)
    this.name = "AgentArtifactRepositoryError"
  }
}

const DRAFT_ARTIFACT_COLUMNS = `"id", "userId", "jobId", "artifactType", "lifecycle", "baseId", "baseHash", "content", "hash", "constraintHash", "provenanceRefs", "evidenceRefs", "previousHash", "version", "createdAt", "updatedAt"`
const DRAFT_VERSION_COLUMNS = `"id", "artifactId", "version", "userId", "sessionId", "jobId", "artifactType", "content", "contentHash", "sourceDigest", "constraintHash", "provenanceRefs", "evidenceRefs", "baseId", "baseHash", "previousHash", "taskId", "toolCallId", "requestHash", "createdAt"`

function draftParentContent(input: AgentArtifactDraftTransactionWrite, version: number): unknown {
  return input.artifactType === "cover_letter" ? { kind: "agent_artifact_version", artifactId: input.id, version, contentHash: input.hash } : input.content
}

async function selectDraftArtifact(client: Pick<PoolClient, "query">, userId: string, artifactId: string, lock = false): Promise<AgentArtifactRow | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${DRAFT_ARTIFACT_COLUMNS} FROM "agent_artifact" WHERE "id" = $1 AND "userId" = $2${lock ? " FOR UPDATE" : ""}`, [artifactId, userId])
  return result.rows[0] ? toAgentArtifactRow(result.rows[0]) : null
}

/** Locks the unique base or draft artifact for a user, job, and type inside the caller transaction. */
export async function findAgentArtifactByScopeWithClient(client: Pick<PoolClient, "query">, scope: AgentArtifactScope): Promise<AgentArtifactRow | null> {
  if (![scope.userId, scope.jobId, scope.artifactType].every(value => typeof value === "string" && value.trim().length > 0)
    || (scope.lifecycle !== "base" && scope.lifecycle !== "draft")) return null
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${DRAFT_ARTIFACT_COLUMNS} FROM "agent_artifact"
      WHERE "userId" = $1 AND "jobId" = $2 AND "artifactType" = $3 AND "lifecycle" = $4 FOR UPDATE`,
    [scope.userId, scope.jobId, scope.artifactType, scope.lifecycle],
  )
  if (result.rows.length !== 1) return null
  const row = toAgentArtifactRow(result.rows[0]!)
  return row.userId === scope.userId && row.jobId === scope.jobId && row.artifactType === scope.artifactType && row.lifecycle === scope.lifecycle
    ? row : null
}

async function findDraftTaskVersion(client: Pick<PoolClient, "query">, taskId: string, toolCallId: string): Promise<AgentArtifactVersionRow | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${DRAFT_VERSION_COLUMNS} FROM "agent_artifact_version" WHERE "taskId" = $1 AND "toolCallId" = $2 FOR UPDATE`, [taskId, toolCallId])
  return result.rows[0] ? toAgentArtifactVersionRow(result.rows[0]) : null
}

function assertDraftReplay(existing: AgentArtifactVersionRow, input: AgentArtifactDraftTransactionWrite): AgentArtifactVersionRow {
  if (existing.requestHash !== input.requestHash || existing.userId !== input.userId || existing.sessionId !== input.sessionId || existing.jobId !== input.jobId) {
    throw new AgentArtifactRepositoryError("receipt_conflict", "Task tool receipt was replayed with different artifact input or scope.")
  }
  return existing
}

/** Writes a draft and its immutable version through a transaction owned by the caller. */
export async function saveAgentArtifactDraftWithClient(client: Pick<PoolClient, "query">, input: AgentArtifactDraftTransactionWrite): Promise<AgentArtifactVersionRow> {
  if (!input.sessionId.trim() || !input.taskId.trim() || !input.toolCallId.trim()) throw new AgentArtifactRepositoryError("precondition_failed", "Artifact Task receipt scope is required.")
  if (input.taskFence.taskId !== input.taskId || input.taskFence.userId !== input.userId || input.taskFence.sessionId !== input.sessionId) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task fence does not match its receipt scope.")
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [input.userId, input.jobId])
  if (!await artifactTaskFenceIsCurrent(client, input.taskFence, input.jobId)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease or lineage is stale, stopped, expired, or mismatched.")
  const earlyReceipt = await findDraftTaskVersion(client, input.taskId, input.toolCallId)
  if (earlyReceipt) {
    const replay = assertDraftReplay(earlyReceipt, input)
    if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
    return replay
  }
  const base = await selectDraftArtifact(client, input.userId, input.baseId, true)
  if (!base) throw new AgentArtifactRepositoryError("not_found", "Artifact is not available in the current tenant.")
  if (base.lifecycle !== "base" || base.hash !== input.baseHash || base.artifactType !== input.artifactType || base.jobId !== input.jobId) throw new AgentArtifactRepositoryError("stale_hash", "Draft base hash is stale or unavailable.")
  if (input.evidenceRefs.length === 0) throw new AgentArtifactRepositoryError("invalid_provenance", "Draft requires evidence.")
  const previous = await selectDraftArtifact(client, input.userId, input.id, true)
  if (previous?.lifecycle === "base") throw new AgentArtifactRepositoryError("precondition_failed", "A base artifact cannot be replaced by a draft.")
  if (previous && (previous.jobId !== base.jobId || previous.baseId !== input.baseId || previous.artifactType !== input.artifactType)) throw new AgentArtifactRepositoryError("precondition_failed", "Draft identity does not match its base artifact.")
  if (input.expectedPreviousVersion !== undefined && (!previous || input.expectedPreviousVersion !== previous.version)) throw new AgentArtifactRepositoryError("precondition_failed", "Draft update has a stale previous version.")
  if (input.expectedPreviousHash !== undefined && (previous ? input.expectedPreviousHash !== previous.hash : input.expectedPreviousHash !== null)) throw new AgentArtifactRepositoryError("precondition_failed", "Draft update has a stale previous hash.")
  const previousHash = previous?.hash ?? input.previousHash
  const nextVersion = (previous?.version ?? 0) + 1
  if (!previous) await client.query(
    `INSERT INTO "agent_artifact" (${DRAFT_ARTIFACT_COLUMNS}) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [input.id, input.userId, input.jobId, input.artifactType, input.baseId, input.baseHash, JSON.stringify(draftParentContent(input, nextVersion)), input.hash, input.constraintHash, [...input.provenanceRefs], [...input.evidenceRefs], previousHash, nextVersion],
  )
  const inserted = await client.query<Record<string, unknown>>(
    `INSERT INTO "agent_artifact_version" (${DRAFT_VERSION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,CURRENT_TIMESTAMP) ON CONFLICT ("taskId", "toolCallId") DO NOTHING RETURNING ${DRAFT_VERSION_COLUMNS}`,
    [randomUUID(), input.id, nextVersion, input.userId, input.sessionId, input.jobId, input.artifactType, JSON.stringify(input.content), input.hash, input.sourceDigest, input.constraintHash, [...input.provenanceRefs], [...input.evidenceRefs], input.baseId, input.baseHash, previousHash, input.taskId, input.toolCallId, input.requestHash],
  )
  if (!inserted.rows[0]) {
    const winner = await findDraftTaskVersion(client, input.taskId, input.toolCallId)
    if (!winner) throw new AgentArtifactRepositoryError("receipt_conflict", "Task tool receipt could not be resolved.")
    const replay = assertDraftReplay(winner, input)
    if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
    return replay
  }
  const version = toAgentArtifactVersionRow(inserted.rows[0])
  if (previous) await client.query(
    `UPDATE "agent_artifact" SET "content" = $1::jsonb, "hash" = $2, "constraintHash" = $3, "provenanceRefs" = $4, "evidenceRefs" = $5, "previousHash" = $6, "version" = $7, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $8 AND "userId" = $9 AND "lifecycle" = 'draft'`,
    [JSON.stringify(draftParentContent(input, nextVersion)), input.hash, input.constraintHash, [...input.provenanceRefs], [...input.evidenceRefs], previousHash, nextVersion, input.id, input.userId],
  )
  if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
  return version
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

/** Reads only the persisted current draft reference through a caller-owned transaction. */
export async function findCurrentDraftHeadWithClient(client: Pick<PoolClient, "query">, scope: AgentArtifactDraftHeadScope): Promise<AgentArtifactDraftHead | null> {
  if (![scope.userId, scope.sessionId, scope.jobId, scope.artifactId].every(value => typeof value === "string" && value.trim().length > 0)) return null
  const result = await client.query<Record<string, unknown>>(
    `SELECT version_row."artifactId" AS "artifactId", version_row."version" AS "version",
            version_row."contentHash" AS "contentHash", version_row."sourceDigest" AS "sourceDigest"
     FROM "agent_artifact" AS artifact JOIN "agent_artifact_version" AS version_row
       ON version_row."artifactId" = artifact."id" AND version_row."version" = artifact."version"
       AND version_row."userId" = artifact."userId" AND version_row."jobId" = artifact."jobId"
       AND version_row."artifactType" = artifact."artifactType" AND version_row."contentHash" = artifact."hash"
     WHERE artifact."id" = $1 AND artifact."userId" = $2 AND artifact."jobId" = $3
       AND artifact."artifactType" = 'cover_letter' AND artifact."lifecycle" = 'draft'
       AND version_row."sessionId" = $4 AND version_row."userId" = $2
       AND version_row."jobId" = $3 AND version_row."artifactType" = 'cover_letter'`,
    [scope.artifactId, scope.userId, scope.jobId, scope.sessionId],
  )
  if (result.rows.length !== 1) return null
  const row = result.rows[0]
  if (!row || row.artifactId !== scope.artifactId || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || typeof row.contentHash !== "string" || typeof row.sourceDigest !== "string") return null
  return { artifactId: row.artifactId, version: Number(row.version), contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}

/** Reads an exact persisted review receipt through a caller-owned transaction. */
export async function findReviewReceiptWithClient(client: Pick<PoolClient, "query">, scope: AgentArtifactReviewReceiptScope): Promise<AgentArtifactReviewReceipt | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest", "currentSourceDigest", "status", "taskId", "toolCallId", "reviewHash"
     FROM "agent_artifact_review" WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5 AND "contentHash"=$6 AND "sourceDigest"=$7 AND "currentSourceDigest"=$8 AND "status"=$9 AND "taskId"=$10 AND "reviewHash"=$11 LIMIT 2`,
    [scope.userId, scope.sessionId, scope.jobId, scope.artifactId, scope.version, scope.contentHash, scope.sourceDigest, scope.currentSourceDigest, scope.status, scope.taskId, scope.reviewHash],
  )
  if (result.rows.length !== 1) return null
  const row = result.rows[0]
  if (!row || typeof row.toolCallId !== "string" || !row.toolCallId.trim()) return null
  return { userId: row.userId as string, sessionId: row.sessionId as string, jobId: row.jobId as string, artifactId: row.artifactId as string, version: Number(row.version), contentHash: row.contentHash as string, sourceDigest: row.sourceDigest as string, currentSourceDigest: row.currentSourceDigest as string, status: row.status as AgentArtifactReviewReceipt["status"], taskId: row.taskId as string, toolCallId: row.toolCallId, reviewHash: row.reviewHash as string }
}

export { artifactTaskFenceIsCurrent, artifactTaskLeaseIsLive } from "./agent-artifact-prepare-wait-fence.js"
