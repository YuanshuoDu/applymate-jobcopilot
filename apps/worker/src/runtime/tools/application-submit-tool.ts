import { Type, type Static } from "@sinclair/typebox"
import type { Pool } from "pg"
import type { AgentApproval } from "@jobcopilot/agent-protocol"

import { assertSubmissionAuthorized } from "../../flows/helpers.js"
import { createApplicationSubmitRepository, type ApplicationTarget, type SubmissionAttempt } from "../../db/application-submit-repo.js"
import { createPgApprovalStore } from "../approval/pg-store.js"
import { PgArtifactToolStore } from "./artifact-store-pg.js"
import type { ArtifactToolRecord, ArtifactToolStore } from "./artifact-tools.js"
import type { RuntimeToolDefinition, ToolExecutionContext } from "./types.js"

const Id = Type.String({ minLength: 1, maxLength: 256 })
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" })

export const ApplicationSubmitInputSchema = Type.Object({
  applicationTargetId: Id,
  receiptId: Id,
  constraintHash: Hash,
}, { additionalProperties: false })

export const ApplicationSubmitOutputSchema = Type.Object({
  status: Type.Union([Type.Literal("submitted"), Type.Literal("replayed"), Type.Literal("failed")]),
  confirmationId: Type.Union([Id, Type.Null()]),
  postSubmitUrl: Type.Union([Id, Type.Null()]),
  errorCode: Type.Union([Id, Type.Null()]),
  output: Type.Union([Type.Unknown(), Type.Null()]),
}, { additionalProperties: false })

export type ApplicationSubmitInput = Static<typeof ApplicationSubmitInputSchema>
export type ApplicationSubmitOutput = Static<typeof ApplicationSubmitOutputSchema>
export type SubmissionScopeExpectation = { readonly userId: string; readonly jobId: string; readonly scopeHash: string }

export interface SubmissionApprovalStore {
  inspectSubmission(id: string, expected: SubmissionScopeExpectation, now?: Date): Promise<AgentApproval>
  consumeSubmission(id: string, expected: SubmissionScopeExpectation, now?: Date): Promise<AgentApproval>
}

export interface SubmissionAttemptStore {
  findAttempt(userId: string, receiptId: string): Promise<SubmissionAttempt | null>
  reserve(input: { userId: string; jobId: string; receiptId: string; constraintHash: string; artifactHash: string }): Promise<{ kind: "reserved" | "replay"; attempt: SubmissionAttempt }>
  markSubmitted(userId: string, receiptId: string, responseRef: string): Promise<SubmissionAttempt>
  markFailed(userId: string, receiptId: string, errorCode: string): Promise<SubmissionAttempt>
}

export type ApplicationSubmitProviderResult = { readonly confirmationId: string; readonly postSubmitUrl?: string | null }
export type ApplicationSubmitProvider = (input: {
  readonly target: ApplicationTarget
  readonly artifact: ArtifactToolRecord
  readonly context: ToolExecutionContext
  readonly beforeSubmit: () => Promise<boolean>
}) => Promise<ApplicationSubmitProviderResult>

export type ApplicationSubmitToolDependencies = {
  readonly targets: { findTarget(userId: string, applicationTargetId: string): Promise<ApplicationTarget | null> }
  readonly attempts: SubmissionAttemptStore
  readonly approvals: SubmissionApprovalStore
  readonly artifacts: ArtifactToolStore
  readonly submit: ApplicationSubmitProvider
  readonly now?: () => Date
}

function failed(errorCode: string): ApplicationSubmitOutput {
  return { status: "failed", confirmationId: null, postSubmitUrl: null, errorCode, output: null }
}

function fromAttempt(attempt: SubmissionAttempt): ApplicationSubmitOutput {
  if (attempt.state === "submitted" && attempt.responseRef) {
    return { status: "replayed", confirmationId: attempt.responseRef, postSubmitUrl: null, errorCode: null, output: null }
  }
  return failed(attempt.state === "failed" ? attempt.errorCode ?? "idempotency_replay" : "submission_in_flight")
}

function matchesAttempt(attempt: SubmissionAttempt, input: ApplicationSubmitInput, jobId: string): boolean {
  return attempt.jobId === jobId && attempt.constraintHash === input.constraintHash
}

function validInput(value: unknown): value is ApplicationSubmitInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value).sort().join(",")
  if (keys !== "applicationTargetId,constraintHash,receiptId") return false
  const input = value as Record<string, unknown>
  return typeof input.applicationTargetId === "string" && input.applicationTargetId.length > 0 &&
    typeof input.receiptId === "string" && input.receiptId.length > 0 &&
    typeof input.constraintHash === "string" && /^[a-f0-9]{64}$/.test(input.constraintHash)
}

function approvalError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return String((error as { code: string }).code)
  return "approval_validation_failed"
}

function providerError(error: unknown): string {
  if (!error || typeof error !== "object") return "provider_error"
  const value = error as { provider?: unknown; statusCode?: unknown }
  const provider = typeof value.provider === "string" && /^[a-z0-9_-]+$/i.test(value.provider) ? value.provider.toLowerCase() : "provider"
  const status = typeof value.statusCode === "number" && Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599 ? String(value.statusCode) : "error"
  return `${provider}_${status}`
}

