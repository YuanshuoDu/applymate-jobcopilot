import { randomUUID } from "node:crypto"
import type { Pool } from "pg"

export type SubmissionAttemptState = "reserved" | "submitted" | "failed"

export type ApplicationTarget = {
  readonly id: string
  readonly userId: string
  readonly jobId: string
  readonly company: string
  readonly role: string
  readonly applyUrl: string
  readonly source: string | null
}

export type SubmissionAttempt = {
  readonly id: string
  readonly userId: string
  readonly jobId: string
  readonly receiptId: string
  readonly constraintHash: string
  readonly artifactHash: string
  readonly state: SubmissionAttemptState
  readonly responseRef: string | null
  readonly errorCode: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type ReserveSubmissionInput = {
  readonly userId: string
  readonly jobId: string
  readonly receiptId: string
  readonly constraintHash: string
  readonly artifactHash: string
}

export class ApplicationSubmitRepositoryError extends Error {
  constructor(readonly code: "idempotency_replay" | "not_found" | "invalid_state", message: string) {
    super(message)
    this.name = "ApplicationSubmitRepositoryError"
  }
}

const attemptColumns = `"id", "userId", "jobId", "receiptId", "constraintHash", "artifactHash", "state", "responseRef", "errorCode", "createdAt", "updatedAt"`

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505")
}

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new ApplicationSubmitRepositoryError("invalid_state", "The database returned an invalid submission timestamp.")
  return date
}

function asAttempt(row: Record<string, unknown>): SubmissionAttempt {
  const state = row.state
  if (!(["reserved", "submitted", "failed"] as const).includes(state as SubmissionAttemptState) || typeof row.id !== "string" || typeof row.userId !== "string" || typeof row.jobId !== "string" || typeof row.receiptId !== "string" || typeof row.constraintHash !== "string" || typeof row.artifactHash !== "string") {
    throw new ApplicationSubmitRepositoryError("invalid_state", "The database returned an invalid submission attempt.")
  }
  return {
    id: row.id, userId: row.userId, jobId: row.jobId, receiptId: row.receiptId,
    constraintHash: row.constraintHash, artifactHash: row.artifactHash, state: state as SubmissionAttemptState,
    responseRef: typeof row.responseRef === "string" ? row.responseRef : null,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    createdAt: asDate(row.createdAt), updatedAt: asDate(row.updatedAt),
  }
}

function asTarget(row: Record<string, unknown>): ApplicationTarget {
  if (typeof row.id !== "string" || typeof row.userId !== "string" || typeof row.company !== "string" || typeof row.role !== "string" || typeof row.url !== "string" || !row.url.trim()) {
    throw new ApplicationSubmitRepositoryError("not_found", "The application target has no usable server-owned URL.")
  }
  return { id: row.id, userId: row.userId, jobId: row.id, company: row.company, role: row.role, applyUrl: row.url, source: typeof row.source === "string" ? row.source : null }
}

export function createApplicationSubmitRepository(pool: Pool) {
  return {
    async findTarget(userId: string, applicationTargetId: string): Promise<ApplicationTarget | null> {
      const result = await pool.query<Record<string, unknown>>(
        `SELECT "id", "userId", "company", "role", "url", "source" FROM "Job" WHERE "id" = $1 AND "userId" = $2 AND "url" IS NOT NULL`,
        [applicationTargetId, userId],
      )
      return result.rows[0] ? asTarget(result.rows[0]) : null
    },

    async findAttempt(userId: string, receiptId: string): Promise<SubmissionAttempt | null> {
      const result = await pool.query<Record<string, unknown>>(
        `SELECT ${attemptColumns} FROM "submission_attempt" WHERE "userId" = $1 AND "receiptId" = $2`,
        [userId, receiptId],
      )
      return result.rows[0] ? asAttempt(result.rows[0]) : null
    },

    async reserve(input: ReserveSubmissionInput): Promise<{ kind: "reserved" | "replay"; attempt: SubmissionAttempt }> {
      try {
        const result = await pool.query<Record<string, unknown>>(
          `INSERT INTO "submission_attempt" (${attemptColumns}) VALUES ($1, $2, $3, $4, $5, $6, 'reserved', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING ${attemptColumns}`,
          [randomUUID(), input.userId, input.jobId, input.receiptId, input.constraintHash, input.artifactHash],
        )
        return { kind: "reserved", attempt: asAttempt(result.rows[0] ?? {}) }
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) throw error
        const existing = await this.findAttempt(input.userId, input.receiptId)
        if (existing) return { kind: "replay", attempt: existing }
        throw new ApplicationSubmitRepositoryError("idempotency_replay", "A submission attempt already exists outside the current tenant.")
      }
    },

    async markSubmitted(userId: string, receiptId: string, responseRef: string): Promise<SubmissionAttempt> {
      const result = await pool.query<Record<string, unknown>>(
        `UPDATE "submission_attempt" SET "state" = 'submitted', "responseRef" = $1, "errorCode" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = $2 AND "receiptId" = $3 AND "state" = 'reserved' RETURNING ${attemptColumns}`,
        [responseRef, userId, receiptId],
      )
      if (result.rows[0]) return asAttempt(result.rows[0])
      const current = await this.findAttempt(userId, receiptId)
      if (current?.state === "submitted" && current.responseRef === responseRef) return current
      throw new ApplicationSubmitRepositoryError("invalid_state", "The submission attempt is no longer reservable.")
    },

    async markFailed(userId: string, receiptId: string, errorCode: string): Promise<SubmissionAttempt> {
      const result = await pool.query<Record<string, unknown>>(
        `UPDATE "submission_attempt" SET "state" = 'failed', "errorCode" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = $2 AND "receiptId" = $3 AND "state" = 'reserved' RETURNING ${attemptColumns}`,
        [errorCode, userId, receiptId],
      )
      if (result.rows[0]) return asAttempt(result.rows[0])
      const current = await this.findAttempt(userId, receiptId)
      if (current?.state === "failed") return current
      throw new ApplicationSubmitRepositoryError("invalid_state", "The submission attempt cannot be marked failed.")
    },
  }
}
