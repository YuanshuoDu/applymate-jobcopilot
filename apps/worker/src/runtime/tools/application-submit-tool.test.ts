import { describe, expect, it, vi } from "vitest"
import type { AgentApproval } from "@jobcopilot/agent-protocol"

import { InMemoryArtifactToolStore } from "./artifact-tools.js"
import { createApplicationSubmitTool, type SubmissionApprovalStore, type SubmissionAttemptStore } from "./application-submit-tool.js"
import type { ApplicationTarget, SubmissionAttempt } from "../../db/application-submit-repo.js"

const userId = "user-a"
const jobId = "job-a"
const constraintHash = "c".repeat(64)

function target(): ApplicationTarget {
  return { id: jobId, userId, jobId, company: "Acme", role: "Engineer", applyUrl: "https://jobs.example/apply", source: "greenhouse" }
}

function approval(resourceHash: string, status: "approved" | "consumed" = "approved"): AgentApproval {
  return {
    schemaVersion: "agent-harness.v2", id: "receipt-a", type: "submit_application", status, title: "Submit", body: "Review", scope: {
      userId, sessionId: "session-a", turnId: "turn-a", jobId, toolCallId: "call-a", action: "submit_application",
      resourceHash, materialHash: "m".repeat(64), answersHash: "a".repeat(64), revision: 1, nonceHash: "n".repeat(64), expiresAt: "2026-09-05T00:00:00.000Z",
    }, scopeHash: constraintHash, payload: {}, decidedAt: "2026-09-04T00:00:00.000Z", consumedAt: status === "consumed" ? "2026-09-04T00:01:00.000Z" : null, createdAt: "2026-09-04T00:00:00.000Z",
  }
}

class Attempts implements SubmissionAttemptStore {
  readonly rows = new Map<string, SubmissionAttempt>()
  async findAttempt(_userId: string, receiptId: string): Promise<SubmissionAttempt | null> { return this.rows.get(receiptId) ?? null }
  async reserve(input: { userId: string; jobId: string; receiptId: string; constraintHash: string; artifactHash: string }) {
    const existing = this.rows.get(input.receiptId)
    if (existing) return { kind: "replay" as const, attempt: existing }
    const now = new Date()
    const attempt: SubmissionAttempt = { id: "attempt-a", ...input, state: "reserved", responseRef: null, errorCode: null, createdAt: now, updatedAt: now }
    this.rows.set(input.receiptId, attempt)
    return { kind: "reserved" as const, attempt }
  }
  async markSubmitted(_userId: string, receiptId: string, responseRef: string) {
    const current = this.rows.get(receiptId)!
    const next = { ...current, state: "submitted" as const, responseRef, errorCode: null }
    this.rows.set(receiptId, next)
    return next
  }
  async markFailed(_userId: string, receiptId: string, errorCode: string) {
    const current = this.rows.get(receiptId)!
    const next = { ...current, state: "failed" as const, errorCode }
    this.rows.set(receiptId, next)
    return next
  }
}

function context() {
  return { scope: { userId }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", signal: new AbortController().signal, capabilities: ["submission"], reportProgress: vi.fn() }
}

function harness(options: { resourceHash?: string; approvalError?: string; target?: ApplicationTarget | null; artifactHash?: string } = {}) {
  const artifacts = new InMemoryArtifactToolStore()
  const base = artifacts.registerBase({ id: "artifact-a", type: "resume", jobId, userId, content: "verified resume" })
  const attempts = new Attempts()
  const approvals: SubmissionApprovalStore = {
    inspectSubmission: vi.fn(async () => {
      if (options.approvalError) throw { code: options.approvalError }
      return approval(options.resourceHash ?? base.hash)
    }),
    consumeSubmission: vi.fn(async () => approval(options.resourceHash ?? base.hash, "consumed")),
  }
  const submit = vi.fn(async () => ({ confirmationId: "confirmation-1", postSubmitUrl: "https://jobs.example/confirmation" }))
  const tool = createApplicationSubmitTool({
    targets: { findTarget: vi.fn(async () => options.target === undefined ? target() : options.target) }, attempts, approvals, artifacts, submit,
  })
  return { tool, attempts, approvals, submit, base }
}

function input(overrides: Record<string, unknown> = {}) {
  return { applicationTargetId: jobId, receiptId: "receipt-a", constraintHash, ...overrides }
}

describe("application.submit typed tool", () => {
  it("reserves, consumes, checks the fresh artifact, and submits once", async () => {
    const tested = harness()
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "submitted", confirmationId: "confirmation-1" })
    expect(tested.submit).toHaveBeenCalledOnce()
    expect(tested.attempts.rows.get("receipt-a")).toMatchObject({ state: "submitted", responseRef: "confirmation-1" })
  })

  it("returns the durable confirmation on a duplicate without calling the provider", async () => {
    const tested = harness()
    await tested.tool.execute(context(), input())
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "replayed", confirmationId: "confirmation-1" })
    expect(tested.submit).toHaveBeenCalledOnce()
  })

  it("does not replay a receipt for a different target or constraint set", async () => {
    const tested = harness()
    await tested.tool.execute(context(), input())
    await expect(tested.tool.execute(context(), input({ applicationTargetId: "job-b" }))).resolves.toMatchObject({ status: "failed", errorCode: "idempotency_conflict", output: null })
    expect(tested.submit).toHaveBeenCalledOnce()
  })

  it.each([
    ["missing receipt", "approval_not_found"],
    ["wrong user scope", "approval_scope_mismatch"],
    ["expired receipt", "approval_expired"],
    ["wrong scope hash", "approval_scope_mismatch"],
  ])("fails closed for %s", async (_label, errorCode) => {
    const tested = harness({ approvalError: errorCode })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode, output: null })
    expect(tested.submit).not.toHaveBeenCalled()
    expect(tested.attempts.rows).toHaveLength(0)
  })

  it("rejects model payload fields before any repository or provider call", async () => {
    const tested = harness()
    await expect(tested.tool.execute(context(), input({ formData: { email: "candidate@example.com" } }))).resolves.toMatchObject({ status: "failed", errorCode: "invalid_input", output: null })
    expect(tested.submit).not.toHaveBeenCalled()
    expect(tested.approvals.inspectSubmission).not.toHaveBeenCalled()
  })

  it("fails closed when the approved artifact hash is stale", async () => {
    const tested = harness({ resourceHash: "f".repeat(64) })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "stale_artifact", output: null })
    expect(tested.submit).not.toHaveBeenCalled()
    expect(tested.attempts.rows.get("receipt-a")).toMatchObject({ state: "failed", errorCode: "stale_artifact" })
  })

  it("rejects a cross-tenant or unknown server target", async () => {
    const tested = harness({ target: null })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "target_not_found", output: null })
    expect(tested.approvals.inspectSubmission).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("maps provider status errors without exposing provider text", async () => {
    const tested = harness()
    tested.submit.mockRejectedValueOnce({ provider: "Greenhouse", statusCode: 422, message: "candidate secret" })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "greenhouse_422", output: null })
    expect(tested.attempts.rows.get("receipt-a")).toMatchObject({ state: "failed", errorCode: "greenhouse_422" })
  })
})