function executionError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    const code = String((error as { code: string }).code)
    if (code.startsWith("approval_") || ["idempotency_replay", "invalid_state", "not_found"].includes(code)) return code
  }
  return providerError(error)
}

async function readFreshArtifact(store: ArtifactToolStore, userId: string, jobId: string, expectedHash: string): Promise<ArtifactToolRecord | null> {
  const candidates = await store.listForUser(userId, jobId)
  const candidate = candidates.find(item => item.jobId === jobId && item.hash === expectedHash)
  return candidate ? store.read(userId, candidate.id) : null
}

export function createApplicationSubmitTool(deps: ApplicationSubmitToolDependencies): RuntimeToolDefinition {
  return {
    schemaVersion: "agent-harness.v2",
    name: "application.submit",
    version: "1",
    description: "Submit one server-owned job application after a single-use approval receipt and fresh artifact check.",
    capabilities: ["write", "external_write", "coordination"],
    inputSchema: ApplicationSubmitInputSchema,
    outputSchema: ApplicationSubmitOutputSchema,
    risk: "external_write",
    domain: "application",
    idempotency: "requires_key",
    timeoutMs: 60_000,
    requiredCapabilities: ["submission"],
    execute: async (context, value) => {
      if (!validInput(value)) return failed("invalid_input")
      const now = deps.now?.() ?? new Date()
      const userId = context.scope.userId
      if (!userId.trim()) return failed("tenant_scope_error")
      let reserved = false
      let submitSucceeded = false
      try {
        const existing = await deps.attempts.findAttempt(userId, value.receiptId)
        if (existing) return matchesAttempt(existing, value, value.applicationTargetId) ? fromAttempt(existing) : failed("idempotency_conflict")

        const target = await deps.targets.findTarget(userId, value.applicationTargetId)
        if (!target || target.userId !== userId || target.jobId !== target.id) return failed("target_not_found")

        const expected = { userId, jobId: target.jobId, scopeHash: value.constraintHash }
        const approval = await deps.approvals.inspectSubmission(value.receiptId, expected, now)
        const reservation = await deps.attempts.reserve({ userId, jobId: target.jobId, receiptId: value.receiptId, constraintHash: value.constraintHash, artifactHash: approval.scope.resourceHash })
        if (reservation.kind === "replay") return matchesAttempt(reservation.attempt, value, target.jobId) ? fromAttempt(reservation.attempt) : failed("idempotency_conflict")
        reserved = true

        let consumed: AgentApproval
        try {
          consumed = await deps.approvals.consumeSubmission(value.receiptId, expected, now)
        } catch (error: unknown) {
          await deps.attempts.markFailed(userId, value.receiptId, approvalError(error))
          return failed(approvalError(error))
        }
        let artifact: ArtifactToolRecord | null
        try {
          artifact = await readFreshArtifact(deps.artifacts, userId, target.jobId, consumed.scope.resourceHash)
        } catch {
          await deps.attempts.markFailed(userId, value.receiptId, "stale_artifact")
          return failed("stale_artifact")
        }
        if (!artifact || artifact.ownerUserId !== userId || artifact.jobId !== target.jobId || artifact.hash !== consumed.scope.resourceHash) {
          await deps.attempts.markFailed(userId, value.receiptId, "stale_artifact")
          return failed("stale_artifact")
        }
        const beforeSubmit = async (): Promise<boolean> => !context.signal.aborted
        const authorization = await assertSubmissionAuthorized(beforeSubmit)
        if (!authorization.authorized) {
          await deps.attempts.markFailed(userId, value.receiptId, "submission_guard_denied")
          return failed("submission_guard_denied")
        }
        const result = await deps.submit({ target, artifact, context, beforeSubmit })
        if (!result.confirmationId.trim()) {
          await deps.attempts.markFailed(userId, value.receiptId, "provider_invalid_response")
          return failed("provider_invalid_response")
        }
        submitSucceeded = true
        try {
          await deps.attempts.markSubmitted(userId, value.receiptId, result.confirmationId)
        } catch {
          return failed("submission_persistence_error")
        }
        return { status: "submitted", confirmationId: result.confirmationId, postSubmitUrl: result.postSubmitUrl ?? null, errorCode: null, output: { confirmationId: result.confirmationId, postSubmitUrl: result.postSubmitUrl ?? null } }
      } catch (error: unknown) {
        const errorCode = executionError(error)
        if (reserved && !submitSucceeded) await deps.attempts.markFailed(userId, value.receiptId, errorCode).catch(() => undefined)
        return failed(errorCode)
      }
    },
  }
}

export function createPgApplicationSubmitTool(options: { pool: Pool; submit: ApplicationSubmitProvider }): RuntimeToolDefinition {
  const repository = createApplicationSubmitRepository(options.pool)
  const artifacts = new PgArtifactToolStore(options.pool)
  const approvals: SubmissionApprovalStore = {
    inspectSubmission: (id, expected, now) => createPgApprovalStore(options.pool, { userId: expected.userId }).inspectSubmission(id, expected, now),
    consumeSubmission: (id, expected, now) => createPgApprovalStore(options.pool, { userId: expected.userId }).consumeSubmission(id, expected, now),
  }
  return createApplicationSubmitTool({ targets: repository, attempts: repository, approvals, artifacts, submit: options.submit })
}
