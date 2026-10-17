import type { Pool, PoolClient } from "pg"
import { randomUUID } from "node:crypto"
import {
  AgentArtifactRepositoryError, artifactTaskFenceIsCurrent, artifactTaskLeaseIsLive,
  findCurrentDraftHeadWithClient, findReviewReceiptWithClient, toAgentArtifactReviewRow, toAgentArtifactRow, toAgentArtifactVersionRow, withArtifactTransaction,
  type AgentArtifactBaseInsert, type AgentArtifactDraftWrite as HelperAgentArtifactDraftWrite, type AgentArtifactReviewRow, type AgentArtifactReviewWrite,
  type AgentArtifactRow, type AgentArtifactTaskFence, type AgentArtifactVersionRow,
} from "./agent-artifact-repo-helpers.js"

export { AgentArtifactRepositoryError, findCurrentDraftHeadWithClient, findReviewReceiptWithClient } from "./agent-artifact-repo-helpers.js"
export type { AgentArtifactBaseInsert, AgentArtifactLifecycle, AgentArtifactReviewRow,
  AgentArtifactReviewWrite, AgentArtifactRow, AgentArtifactTaskFence, AgentArtifactVersionRow } from "./agent-artifact-repo-helpers.js"
export type AgentArtifactDraftWrite = HelperAgentArtifactDraftWrite & { readonly expectedPreviousVersion?: number }
export type AgentArtifactSourceDigestReader = (client: Pick<PoolClient, "query">, userId: string, jobId: string) => Promise<string | null>

export type AgentArtifactRevisionReviewRead = Readonly<{
  userId: string; sessionId: string; jobId: string; artifactId: string; version: number; contentHash: string
  sourceDigest: string; currentSourceDigest: string; dependencyTaskId: string; reviewHash: string; taskFence: AgentArtifactTaskFence
  readCurrentSourceDigest: AgentArtifactSourceDigestReader
}>

export type AgentArtifactDraftHead = Readonly<{
  artifactId: string
  version: number
  contentHash: string
  sourceDigest: string
}>

export type AgentArtifactDraftHeadScope = Readonly<{
  userId: string
  sessionId: string
  jobId: string
  artifactId: string
}>

export type AgentArtifactReviewReceipt = Readonly<Pick<AgentArtifactReviewRow, "userId" | "sessionId" | "jobId" | "artifactId" | "version" | "contentHash" | "sourceDigest" | "currentSourceDigest" | "status" | "taskId" | "toolCallId" | "reviewHash">>
export type AgentArtifactReviewReceiptScope = Readonly<Pick<AgentArtifactReviewReceipt, "userId" | "sessionId" | "jobId" | "artifactId" | "version" | "contentHash" | "sourceDigest" | "currentSourceDigest" | "status" | "taskId" | "reviewHash">>

const columns = `"id", "userId", "jobId", "artifactType", "lifecycle", "baseId", "baseHash", "content", "hash", "constraintHash", "provenanceRefs", "evidenceRefs", "previousHash", "version", "createdAt", "updatedAt"`
const versionColumns = `"id", "artifactId", "version", "userId", "sessionId", "jobId", "artifactType", "content", "contentHash", "sourceDigest", "constraintHash", "provenanceRefs", "evidenceRefs", "baseId", "baseHash", "previousHash", "taskId", "toolCallId", "requestHash", "createdAt"`
const reviewColumns = `"id", "artifactVersionId", "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest", "currentSourceDigest", "status", "findings", "evidenceRefs", "taskId", "toolCallId", "requestHash", "reviewHash", "createdAt"`
const reviewReceiptColumns = `"userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest", "currentSourceDigest", "status", "taskId", "toolCallId", "reviewHash"`
function draftParentContent(input: AgentArtifactDraftWrite, version: number): unknown {
  return input.artifactType === "cover_letter" ? { kind: "agent_artifact_version", artifactId: input.id, version, contentHash: input.hash } : input.content
}

