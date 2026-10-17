import { Type, type Static } from "@sinclair/typebox"
import type { Pool, PoolClient } from "pg"
import type { AgentApproval } from "@jobcopilot/agent-protocol"

import { assertSubmissionAuthorized } from "../../flows/helpers.js"
import type { SubmissionRequestIntent } from "../../flows/submission-intent.js"
import { createApplicationSubmitRepository, type ApplicationTarget, type SubmissionAttempt, type SubmissionClaim, type SubmissionClaimAuthorizer, type SubmissionAttemptWrite } from "../../db/application-submit-repo.js"
import type { ApplicationSubmitIdentity } from "../../queue/application-submit-fence.js"
import { createPgApprovalStore } from "../approval/pg-store.js"
import { PgArtifactToolStore } from "./artifact-store-pg.js"
import type { ArtifactToolRecord, ArtifactToolStore } from "./artifact-tools.js"
import type { RuntimeToolDefinition, ToolExecutionContext } from "./types.js"

const Id = Type.String({ minLength: 1, maxLength: 256 })
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" })
export const ApplicationSubmitInputSchema = Type.Object({ applicationTargetId: Id, receiptId: Id, constraintHash: Hash }, { additionalProperties: false })
export const ApplicationSubmitOutputSchema = Type.Object({
  status: Type.Union([Type.Literal("submitted"), Type.Literal("replayed"), Type.Literal("failed")]),
  confirmationId: Type.Union([Id, Type.Null()]), postSubmitUrl: Type.Union([Id, Type.Null()]), errorCode: Type.Union([Id, Type.Null()]),
  output: Type.Union([Type.Unknown(), Type.Null()]),
}, { additionalProperties: false })
export type ApplicationSubmitInput = Static<typeof ApplicationSubmitInputSchema>
export type ApplicationSubmitOutput = Static<typeof ApplicationSubmitOutputSchema>

export interface SubmissionApprovalStore {
  inspectSubmissionInTransaction(client: PoolClient, id: string, expected: ApplicationSubmitIdentity, now?: Date): Promise<AgentApproval | null>
  consumeSubmissionInTransaction(client: PoolClient, id: string, expected: ApplicationSubmitIdentity, now?: Date): Promise<AgentApproval | null>
}
export interface SubmissionAttemptStore {
  reserveAndConsume(identity: ApplicationSubmitIdentity, authorize: SubmissionClaimAuthorizer): Promise<SubmissionClaim>
  isCurrent(identity: ApplicationSubmitIdentity): Promise<boolean>
  markSubmitted(identity: ApplicationSubmitIdentity, responseRef: string): Promise<SubmissionAttemptWrite>
  markFailed(identity: ApplicationSubmitIdentity, errorCode: string): Promise<SubmissionAttemptWrite>
}
export type ApplicationSubmitProviderResult = { readonly confirmationId: string; readonly postSubmitUrl?: string | null }
export type ApplicationSubmitProvider = (input: {
  readonly target: ApplicationTarget; readonly artifact: ArtifactToolRecord; readonly context: ToolExecutionContext
  readonly beforeSubmit: (intent?: SubmissionRequestIntent) => Promise<boolean>
}) => Promise<ApplicationSubmitProviderResult>
export type ApplicationSubmitToolDependencies = {
  readonly identity: ApplicationSubmitIdentity; readonly targets: { findTarget(userId: string, applicationTargetId: string): Promise<ApplicationTarget | null> }
  readonly attempts: SubmissionAttemptStore; readonly approvals: SubmissionApprovalStore; readonly artifacts: ArtifactToolStore
  readonly submit: ApplicationSubmitProvider; readonly now?: () => Date
}
function failed(errorCode: string): ApplicationSubmitOutput { return { status: "failed", confirmationId: null, postSubmitUrl: null, errorCode, output: null } }
function fromAttempt(attempt: SubmissionAttempt): ApplicationSubmitOutput {
  return attempt.state === "submitted" && attempt.responseRef
    ? { status: "replayed", confirmationId: attempt.responseRef, postSubmitUrl: null, errorCode: null, output: null }
    : failed(attempt.state === "failed" ? attempt.errorCode ?? "idempotency_conflict" : "submission_in_flight")
}
function matchesAttempt(attempt: SubmissionAttempt, input: ApplicationSubmitInput, identity: ApplicationSubmitIdentity): boolean {
  return attempt.userId === identity.userId && attempt.jobId === identity.jobId && attempt.receiptId === input.receiptId && attempt.constraintHash === input.constraintHash
}
function validInput(value: unknown): value is ApplicationSubmitInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value).sort().join(",")
  if (keys !== "applicationTargetId,constraintHash,receiptId") return false
  const input = value as Record<string, unknown>
  return typeof input.applicationTargetId === "string" && input.applicationTargetId.length > 0 && typeof input.receiptId === "string" && input.receiptId.length > 0 && typeof input.constraintHash === "string" && /^[a-f0-9]{64}$/.test(input.constraintHash)
}
function validIdentity(identity: ApplicationSubmitIdentity, context: ToolExecutionContext, input: ApplicationSubmitInput): boolean {
  return identity.userId === context.scope.userId && identity.sessionId === context.sessionId && identity.fillTurnId === context.turnId &&
    identity.applicationTaskId === context.taskId &&
    identity.jobId === input.applicationTargetId && identity.approvalId === input.receiptId && identity.constraintHash === input.constraintHash &&
    [identity.applicationTaskId, identity.userId, identity.sessionId, identity.fillTurnId, identity.jobId, identity.approvalId].every(value => value.trim().length > 0)
}
function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    const code = String((error as { code: string }).code)
    if (code.startsWith("approval_") || ["browser_412", "browser_manual", "browser_failed", "idempotency_conflict", "idempotency_replay", "invalid_state", "not_found", "submission_attempt_fenced", "submission_scope_mismatch"].includes(code)) return code
  }
  if (!error || typeof error !== "object") return "provider_error"
  const value = error as { provider?: unknown; statusCode?: unknown }
  const provider = typeof value.provider === "string" && /^[a-z0-9_-]+$/i.test(value.provider) ? value.provider.toLowerCase() : "provider"
  const status = typeof value.statusCode === "number" && Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599 ? String(value.statusCode) : "error"
  return `${provider}_${status}`
}
async function readFreshArtifact(store: ArtifactToolStore, userId: string, jobId: string, expectedHash: string): Promise<ArtifactToolRecord | null> {
  const candidates = await store.listForUser(userId, jobId)
  const candidate = candidates.find(item => item.jobId === jobId && item.hash === expectedHash)
  return candidate ? store.read(userId, candidate.id) : null
}

