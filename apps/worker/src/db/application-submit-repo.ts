import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { appendFencedSubmitAudit, lockApplicationSubmitFence, type ApplicationSubmitIdentity } from "../queue/application-submit-fence.js"

export type SubmissionAttemptState = "reserved" | "submitted" | "failed"
export type ApplicationTarget = { readonly id: string; readonly userId: string; readonly jobId: string; readonly company: string; readonly role: string; readonly applyUrl: string; readonly source: string | null }
export type SubmissionAttempt = {
  readonly id: string; readonly userId: string; readonly jobId: string; readonly receiptId: string; readonly constraintHash: string; readonly artifactHash: string
  readonly state: SubmissionAttemptState; readonly responseRef: string | null; readonly errorCode: string | null; readonly createdAt: Date; readonly updatedAt: Date
}
export type SubmissionAuthorization = { readonly kind: "authorized"; readonly artifactHash: string } | { readonly kind: "fenced" }
export type SubmissionClaim = { readonly kind: "reserved" | "replay"; readonly attempt: SubmissionAttempt; readonly artifactHash: string } | { readonly kind: "fenced" }
export type SubmissionClaimAuthorizer = (client: PoolClient, mode: "new" | "replay") => Promise<SubmissionAuthorization>
export type SubmissionAttemptWrite = { readonly kind: "updated"; readonly attempt: SubmissionAttempt } | { readonly kind: "fenced" }

export class ApplicationSubmitRepositoryError extends Error {
  constructor(readonly code: "idempotency_conflict" | "idempotency_replay" | "not_found" | "invalid_state", message: string) {
    super(message)
    this.name = "ApplicationSubmitRepositoryError"
  }
}

const attemptColumns = `"id", "userId", "jobId", "receiptId", "constraintHash", "artifactHash", "state", "responseRef", "errorCode", "createdAt", "updatedAt"`
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505") }
function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new ApplicationSubmitRepositoryError("invalid_state", "The database returned an invalid submission timestamp.")
  return date
}
function asAttempt(row: Record<string, unknown>): SubmissionAttempt {
  if (!["reserved", "submitted", "failed"].includes(String(row.state)) ||
      !["id", "userId", "jobId", "receiptId", "constraintHash", "artifactHash"].every(key => typeof row[key] === "string")) {
    throw new ApplicationSubmitRepositoryError("invalid_state", "The database returned an invalid submission attempt.")
  }
  return { id: row.id as string, userId: row.userId as string, jobId: row.jobId as string, receiptId: row.receiptId as string,
    constraintHash: row.constraintHash as string, artifactHash: row.artifactHash as string, state: row.state as SubmissionAttemptState,
    responseRef: typeof row.responseRef === "string" ? row.responseRef : null, errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    createdAt: asDate(row.createdAt), updatedAt: asDate(row.updatedAt) }
}
function asTarget(row: Record<string, unknown>): ApplicationTarget {
  if (typeof row.id !== "string" || typeof row.userId !== "string" || typeof row.company !== "string" || typeof row.role !== "string" || typeof row.url !== "string" || !row.url.trim()) {
    throw new ApplicationSubmitRepositoryError("not_found", "The application target has no usable server-owned URL.")
  }
  return { id: row.id, userId: row.userId, jobId: row.id, company: row.company, role: row.role, applyUrl: row.url, source: typeof row.source === "string" ? row.source : null }
}
async function withTransaction<T>(pool: Pool, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error: unknown) {
    await client.query("ROLLBACK")
    throw error
  } finally { client.release() }
}
function matches(attempt: SubmissionAttempt, identity: ApplicationSubmitIdentity): boolean {
  return attempt.userId === identity.userId && attempt.jobId === identity.jobId && attempt.receiptId === identity.approvalId && attempt.constraintHash === identity.constraintHash
}