async function selectOne(client: Pick<Pool, "query">, userId: string, artifactId: string, lock = false): Promise<AgentArtifactRow | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${columns} FROM "agent_artifact" WHERE "id" = $1 AND "userId" = $2${lock ? " FOR UPDATE" : ""}`, [artifactId, userId])
  return result.rows[0] ? toAgentArtifactRow(result.rows[0]) : null
}

async function findTaskVersion(client: Pick<Pool, "query">, taskId: string, toolCallId: string): Promise<AgentArtifactVersionRow | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${versionColumns} FROM "agent_artifact_version" WHERE "taskId" = $1 AND "toolCallId" = $2 FOR UPDATE`, [taskId, toolCallId])
  return result.rows[0] ? toAgentArtifactVersionRow(result.rows[0]) : null
}

function assertVersionReplay(existing: AgentArtifactVersionRow, input: AgentArtifactDraftWrite): AgentArtifactVersionRow {
  if (existing.requestHash !== input.requestHash || existing.userId !== input.userId || existing.sessionId !== input.sessionId || existing.jobId !== input.jobId) {
    throw new AgentArtifactRepositoryError("receipt_conflict", "Task tool receipt was replayed with different artifact input or scope.")
  }
  return existing
}

async function findTaskReview(client: Pick<Pool, "query">, taskId: string, toolCallId: string): Promise<AgentArtifactReviewRow | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${reviewColumns} FROM "agent_artifact_review" WHERE "taskId" = $1 AND "toolCallId" = $2 FOR UPDATE`, [taskId, toolCallId])
  return result.rows[0] ? toAgentArtifactReviewRow(result.rows[0]) : null
}

function assertReviewReplay(existing: AgentArtifactReviewRow, input: AgentArtifactReviewWrite): AgentArtifactReviewRow {
  if (existing.requestHash !== input.requestHash || existing.userId !== input.userId || existing.sessionId !== input.sessionId || existing.jobId !== input.jobId || existing.artifactId !== input.artifactId || existing.version !== input.version || existing.contentHash !== input.contentHash || existing.sourceDigest !== input.sourceDigest || existing.currentSourceDigest !== input.currentSourceDigest) {
    throw new AgentArtifactRepositoryError("receipt_conflict", "Task review receipt was replayed with different artifact input or scope.")
  }
  return existing
}

function assertReviewSourceBinding(input: AgentArtifactReviewWrite): void {
  const sourceChanged = input.sourceDigest !== input.currentSourceDigest
  const staleDetails = input.status === "stale" && (!Array.isArray(input.findings) || input.findings.length > 0 || input.evidenceRefs.length > 0)
  if (sourceChanged !== (input.status === "stale") || staleDetails) {
    throw new AgentArtifactRepositoryError("stale_source", "Review status and findings must match the selected-source digest.")
  }
}

export async function insertAgentArtifactBaseWithClient(client: Pick<PoolClient, "query">, input: AgentArtifactBaseInsert): Promise<AgentArtifactRow> {
  const inserted = await client.query<Record<string, unknown>>(
    `INSERT INTO "agent_artifact" (${columns}) VALUES ($1, $2, $3, $4, 'base', $1, $5, $6::jsonb, $7, $8, $9, $10, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING RETURNING ${columns}`,
    [input.id, input.userId, input.jobId, input.artifactType, input.hash, JSON.stringify(input.content), input.hash, input.constraintHash, [...input.provenanceRefs], [...input.evidenceRefs]],
  )
  if (inserted.rows[0]) return toAgentArtifactRow(inserted.rows[0])
  const existing = await selectOne(client, input.userId, input.id)
  const sameRefs = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index])
  if (!existing || existing.jobId !== input.jobId || existing.artifactType !== input.artifactType || existing.lifecycle !== "base"
    || existing.baseId !== input.id || existing.baseHash !== input.hash || existing.hash !== input.hash || existing.constraintHash !== input.constraintHash
    || !sameRefs(existing.provenanceRefs, input.provenanceRefs) || !sameRefs(existing.evidenceRefs, input.evidenceRefs)) {
    throw new AgentArtifactRepositoryError("receipt_conflict", "An immutable artifact with this identity has different content or scope.")
  }
  return existing
}

export function createAgentArtifactRepository(pool: Pool) {
  return {
    async find(userId: string, artifactId: string): Promise<AgentArtifactRow | null> {
      if (!userId.trim() || !artifactId.trim()) return null
      return selectOne(pool, userId, artifactId)
    },

    async insertBase(input: AgentArtifactBaseInsert): Promise<AgentArtifactRow> {
      const result = await pool.query<Record<string, unknown>>(
        `INSERT INTO "agent_artifact" (${columns}) VALUES ($1, $2, $3, $4, 'base', $1, $5, $6::jsonb, $7, $8, $9, $10, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING ${columns}`,
        [input.id, input.userId, input.jobId, input.artifactType, input.hash, JSON.stringify(input.content), input.hash, input.constraintHash, [...input.provenanceRefs], [...input.evidenceRefs]],
      )
      return toAgentArtifactRow(result.rows[0] ?? {})
    },

    insertBaseWithClient: insertAgentArtifactBaseWithClient,

    async saveDraft(input: AgentArtifactDraftWrite): Promise<AgentArtifactVersionRow> {
      return withArtifactTransaction(pool, input.userId, async client => {
        if (!input.sessionId.trim() || !input.taskId.trim() || !input.toolCallId.trim()) throw new AgentArtifactRepositoryError("precondition_failed", "Artifact Task receipt scope is required.")
        if (input.taskFence.taskId !== input.taskId || input.taskFence.userId !== input.userId || input.taskFence.sessionId !== input.sessionId) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task fence does not match its receipt scope.")
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [input.userId, input.jobId])
        if (!await artifactTaskFenceIsCurrent(client, input.taskFence, input.jobId)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease or lineage is stale, stopped, expired, or mismatched.")
        const earlyReceipt = await findTaskVersion(client, input.taskId, input.toolCallId)
        if (earlyReceipt) {
          const replay = assertVersionReplay(earlyReceipt, input)
          if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
          return replay
        }
        const base = await selectOne(client, input.userId, input.baseId, true)
        if (!base) throw new AgentArtifactRepositoryError("not_found", "Artifact is not available in the current tenant.")
        if (base.lifecycle !== "base" || base.hash !== input.baseHash || base.artifactType !== input.artifactType || base.jobId !== input.jobId) {
          throw new AgentArtifactRepositoryError("stale_hash", "Draft base hash is stale or unavailable.")
        }
        if (input.evidenceRefs.length === 0) throw new AgentArtifactRepositoryError("invalid_provenance", "Draft requires evidence.")

        const previous = await selectOne(client, input.userId, input.id, true)
        if (previous?.lifecycle === "base") throw new AgentArtifactRepositoryError("precondition_failed", "A base artifact cannot be replaced by a draft.")
        if (previous && (previous.jobId !== base.jobId || previous.baseId !== input.baseId || previous.artifactType !== input.artifactType)) {
          throw new AgentArtifactRepositoryError("precondition_failed", "Draft identity does not match its base artifact.")
        }
        if (input.expectedPreviousVersion !== undefined && (!previous || input.expectedPreviousVersion !== previous.version)) {
          throw new AgentArtifactRepositoryError("precondition_failed", "Draft update has a stale previous version.")
        }
        if (input.expectedPreviousHash !== undefined && (previous ? input.expectedPreviousHash !== previous.hash : input.expectedPreviousHash !== null)) {
          throw new AgentArtifactRepositoryError("precondition_failed", "Draft update has a stale previous hash.")
        }
        const previousHash = previous?.hash ?? input.previousHash
        const nextVersion = (previous?.version ?? 0) + 1
        if (!previous) {
          await client.query(
            `INSERT INTO "agent_artifact" (${columns}) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
            [input.id, input.userId, input.jobId, input.artifactType, input.baseId, input.baseHash, JSON.stringify(draftParentContent(input, nextVersion)), input.hash, input.constraintHash, [...input.provenanceRefs], [...input.evidenceRefs], previousHash, nextVersion],
          )
        }
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO "agent_artifact_version" (${versionColumns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,CURRENT_TIMESTAMP) ON CONFLICT ("taskId", "toolCallId") DO NOTHING RETURNING ${versionColumns}`,
          [randomUUID(), input.id, nextVersion, input.userId, input.sessionId, input.jobId, input.artifactType, JSON.stringify(input.content), input.hash, input.sourceDigest, input.constraintHash, [...input.provenanceRefs], [...input.evidenceRefs], input.baseId, input.baseHash, previousHash, input.taskId, input.toolCallId, input.requestHash],
        )
        if (!inserted.rows[0]) {
          const winner = await findTaskVersion(client, input.taskId, input.toolCallId)
          if (!winner) throw new AgentArtifactRepositoryError("receipt_conflict", "Task tool receipt could not be resolved.")
          const replay = assertVersionReplay(winner, input)
          if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
          return replay
        }
        const version = toAgentArtifactVersionRow(inserted.rows[0])
        if (previous) {
          await client.query(
            `UPDATE "agent_artifact" SET "content" = $1::jsonb, "hash" = $2, "constraintHash" = $3, "provenanceRefs" = $4, "evidenceRefs" = $5, "previousHash" = $6, "version" = $7, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $8 AND "userId" = $9 AND "lifecycle" = 'draft'`,
            [JSON.stringify(draftParentContent(input, nextVersion)), input.hash, input.constraintHash, [...input.provenanceRefs], [...input.evidenceRefs], previousHash, nextVersion, input.id, input.userId],
          )
        }
        if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
        return version
      })
    },

    async findVersion(scope: { userId: string; sessionId: string; jobId: string; artifactId: string; version: number }): Promise<AgentArtifactVersionRow | null> {
      return withArtifactTransaction(pool, scope.userId, async client => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT ${versionColumns} FROM "agent_artifact_version" WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5`,
          [scope.userId, scope.sessionId, scope.jobId, scope.artifactId, scope.version],
        )
        return result.rows[0] ? toAgentArtifactVersionRow(result.rows[0]) : null
      })
    },

    /** Reads only the current draft reference and requires its head version to belong to this session. */
    async findCurrentDraftHead(scope: AgentArtifactDraftHeadScope): Promise<AgentArtifactDraftHead | null> {
      return withArtifactTransaction(pool, scope.userId, client => findCurrentDraftHeadWithClient(client, scope))
    },

    async readRevisionReview(input: AgentArtifactRevisionReviewRead): Promise<AgentArtifactReviewRow | null> {
      return withArtifactTransaction(pool, input.userId, async client => {
        if (input.taskFence.taskId === input.dependencyTaskId || input.version < 1 || !Number.isSafeInteger(input.version)
          || input.sourceDigest !== input.currentSourceDigest) return null
        if (!await artifactTaskFenceIsCurrent(client, input.taskFence, input.jobId)) return null
        if (!await artifactTaskLeaseIsLive(client, input.taskFence)) return null
        const currentSourceDigest = await input.readCurrentSourceDigest(client, input.userId, input.jobId)
        if (currentSourceDigest !== input.sourceDigest || currentSourceDigest !== input.currentSourceDigest) return null
        const reviewResult = await client.query<Record<string, unknown>>(
          `SELECT ${reviewColumns} FROM "agent_artifact_review" WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5 AND "contentHash"=$6 AND "sourceDigest"=$7 AND "currentSourceDigest"=$8 AND "status"='needs_revision' AND "taskId"=$9 AND "reviewHash"=$10 LIMIT 2`,
          [input.userId, input.sessionId, input.jobId, input.artifactId, input.version, input.contentHash, input.sourceDigest, input.currentSourceDigest, input.dependencyTaskId, input.reviewHash],
        )
        if (reviewResult.rows.length !== 1) return null
        const review = toAgentArtifactReviewRow(reviewResult.rows[0] ?? {})
        if (review.status !== "needs_revision" || review.taskId !== input.dependencyTaskId || review.reviewHash !== input.reviewHash
          || review.userId !== input.userId || review.sessionId !== input.sessionId || review.jobId !== input.jobId
          || review.artifactId !== input.artifactId || review.version !== input.version || review.contentHash !== input.contentHash
          || review.sourceDigest !== input.sourceDigest || review.currentSourceDigest !== input.currentSourceDigest) return null
        const head = await selectOne(client, input.userId, input.artifactId, true)
        if (!head || head.lifecycle !== "draft" || head.jobId !== input.jobId || head.version !== input.version || head.hash !== input.contentHash) return null
        return await artifactTaskLeaseIsLive(client, input.taskFence) ? review : null
      })
    },

    async saveReview(input: AgentArtifactReviewWrite): Promise<AgentArtifactReviewRow> {
      return withArtifactTransaction(pool, input.userId, async client => {
        assertReviewSourceBinding(input)
        if (input.taskFence.taskId !== input.taskId || input.taskFence.userId !== input.userId || input.taskFence.sessionId !== input.sessionId) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task fence does not match its receipt scope.")
        if (!await artifactTaskFenceIsCurrent(client, input.taskFence, input.jobId)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease or lineage is stale, stopped, expired, or mismatched.")
        const earlyReceipt = await findTaskReview(client, input.taskId, input.toolCallId)
        if (earlyReceipt) {
          const replay = assertReviewReplay(earlyReceipt, input)
          if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
          return replay
        }
        const versionResult = await client.query<Record<string, unknown>>(
          `SELECT ${versionColumns} FROM "agent_artifact_version" WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5 AND "contentHash"=$6 AND "sourceDigest"=$7 FOR UPDATE`,
          [input.userId, input.sessionId, input.jobId, input.artifactId, input.version, input.contentHash, input.sourceDigest],
        )
        const artifact = versionResult.rows[0] ? toAgentArtifactVersionRow(versionResult.rows[0]) : null
        if (!artifact) throw new AgentArtifactRepositoryError("stale_hash", "Reviewed artifact version or source digest is stale.")
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO "agent_artifact_review" (${reviewColumns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,CURRENT_TIMESTAMP) ON CONFLICT ("taskId", "toolCallId") DO NOTHING RETURNING ${reviewColumns}`,
          [randomUUID(), artifact.id, input.userId, input.sessionId, input.jobId, input.artifactId, input.version, input.contentHash, input.sourceDigest, input.currentSourceDigest, input.status, JSON.stringify(input.findings), [...input.evidenceRefs], input.taskId, input.toolCallId, input.requestHash, input.reviewHash],
        )
        if (inserted.rows[0]) {
          if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
          return toAgentArtifactReviewRow(inserted.rows[0])
        }
        const winner = await findTaskReview(client, input.taskId, input.toolCallId)
        if (!winner) throw new AgentArtifactRepositoryError("receipt_conflict", "Task review receipt could not be resolved.")
        const replay = assertReviewReplay(winner, input)
        if (!await artifactTaskLeaseIsLive(client, input.taskFence)) throw new AgentArtifactRepositoryError("task_fence_denied", "The selected-job artifact task lease expired before commit.")
        return replay
      })
    },

    async findReview(scope: { userId: string; sessionId: string; jobId: string; artifactId: string; version: number; contentHash: string; sourceDigest: string }): Promise<AgentArtifactReviewRow | null> {
      return withArtifactTransaction(pool, scope.userId, async client => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT ${reviewColumns} FROM "agent_artifact_review" WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5 AND "contentHash"=$6 AND "sourceDigest"=$7 ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`,
          [scope.userId, scope.sessionId, scope.jobId, scope.artifactId, scope.version, scope.contentHash, scope.sourceDigest],
        )
        return result.rows[0] ? toAgentArtifactReviewRow(result.rows[0]) : null
      })
    },

    async findReviewReceipt(scope: AgentArtifactReviewReceiptScope): Promise<AgentArtifactReviewReceipt | null> {
      return withArtifactTransaction(pool, scope.userId, client => findReviewReceiptWithClient(client, scope))
    },

    async list(userId: string, jobId: string): Promise<AgentArtifactRow[]> {
      const result = await pool.query<Record<string, unknown>>(`SELECT ${columns} FROM "agent_artifact" WHERE "userId" = $1 AND "jobId" = $2 ORDER BY "updatedAt" DESC, "id" ASC`, [userId, jobId])
      return result.rows.map(toAgentArtifactRow)
    },
  }
}