export function createApplicationSubmitTool(deps: ApplicationSubmitToolDependencies): RuntimeToolDefinition {
  return {
    schemaVersion: "agent-harness.v2", name: "application.submit", version: "1",
    description: "Submit one server-owned job application after a single-use approval receipt and fresh artifact check.",
    capabilities: ["write", "external_write", "coordination"], inputSchema: ApplicationSubmitInputSchema, outputSchema: ApplicationSubmitOutputSchema,
    risk: "external_write", domain: "application", idempotency: "requires_key", timeoutMs: 60_000, requiredCapabilities: ["submission"],
    execute: async (context, value) => {
      if (!validInput(value)) return failed("invalid_input")
      const identity = deps.identity
      if (!validIdentity(identity, context, value)) return failed("submission_scope_mismatch")
      const now = deps.now?.() ?? new Date()
      let reserved = false
      let submitSucceeded = false
      try {
        const target = await deps.targets.findTarget(identity.userId, value.applicationTargetId)
        if (!target || target.userId !== identity.userId || target.jobId !== identity.jobId || target.id !== identity.jobId) return failed("target_not_found")
        const authorize: SubmissionClaimAuthorizer = async (client, mode) => {
          const approval = mode === "new"
            ? await deps.approvals.consumeSubmissionInTransaction(client, identity.approvalId, identity, now)
            : await deps.approvals.inspectSubmissionInTransaction(client, identity.approvalId, identity, now)
          return approval ? { kind: "authorized", artifactHash: approval.scope.resourceHash } : { kind: "fenced" }
        }
        const claim = await deps.attempts.reserveAndConsume(identity, authorize)
        if (claim.kind === "fenced") return failed("submission_attempt_fenced")
        if (claim.kind === "replay") return matchesAttempt(claim.attempt, value, identity) ? fromAttempt(claim.attempt) : failed("idempotency_conflict")
        reserved = true
        const artifact = await readFreshArtifact(deps.artifacts, identity.userId, identity.jobId, claim.artifactHash).catch(() => null)
        if (!artifact || artifact.ownerUserId !== identity.userId || artifact.jobId !== identity.jobId || artifact.hash !== claim.artifactHash) {
          await deps.attempts.markFailed(identity, "stale_artifact")
          return failed("stale_artifact")
        }
        const beforeSubmit = async (_intent?: SubmissionRequestIntent): Promise<boolean> => !context.signal.aborted && deps.attempts.isCurrent(identity).catch(() => false)
        const authorization = await assertSubmissionAuthorized(beforeSubmit)
        if (!authorization.authorized) {
          await deps.attempts.markFailed(identity, "submission_guard_denied")
          return failed("submission_guard_denied")
        }
        const result = await deps.submit({ target, artifact, context, beforeSubmit })
        if (!result.confirmationId.trim()) {
          await deps.attempts.markFailed(identity, "provider_invalid_response")
          return failed("provider_invalid_response")
        }
        submitSucceeded = true
        const saved = await deps.attempts.markSubmitted(identity, result.confirmationId)
        if (saved.kind === "fenced") return failed("submission_attempt_fenced")
        return { status: "submitted", confirmationId: result.confirmationId, postSubmitUrl: result.postSubmitUrl ?? null, errorCode: null, output: { confirmationId: result.confirmationId, postSubmitUrl: result.postSubmitUrl ?? null } }
      } catch (error: unknown) {
        const errorCode = safeErrorCode(error)
        if (reserved && !submitSucceeded) await deps.attempts.markFailed(identity, errorCode).catch(() => undefined)
        return failed(errorCode)
      }
    },
  }
}

export function createPgApplicationSubmitTool(options: { pool: Pool; submit: ApplicationSubmitProvider; identity: ApplicationSubmitIdentity }): RuntimeToolDefinition {
  const repository = createApplicationSubmitRepository(options.pool)
  const approvalStore = createPgApprovalStore(options.pool, { userId: options.identity.userId })
  const approvals: SubmissionApprovalStore = {
    inspectSubmissionInTransaction: (client, id, expected, now) => approvalStore.inspectSubmissionInTransaction(client, id, expected, now),
    consumeSubmissionInTransaction: (client, id, expected, now) => approvalStore.consumeSubmissionInTransaction(client, id, expected, now),
  }
  return createApplicationSubmitTool({ identity: options.identity, targets: repository, attempts: repository, approvals, artifacts: new PgArtifactToolStore(options.pool), submit: options.submit })
}
