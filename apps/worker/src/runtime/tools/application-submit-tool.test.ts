import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentApproval } from "@jobcopilot/agent-protocol"
import type { PoolClient } from "pg"

import { InMemoryArtifactToolStore } from "./artifact-tools.js"
import { createApplicationSubmitTool, type SubmissionApprovalStore, type SubmissionAttemptStore } from "./application-submit-tool.js"
import type { ApplicationTarget, SubmissionAttempt, SubmissionClaimAuthorizer, SubmissionSourceSelection } from "../../db/application-submit-repo.js"
import type { ApplicationSubmitIdentity } from "../../queue/application-submit-fence.js"
import type { SubmissionRequestIntent } from "../../flows/submission-intent.js"

const userId = "user-a"
const jobId = "job-a"
const constraintHash = "c".repeat(64)
const reviewedRead = vi.hoisted(() => vi.fn())
const reviewedArtifact = vi.hoisted(() => vi.fn())
const objectiveRead = vi.hoisted(() => vi.fn())
const objectiveEvidence = vi.hoisted(() => vi.fn())
vi.mock("../../db/reviewed-application-submit-material.js", () => ({
  readReviewedApplicationSubmitMaterial: reviewedRead, hasReviewedSubmissionArtifact: reviewedArtifact,
}))
vi.mock("../../db/objective-reviewed-application-submit-material.js", () => ({
  readObjectiveReviewedApplicationSubmitMaterial: objectiveRead, hasObjectiveSubmissionManifestEvidence: objectiveEvidence,
}))
const identity: ApplicationSubmitIdentity = { sessionId: "session-a", fillTurnId: "turn-a", applicationTaskId: "application-a", userId, jobId, approvalId: "receipt-a", constraintHash }
const objectiveSource = { schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:2`, reviewTurnId: "review-turn-a", materialProofHash: "b".repeat(64) } as const
const objectiveSelection: SubmissionSourceSelection = { kind: "objective", source: objectiveSource }
const objectiveMaterial = { reviewedResumeContent: { basics: { name: "Candidate" } }, reviewedCoverLetter: "Approved private letter",
  confirmedAnswers: { city: "Dublin" }, approvedApplyUrl: "https://boards.greenhouse.io/acme/jobs/123" }
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
  constructor(readonly source: SubmissionSourceSelection = { kind: "absent" }) {}
  async reserveAndConsume(attemptIdentity: ApplicationSubmitIdentity, authorize: SubmissionClaimAuthorizer) {
    if (this.superseded) { this.audit.push("claim"); return { kind: "fenced" as const } }
    const existing = this.rows.get(attemptIdentity.approvalId)
    const authorization = await authorize({} as PoolClient, existing ? "replay" : "new", this.source)
    if (authorization.kind === "fenced") { this.audit.push("claim"); return { kind: "fenced" as const } }
    if (existing) return { kind: "replay" as const, attempt: existing, artifactHash: existing.artifactHash }
    const now = new Date()
    const attempt: SubmissionAttempt = { id: "attempt-a", userId: attemptIdentity.userId, jobId: attemptIdentity.jobId, receiptId: attemptIdentity.approvalId, constraintHash: attemptIdentity.constraintHash, artifactHash: authorization.artifactHash, state: "reserved", responseRef: null, errorCode: null, createdAt: now, updatedAt: now }
    this.rows.set(attemptIdentity.approvalId, attempt)
    return { kind: "reserved" as const, attempt, artifactHash: authorization.artifactHash,
      ...(authorization.reviewedCoverLetter ? { reviewedCoverLetter: authorization.reviewedCoverLetter } : {}),
      ...(authorization.objectiveMaterial ? { objectiveMaterial: authorization.objectiveMaterial } : {}) }
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
function harness(options: { resourceHash?: string; approvalError?: string; target?: ApplicationTarget | null; source?: SubmissionSourceSelection } = {}) {
  const artifacts = new InMemoryArtifactToolStore()
  const base = artifacts.registerBase({ id: "artifact-a", type: "resume", jobId, userId, content: "verified resume" })
  const attempts = new Attempts(options.source)
  const approvals: SubmissionApprovalStore = {
    inspectSubmissionInTransaction: vi.fn(async () => {
      if (options.approvalError) throw { code: options.approvalError }
      return approval(options.resourceHash ?? base.hash.slice("sha256:".length), "consumed")
    }),
    consumeSubmissionInTransaction: vi.fn(async () => {
      if (options.approvalError) throw { code: options.approvalError }
      return approval(options.resourceHash ?? base.hash.slice("sha256:".length), "consumed")
    }),
  }
  const submit = vi.fn(async (_input: { beforeSubmit: (intent?: SubmissionRequestIntent) => Promise<boolean> }) => ({ confirmationId: "confirmation-1", postSubmitUrl: "https://jobs.example/confirmation" }))
  const tool = createApplicationSubmitTool({
    identity, targets: { findTarget: vi.fn(async () => options.target === undefined ? target() : options.target) }, attempts, approvals, artifacts, submit,
  })
  return { tool, attempts, approvals, artifacts, submit, base }
}

describe("application.submit typed tool", () => {
  beforeEach(() => { reviewedRead.mockReset(); reviewedArtifact.mockReset(); objectiveRead.mockReset(); objectiveEvidence.mockReset() })
  it("matches the bare approved digest to the exact persisted artifact hash before submission", async () => {
    const tested = harness()
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "submitted", confirmationId: "confirmation-1" })
    expect(tested.approvals.consumeSubmissionInTransaction).toHaveBeenCalledOnce()
    expect(tested.attempts.rows.get(identity.approvalId)).toMatchObject({
      state: "submitted", responseRef: "confirmation-1", artifactHash: tested.base.hash.slice("sha256:".length),
    })
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

  it("validates the legacy artifact before the initial submission guard", async () => {
    const tested = harness(), order: string[] = []
    const read = tested.artifacts.read.bind(tested.artifacts)
    vi.spyOn(tested.artifacts, "read").mockImplementation(async (...args) => {
      order.push("artifact")
      return read(...args)
    })
    vi.spyOn(tested.attempts, "isCurrent").mockImplementation(async () => {
      order.push("guard")
      return false
    })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_guard_denied" })
    expect(order).toEqual(["artifact", "guard"])
    expect(tested.submit).not.toHaveBeenCalled()
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

  it("does not consume a reviewed approval through a provider without explicit material capability", async () => {
    const tested = harness({ source: { kind: "selected", sourceTurnId: "source-turn" } })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_attempt_fenced" })
    expect(tested.approvals.inspectSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("does not downgrade an exact reviewed artifact to legacy mode when the Turn selector is absent", async () => {
    const tested = harness()
    reviewedArtifact.mockResolvedValue(true)
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_attempt_fenced" })
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("passes the transient reviewed cover letter only to a capability-aware provider after proof validation", async () => {
    const tested = harness({ source: { kind: "selected", sourceTurnId: "source-turn" } })
    Object.assign(tested.submit, { acceptsReviewedApplicationMaterial: true as const })
    reviewedRead.mockResolvedValue({ artifactHash: tested.base.hash.slice("sha256:".length), reviewedCoverLetter: "verified letter" })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "submitted" })
    expect(reviewedRead).toHaveBeenCalledWith(expect.objectContaining({
      identity, sourceTurnId: "source-turn", currentSource: true,
    }))
    expect(tested.approvals.inspectSubmissionInTransaction).toHaveBeenCalledOnce()
    expect(tested.approvals.consumeSubmissionInTransaction).toHaveBeenCalledOnce()
    expect(tested.submit).toHaveBeenCalledWith(expect.objectContaining({ reviewedCoverLetter: "verified letter" }))
  })

  it("preserves a reviewed historical read-only replay without requiring provider capability", async () => {
    const tested = harness({ source: { kind: "selected", sourceTurnId: "source-turn" } })
    const artifactHash = tested.base.hash.slice("sha256:".length)
    tested.attempts.rows.set(identity.approvalId, {
      id: "attempt-a", userId, jobId, receiptId: identity.approvalId, constraintHash, artifactHash,
      state: "submitted", responseRef: "prior-confirmation", errorCode: null, createdAt: new Date(), updatedAt: new Date(),
    })
    reviewedRead.mockResolvedValue({ artifactHash })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "replayed", confirmationId: "prior-confirmation" })
    expect(tested.approvals.inspectSubmissionInTransaction).toHaveBeenCalledOnce()
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(reviewedRead).toHaveBeenCalledWith(expect.objectContaining({ currentSource: false }))
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("does not consume an Objective receipt without the separate Objective provider capability", async () => {
    const tested = harness({ source: objectiveSelection })
    objectiveRead.mockResolvedValue({ artifactHash: tested.base.hash.slice("sha256:".length), packet: objectiveMaterial, objectiveSource })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_attempt_fenced" })
    expect(tested.approvals.inspectSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("does not consume Objective approval when the dedicated provider rejects the exact destination", async () => {
    const tested = harness({ source: objectiveSelection })
    objectiveRead.mockResolvedValue({ artifactHash: tested.base.hash.slice("sha256:".length), packet: objectiveMaterial, objectiveSource })
    Object.assign(tested.submit, { acceptsObjectiveReviewedApplicationMaterial: true as const,
      supportsObjectiveApplicationSubmitTarget: () => false })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "submission_attempt_fenced" })
    expect(tested.approvals.inspectSubmissionInTransaction).toHaveBeenCalledOnce()
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("passes the exact transient Objective packet and approved URL only after fresh claim", async () => {
    const tested = harness({ source: objectiveSelection })
    const artifactList = vi.spyOn(tested.artifacts, "listForUser")
    objectiveRead.mockResolvedValue({ artifactHash: tested.base.hash.slice("sha256:".length), packet: objectiveMaterial, objectiveSource })
    Object.assign(tested.submit, { acceptsObjectiveReviewedApplicationMaterial: true as const,
      supportsObjectiveApplicationSubmitTarget: (url: unknown) => url === objectiveMaterial.approvedApplyUrl })
    const result = await tested.tool.execute(context(), input())
    expect(result).toMatchObject({ status: "submitted", output: { confirmationId: "confirmation-1" } })
    expect(objectiveRead).toHaveBeenCalledWith(expect.objectContaining({
      identity, turnInput: { reviewedApplicationMaterialSource: objectiveSource }, phase: "authorize",
    }))
    expect(tested.submit).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ applyUrl: objectiveMaterial.approvedApplyUrl }), objectiveMaterial,
    }))
    expect(tested.submit.mock.calls[0]?.[0]).not.toHaveProperty("artifact")
    expect(artifactList).not.toHaveBeenCalled()
    expect(tested.approvals.consumeSubmissionInTransaction).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain("Approved private letter")
  })

  it("replays an exact Objective receipt without rereading material or calling the provider", async () => {
    const tested = harness({ source: objectiveSelection })
    tested.attempts.rows.set(identity.approvalId, { ...tested.attempts.rows.get(identity.approvalId),
      id: "attempt-a", userId, jobId, receiptId: identity.approvalId, constraintHash,
      artifactHash: tested.base.hash.slice("sha256:".length), state: "submitted", responseRef: "prior-confirmation",
      errorCode: null, createdAt: new Date(), updatedAt: new Date() })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "replayed", confirmationId: "prior-confirmation" })
    expect(objectiveRead).not.toHaveBeenCalled()
    expect(tested.approvals.consumeSubmissionInTransaction).not.toHaveBeenCalled()
    expect(tested.submit).not.toHaveBeenCalled()
  })

  it("fails closed when the approved artifact hash is stale", async () => {
    const tested = harness({ resourceHash: "f".repeat(64) })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "stale_artifact", output: null })
    expect(tested.submit).not.toHaveBeenCalled()
    expect(tested.attempts.rows.get(identity.approvalId)).toMatchObject({ state: "failed", errorCode: "stale_artifact" })
  })

  it.each([
    ["prefixed", `sha256:${"f".repeat(64)}`],
    ["uppercase", "A".repeat(64)],
    ["trailing newline", `${"f".repeat(64)}\n`],
  ])("fails closed for a malformed approved artifact digest (%s)", async (_label, resourceHash) => {
    const tested = harness({ resourceHash })
    await expect(tested.tool.execute(context(), input())).resolves.toMatchObject({ status: "failed", errorCode: "stale_artifact", output: null })
    expect(tested.submit).not.toHaveBeenCalled()
    expect(tested.attempts.rows.get(identity.approvalId)).toMatchObject({ state: "failed", errorCode: "stale_artifact" })
  })

  it("fails closed when the re-read persisted hash is malformed", async () => {
    const tested = harness()
    vi.spyOn(tested.artifacts, "read").mockResolvedValue({ ...tested.base, hash: `${tested.base.hash}\n` })
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
