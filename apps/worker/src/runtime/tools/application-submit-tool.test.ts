import { describe, expect, it, vi } from "vitest"
import type { AgentApproval } from "@jobcopilot/agent-protocol"
import type { PoolClient } from "pg"

import { InMemoryArtifactToolStore } from "./artifact-tools.js"
import { createApplicationSubmitTool, type SubmissionApprovalStore, type SubmissionAttemptStore } from "./application-submit-tool.js"
import type { ApplicationTarget, SubmissionAttempt } from "../../db/application-submit-repo.js"
import type { ApplicationSubmitIdentity } from "../../queue/application-submit-fence.js"
import type { SubmissionRequestIntent } from "../../flows/submission-intent.js"

const userId = "user-a"
const jobId = "job-a"
const constraintHash = "c".repeat(64)
const identity: ApplicationSubmitIdentity = { sessionId: "session-a", fillTurnId: "turn-a", applicationTaskId: "application-a", userId, jobId, approvalId: "receipt-a", constraintHash }
function target(): ApplicationTarget { return { id: jobId, userId, jobId, company: "Acme", role: "Engineer", applyUrl: "https://jobs.example/apply", source: "greenhouse" } }
function approval(resourceHash: string, status: "approved" | "consumed" = "approved"): AgentApproval {
  return {
    schemaVersion: "agent-harness.v2", id: "receipt-a", type: "submit_application", status, title: "Submit", body: "Review", scope: {
      userId, sessionId: identity.sessionId, turnId: identity.fillTurnId, jobId, action: "submit_application", toolCallId: "application-submit:application-a",
      resourceHash, materialHash: "m".repeat(64), answersHash: "a".repeat(64), revision: 1, nonceHash: "n".repeat(64), expiresAt: "2026-09-05T00:00:00.000Z",
    }, scopeHash: constraintHash, payload: {}, decidedAt: "2026-09-04T00:00:00.000Z", consumedAt: status === "consumed" ? "2026-09-04T00:01:00.000Z" : null, createdAt: "2026-09-04T00:00:00.000Z",
  }
}

class Attempts implements SubmissionAttemptStore {
  readonly rows = new Map<string, SubmissionAttempt>()
  superseded = false
  audit: string[] = []
  async reserveAndConsume(attemptIdentity: ApplicationSubmitIdentity, authorize: (client: PoolClient, mode: "new" | "replay") => Promise<{ kind: "authorized"; artifactHash: string } | { kind: "fenced" }>) {
    if (this.superseded) { this.audit.push("claim"); return { kind: "fenced" as const } }
    const existing = this.rows.get(attemptIdentity.approvalId)
    const authorization = await authorize({} as PoolClient, existing ? "replay" : "new")
    if (authorization.kind === "fenced") { this.audit.push("claim"); return { kind: "fenced" as const } }
    if (existing) return { kind: "replay" as const, attempt: existing, artifactHash: existing.artifactHash }
    const now = new Date()
    const attempt: SubmissionAttempt = { id: "attempt-a", userId: attemptIdentity.userId, jobId: attemptIdentity.jobId, receiptId: attemptIdentity.approvalId, constraintHash: attemptIdentity.constraintHash, artifactHash: authorization.artifactHash, state: "reserved", responseRef: null, errorCode: null, createdAt: now, updatedAt: now }
    this.rows.set(attemptIdentity.approvalId, attempt)
    return { kind: "reserved" as const, attempt, artifactHash: authorization.artifactHash }
  }
  async isCurrent() { if (this.superseded) this.audit.push("pre_submit"); return !this.superseded }
  async markSubmitted(_identity: ApplicationSubmitIdentity, responseRef: string) {
    if (this.superseded) { this.audit.push("success"); return { kind: "fenced" as const } }
    const current = this.rows.get("receipt-a")!
    const attempt = { ...current, state: "submitted" as const, responseRef, errorCode: null }
    this.rows.set("receipt-a", attempt)
    return { kind: "updated" as const, attempt }
  }
  async markFailed(_identity: ApplicationSubmitIdentity, errorCode: string) {
    if (this.superseded) { this.audit.push(`failure:${errorCode}`); return { kind: "fenced" as const } }
    const current = this.rows.get("receipt-a")!
    const attempt = { ...current, state: "failed" as const, errorCode }
    this.rows.set("receipt-a", attempt)
    return { kind: "updated" as const, attempt }
  }
}
function context(overrides: Record<string, unknown> = {}) {
  return { scope: { userId }, sessionId: identity.sessionId, turnId: identity.fillTurnId, stepId: "application.submit", taskId: identity.applicationTaskId, signal: new AbortController().signal, capabilities: ["submission"], reportProgress: vi.fn(), ...overrides }
}
function input(overrides: Record<string, unknown> = {}) { return { applicationTargetId: jobId, receiptId: identity.approvalId, constraintHash, ...overrides } }
function harness(options: { resourceHash?: string; approvalError?: string; target?: ApplicationTarget | null } = {}) {
  const artifacts = new InMemoryArtifactToolStore()
  const base = artifacts.registerBase({ id: "artifact-a", type: "resume", jobId, userId, content: "verified resume" })
  const attempts = new Attempts()
  const approvals: SubmissionApprovalStore = {
    inspectSubmissionInTransaction: vi.fn(async () => {
      if (options.approvalError) throw { code: options.approvalError }
      return approval(options.resourceHash ?? base.hash, "consumed")
    }),
    consumeSubmissionInTransaction: vi.fn(async () => {
      if (options.approvalError) throw { code: options.approvalError }
      return approval(options.resourceHash ?? base.hash, "consumed")
    }),
  }
  const submit = vi.fn(async (_input: { beforeSubmit: (intent?: SubmissionRequestIntent) => Promise<boolean> }) => ({ confirmationId: "confirmation-1", postSubmitUrl: "https://jobs.example/confirmation" }))
  const tool = createApplicationSubmitTool({
    identity, targets: { findTarget: vi.fn(async () => options.target === undefined ? target() : options.target) }, attempts, approvals, artifacts, submit,
  })
  return { tool, attempts, approvals, submit, base }
}