export function createApplicationSubmitRepository(pool: Pool) {
  return {
    async findTarget(userId: string, applicationTargetId: string): Promise<ApplicationTarget | null> {
      const result = await pool.query<Record<string, unknown>>(`SELECT "id", "userId", "company", "role", "url", "source" FROM "Job" WHERE "id" = $1 AND "userId" = $2 AND "url" IS NOT NULL`, [applicationTargetId, userId])
      return result.rows[0] ? asTarget(result.rows[0]) : null
    },
    async reserveAndConsume(identity: ApplicationSubmitIdentity, authorize: SubmissionClaimAuthorizer): Promise<SubmissionClaim> {
      try {
        return await withTransaction(pool, identity.userId, async client => {
          if (await lockApplicationSubmitFence(client, identity) === "superseded") {
            await appendFencedSubmitAudit(client, identity, "claim")
            return { kind: "fenced" }
          }
          const existingRow = await client.query<Record<string, unknown>>(`SELECT ${attemptColumns} FROM "submission_attempt" WHERE "receiptId" = $1 FOR UPDATE`, [identity.approvalId])
          const existing = existingRow.rows[0] ? asAttempt(existingRow.rows[0]) : null
          if (existing) {
            if (!matches(existing, identity)) throw new ApplicationSubmitRepositoryError("idempotency_conflict", "This approval is already bound to a different submission attempt.")
            const authorization = await authorize(client, "replay")
            if (authorization.kind === "fenced") {
              await appendFencedSubmitAudit(client, identity, "replay")
              return { kind: "fenced" }
            }
            if (authorization.artifactHash !== existing.artifactHash) throw new ApplicationSubmitRepositoryError("idempotency_conflict", "This approval no longer matches its original artifact.")
            return { kind: "replay", attempt: existing, artifactHash: existing.artifactHash }
          }
          const authorization = await authorize(client, "new")
          if (authorization.kind === "fenced") {
            await appendFencedSubmitAudit(client, identity, "claim")
            return { kind: "fenced" }
          }
          if (!/^[a-f0-9]{64}$/.test(authorization.artifactHash)) throw new ApplicationSubmitRepositoryError("invalid_state", "Approval artifact hash is invalid.")
          const result = await client.query<Record<string, unknown>>(
            `INSERT INTO "submission_attempt" (${attemptColumns}) VALUES ($1, $2, $3, $4, $5, $6, 'reserved', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING ${attemptColumns}`,
            [randomUUID(), identity.userId, identity.jobId, identity.approvalId, identity.constraintHash, authorization.artifactHash],
          )
          return { kind: "reserved", attempt: asAttempt(result.rows[0] ?? {}), artifactHash: authorization.artifactHash }
        })
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw new ApplicationSubmitRepositoryError("idempotency_replay", "This approval already has a submission attempt.")
        throw error
      }
    },
    async isCurrent(identity: ApplicationSubmitIdentity): Promise<boolean> {
      return withTransaction(pool, identity.userId, async client => {
        if (await lockApplicationSubmitFence(client, identity) === "current") return true
        await appendFencedSubmitAudit(client, identity, "pre_submit")
        return false
      })
    },
    async markSubmitted(identity: ApplicationSubmitIdentity, responseRef: string): Promise<SubmissionAttemptWrite> {
      return withTransaction(pool, identity.userId, async client => {
        if (await lockApplicationSubmitFence(client, identity) === "superseded") {
          await appendFencedSubmitAudit(client, identity, "success")
          return { kind: "fenced" }
        }
        const result = await client.query<Record<string, unknown>>(
          `UPDATE "submission_attempt" SET "state" = 'submitted', "responseRef" = $1, "errorCode" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = $2 AND "jobId" = $3 AND "receiptId" = $4 AND "constraintHash" = $5 AND "state" = 'reserved' RETURNING ${attemptColumns}`,
          [responseRef, identity.userId, identity.jobId, identity.approvalId, identity.constraintHash],
        )
        if (result.rows[0]) return { kind: "updated", attempt: asAttempt(result.rows[0]) }
        const current = await client.query<Record<string, unknown>>(`SELECT ${attemptColumns} FROM "submission_attempt" WHERE "userId" = $1 AND "jobId" = $2 AND "receiptId" = $3 AND "constraintHash" = $4`, [identity.userId, identity.jobId, identity.approvalId, identity.constraintHash])
        const attempt = current.rows[0] ? asAttempt(current.rows[0]) : null
        if (attempt?.state === "submitted" && attempt.responseRef === responseRef) return { kind: "updated", attempt }
        throw new ApplicationSubmitRepositoryError("invalid_state", "The submission attempt is no longer reservable.")
      })
    },
    async markFailed(identity: ApplicationSubmitIdentity, errorCode: string): Promise<SubmissionAttemptWrite> {
      return withTransaction(pool, identity.userId, async client => {
        if (await lockApplicationSubmitFence(client, identity) === "superseded") {
          await appendFencedSubmitAudit(client, identity, `failure:${errorCode}`)
          return { kind: "fenced" }
        }
        const result = await client.query<Record<string, unknown>>(
          `UPDATE "submission_attempt" SET "state" = 'failed', "errorCode" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = $2 AND "jobId" = $3 AND "receiptId" = $4 AND "constraintHash" = $5 AND "state" = 'reserved' RETURNING ${attemptColumns}`,
          [errorCode, identity.userId, identity.jobId, identity.approvalId, identity.constraintHash],
        )
        if (result.rows[0]) return { kind: "updated", attempt: asAttempt(result.rows[0]) }
        const current = await client.query<Record<string, unknown>>(`SELECT ${attemptColumns} FROM "submission_attempt" WHERE "userId" = $1 AND "jobId" = $2 AND "receiptId" = $3 AND "constraintHash" = $4`, [identity.userId, identity.jobId, identity.approvalId, identity.constraintHash])
        const attempt = current.rows[0] ? asAttempt(current.rows[0]) : null
        if (attempt?.state === "failed") return { kind: "updated", attempt }
        throw new ApplicationSubmitRepositoryError("invalid_state", "The submission attempt cannot be marked failed.")
      })
    },
  }
}