describe("application.submit typed tool", () => {
  it("atomically claims the exact application attempt and consumes its receipt before submission", async () => {
    const tested = harness()
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "submitted", confirmationId: "confirmation-1" })
    expect(tested.approvals.consumeSubmissionInTransaction).toHaveBeenCalledOnce()
    expect(tested.attempts.rows.get(identity.approvalId)).toMatchObject({ state: "submitted", responseRef: "confirmation-1" })
    expect(tested.submit).toHaveBeenCalledOnce()
  })

  it("preserves the exact request intent through the provider's final submission guard", async () => {
    const tested = harness()
    const intent: SubmissionRequestIntent = { url: "https://jobs.example/api/applications", method: "POST" }
    tested.submit.mockImplementation(async ({ beforeSubmit }) => {
      await expect(beforeSubmit(intent)).resolves.toBe(true)
      return { confirmationId: "confirmation-1", postSubmitUrl: "https://jobs.example/confirmation" }
    })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "submitted" })
    expect(tested.submit).toHaveBeenCalledOnce()
  })

  it("returns the durable confirmation on a duplicate without calling the provider", async () => {
    const tested = harness()
    await tested.tool.execute(context(), input())
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "replayed", confirmationId: "confirmation-1" })
    expect(tested.submit).toHaveBeenCalledOnce()
    expect(tested.approvals.inspectSubmissionInTransaction).toHaveBeenCalledOnce()
  })

  it("rejects mismatched runtime or queue identity before reading the target or consuming approval", async () => {
    const tested = harness()
    await expect(tested.tool.execute(context({ turnId: "old-turn" }), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_scope_mismatch" })
    await expect(tested.tool.execute(context({ taskId: "different-application-task" }), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_scope_mismatch" })
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("rejects a superseded Turn as audit-only before consuming its old approval", async () => {
    const tested = harness()
    tested.attempts.superseded = true
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_attempt_fenced" })
    expect(tested.attempts.audit).toEqual(["claim"])
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
    expect(tested.attempts.rows.size).toBe(0)
  })

  it("does not persist a late success after the successor Turn is bound", async () => {
    const tested = harness()
    tested.submit.mockImplementation(async () => {
      tested.attempts.superseded = true
      return { confirmationId: "late-confirmation", postSubmitUrl: "https://jobs.example/confirmation" }
    })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_attempt_fenced" })
    expect(tested.attempts.rows.get(identity.approvalId)).toMatchObject({ state: "reserved", responseRef: null })
    expect(tested.attempts.audit).toContain("success")
  })

  it.each([["missing receipt", "approval_not_found"], ["wrong scope", "approval_scope_mismatch"], ["expired receipt", "approval_expired"]])("fails closed for %s", async (_label, errorCode) => {
    const tested = harness({ approvalError: errorCode })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode, output: null })
    expect(tested.submit).not.toHaveBeenCalled()
    expect(tested.attempts.rows.size).toBe(0)
  })

  it("rejects model payload fields before any repository or provider call", async () => {
    const tested = harness()
    await expect(tested.tool.execute(context(), input({ formData: { email: "candidate@example.com" } }))).resolves.toMatchObject({ status: "failed", errorCode: "invalid_input", output: null })
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
  })

  it("fails closed when the approved artifact hash is stale", async () => {
    const tested = harness({ resourceHash: "f".repeat(64) })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "stale_artifact", output: null })
    expect(tested.submit).not.toHaveBeenCalled()
    expect(tested.attempts.rows.get(identity.approvalId)).toMatchObject({ state: "failed", errorCode: "stale_artifact" })
  })

  it("rejects an unknown server target before claim or receipt consumption", async () => {
    const tested = harness({ target: null })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "target_not_found", output: null })
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("maps provider status errors without exposing provider text", async () => {
    const tested = harness()
    tested.submit.mockRejectedValueOnce({ provider: "Greenhouse", statusCode: 422, message: "candidate secret" })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "greenhouse_422", output: null })
    expect(tested.attempts.rows.get(identity.approvalId)).toMatchObject({ state: "failed", errorCode: "greenhouse_422" })
  })
})
