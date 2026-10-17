import type { Pool, PoolClient } from "pg"
import type { Page } from "playwright-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withCloakContext } from "../../cloak/pool.js"
import { acknowledgeApplicationFillCancellation, completeApplicationFillForReview, failApplicationFillBeforeBrowser, persistApplicationFillWait } from "../../db/application-task-completion.js"
import { generateResumePdf } from "../../db/resume-pdf.js"
import { findFormPattern } from "../../db/form-patterns.js"
import { tailorResumeKeywords } from "../../db/tailor-resume.js"
import { detectBrowserWait, type HarnessResult } from "../../harness/agent-harness.js"
import { inspectFormReviewNeeds } from "../../harness/form-review.js"
import { fillCustomQuestions } from "../../flows/helpers.js"
import { executeBrowserFill } from "../../flows/index.js"
import { evaluateUnattendedApplyControl } from "../../queue/unattended-apply-control.js"
import { checkRateLimit } from "../../rate-limit.js"
import type { SubagentLease } from "./types.js"
import { executeApplicationFillForReview } from "./application-fill-for-review.js"

vi.mock("node:fs", () => ({ unlinkSync: vi.fn() }))
vi.mock("../../cloak/pool.js", () => ({ withCloakContext: vi.fn() }))
vi.mock("../../db/application-task-completion.js", () => ({ acknowledgeApplicationFillCancellation: vi.fn(), completeApplicationFillForReview: vi.fn(), failApplicationFillBeforeBrowser: vi.fn(), persistApplicationFillWait: vi.fn() }))
vi.mock("../../db/resume-pdf.js", () => ({ generateResumePdf: vi.fn() }))
vi.mock("../../db/form-patterns.js", () => ({ findFormPattern: vi.fn() }))
vi.mock("../../db/tailor-resume.js", () => ({ tailorResumeKeywords: vi.fn() }))
vi.mock("../../harness/agent-harness.js", () => ({ detectBrowserWait: vi.fn() }))
vi.mock("../../harness/form-review.js", () => ({ inspectFormReviewNeeds: vi.fn() }))
vi.mock("../../flows/helpers.js", () => ({ fillCustomQuestions: vi.fn() }))
vi.mock("../../flows/index.js", () => ({ executeBrowserFill: vi.fn() }))
vi.mock("../../queue/unattended-apply-control.js", () => ({ evaluateUnattendedApplyControl: vi.fn() }))
vi.mock("../../rate-limit.js", () => ({ checkRateLimit: vi.fn() }))

const browserPageMock = {
  goto: vi.fn(async () => null),
  close: vi.fn(async () => undefined),
  url: vi.fn(() => "https://boards.greenhouse.io/acme/jobs/123"),
}
const browserPage = browserPageMock as unknown as Page

type FillContextFixture = Record<string, unknown>
type QueryResult = { rows: unknown[]; rowCount: number }

function context(overrides: Record<string, unknown> = {}): FillContextFixture {
  return {
    applicationUserId: "user-1", applicationSessionId: "session-1", fillTurnId: "turn-1", fillTurnSessionId: "session-1", fillTurnUserId: "user-1",
    taskStatus: "filling", checkpoint: "taskgraph_fill_queued", resumeId: "resume-1", coverLetterId: null, confirmedAnswers: { salary: "€80,000" },
    jobUserId: "user-1", jobUrl: "https://boards.greenhouse.io/acme/jobs/123", jobTitle: "Engineer", jobCompany: "Acme", jobKeywords: "TypeScript",
    jobDescription: "Build reliable systems", jobCoverLetter: null, accountStatus: "active", userName: "DB Candidate", userEmail: "db@example.test",
    userPhone: "+353000000", userLocation: "Dublin", userLinkedin: "https://linkedin.test/db", personaFields: [{ key: "firstName", value: "DB" }],
    resumeContent: { summary: "Server resume" }, coverLetterContent: null, sessionUserId: "user-1", sessionStatus: "running",
    turnUserId: "user-1", turnSessionId: "session-1", turnStatus: "in_progress", ...overrides,
  }
}

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return {
    id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1,
    role: "application_filler", taskType: "application_fill_for_review", status: "running", goal: "Fill for review", constraints: [], successCriteria: [],
    allowedActions: [], context: { applyUrl: "https://attacker.test", jobId: "client-job", persona: { fullName: "Client value" } }, expectedOutputSchema: {},
    result: null, failureReason: null, attemptCount: 1, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000),
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal, ...overrides,
  }
}

function poolFor(row: FillContextFixture | null, options: { interruptBeforeStart?: boolean; delaySessionLockMs?: number } = {}): { pool: Pool; connects: ReturnType<typeof vi.fn>; queries: ReturnType<typeof vi.fn> } {
  let transactionStartedAt = Date.now()
  const queries = vi.fn(async (sql: string, values?: unknown[]): Promise<QueryResult> => {
    if (sql === "BEGIN") { transactionStartedAt = Date.now(); return { rows: [], rowCount: 0 } }
    if (["COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT app."userId"')) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    if (sql.includes("SELECT status FROM agent_sessions")) {
      if (options.delaySessionLockMs) vi.setSystemTime(new Date(Date.now() + options.delaySessionLockMs))
      return { rows: [{ status: "running" }], rowCount: 1 }
    }
    if (sql.includes("SELECT status FROM agent_turns")) return { rows: [{ status: typeof row?.turnStatus === "string" ? row.turnStatus : "in_progress" }], rowCount: 1 }
    if (sql.includes('SELECT sub."id"')) {
      const expiry = values?.[8] instanceof Date ? values[8].getTime() : Number.POSITIVE_INFINITY
      const checkedAt = sql.includes("clock_timestamp()") ? Date.now() : transactionStartedAt
      return options.interruptBeforeStart || expiry <= checkedAt ? { rows: [], rowCount: 0 } : { rows: [{ id: "child-1" }], rowCount: 1 }
    }
    if (sql.includes('SELECT "status","checkpoint"')) return { rows: [{ status: "filling", checkpoint: "taskgraph_fill_queued" }], rowCount: 1 }
    if (sql.startsWith("UPDATE application_tasks")) return { rows: [{ fillTurnId: "turn-1" }], rowCount: 1 }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const client = { query: queries, release: vi.fn() } as unknown as PoolClient
  const connects = vi.fn(async () => client)
  return { pool: { connect: connects } as unknown as Pool, connects, queries }
}

function setMocks(): void {
  vi.mocked(withCloakContext).mockImplementation(async (_userId, run) => run(browserPage))
  vi.mocked(completeApplicationFillForReview).mockResolvedValue({ status: "completed" })
  vi.mocked(acknowledgeApplicationFillCancellation).mockResolvedValue({ status: "cancelled" })
  vi.mocked(failApplicationFillBeforeBrowser).mockResolvedValue({ status: "failed" })
  vi.mocked(persistApplicationFillWait).mockResolvedValue({ status: "waiting" })
  browserPageMock.goto.mockResolvedValue(null)
  browserPageMock.close.mockResolvedValue(undefined)
  vi.mocked(generateResumePdf).mockResolvedValue("/tmp/resume.pdf")
  vi.mocked(tailorResumeKeywords).mockImplementation(content => content)
  vi.mocked(findFormPattern).mockResolvedValue(null)
  vi.mocked(detectBrowserWait).mockResolvedValue(null)
  vi.mocked(inspectFormReviewNeeds).mockResolvedValue({ missing: [], sensitive: [] })
  vi.mocked(fillCustomQuestions).mockResolvedValue(undefined)
  vi.mocked(executeBrowserFill).mockResolvedValue({ status: "manual", error: null, durationMs: 3, reviewReady: true } as HarnessResult)
  vi.mocked(evaluateUnattendedApplyControl).mockResolvedValue({ allowed: true, flow: "greenhouse", message: null })
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as Awaited<ReturnType<typeof checkRateLimit>>)
}

beforeEach(() => { vi.resetAllMocks(); setMocks() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe("executeApplicationFillForReview", () => {
  it.each([["role", { role: "analyst" }], ["task type", { taskType: "application_fill" }]])("rejects an unexpected exact %s before querying task context", async (_name, leaseOverride) => {
    const { pool, connects } = poolFor(context())
    const result = await executeApplicationFillForReview({ pool, lease: lease(leaseOverride as Partial<SubagentLease>) })
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_role_invalid" })
    expect(connects).not.toHaveBeenCalled()
    expect(withCloakContext).not.toHaveBeenCalled()
  })

  it.each([
    ["tenant", { userId: "other-user" }, {}],
    ["session", { sessionId: "other-session" }, {}],
    ["turn", { turnId: "other-turn" }, {}],
    ["bound fill turn", {}, { fillTurnId: "other-turn" }],
    ["helper user", {}, { fillTurnUserId: "other-user" }],
    ["helper session", {}, { fillTurnSessionId: "other-session" }],
  ])("rejects %s mismatch before browser start", async (_name, leaseOverride, rowOverride) => {
    const { pool, connects } = poolFor(context(rowOverride as Record<string, unknown>))
    const result = await executeApplicationFillForReview({ pool, lease: lease(leaseOverride as Partial<SubagentLease>) })
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_scope_mismatch" })
    expect(connects).toHaveBeenCalledTimes(1)
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it("builds fill input from tenant-scoped DB context and can only fill for review", async () => {
    const { pool, queries } = poolFor(context())
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "completed", result: { status: "filled_for_user_review" } })
    const fill = vi.mocked(executeBrowserFill).mock.calls[0]?.[0] as Record<string, unknown>
    expect(fill).toMatchObject({
      jobId: "server-bound-application", applyUrl: "https://boards.greenhouse.io/acme/jobs/123", atsType: "greenhouse", submit: false,
      jobTitle: "Engineer", jobCompany: "Acme", persona: { fullName: "DB Candidate", email: "db@example.test", firstName: "DB" },
    })
    expect(JSON.stringify(fill)).not.toContain("attacker.test")
    expect(JSON.stringify(fill)).not.toContain("client-job")
    expect(fillCustomQuestions).toHaveBeenCalledWith(browserPage, expect.objectContaining({ email: "db@example.test" }), [], { salary: "€80,000" })
    expect(vi.mocked(executeBrowserFill).mock.calls[0]?.[0]).not.toHaveProperty("confirmedAnswers")
    expect(JSON.stringify(vi.mocked(executeBrowserFill).mock.calls[0]?.[0])).not.toContain("€80,000")
    expect(queries.mock.calls.find(([sql]) => sql.includes('SELECT app."userId"'))?.[1]).toEqual(["user-1", "session-1", "turn-1"])
    expect(completeApplicationFillForReview).toHaveBeenCalledWith(pool, { lease: expect.objectContaining({ turnId: "turn-1" }) })
    expect(executeBrowserFill).toHaveBeenCalledTimes(1)
  })

  it("starts the exact bound fill after the root Turn has handed off to a dependency wait", async () => {
    const { pool } = poolFor(context({ turnStatus: "waiting_for_dependency" }))

    const result = await executeApplicationFillForReview({ pool, lease: lease() })

    expect(result).toMatchObject({ status: "completed", result: { status: "filled_for_user_review" } })
    expect(withCloakContext).toHaveBeenCalledOnce()
    expect(executeBrowserFill).toHaveBeenCalledWith(expect.objectContaining({ submit: false }), expect.anything())
    expect(completeApplicationFillForReview).toHaveBeenCalledWith(pool, { lease: expect.objectContaining({ turnId: "turn-1" }) })
  })

  it("persists an uncertain wait when post-fill form inspection fails", async () => {
    const { pool } = poolFor(context())
    vi.mocked(inspectFormReviewNeeds).mockRejectedValue(new Error("DOM inspection failed"))

    const result = await executeApplicationFillForReview({ pool, lease: lease() })

    expect(result).toMatchObject({ status: "waiting_for_user", failureReason: "fill_outcome_uncertain" })
    expect(persistApplicationFillWait).toHaveBeenCalledWith(pool, expect.objectContaining({ checkpoint: "fill_outcome_uncertain", detail: "fill_outcome_uncertain" }))
    expect(completeApplicationFillForReview).not.toHaveBeenCalled()
  })

  it("preserves bounded wait labels and opaque keys without sending confirmed answers to the browser agent", async () => {
    const { pool } = poolFor(context({ confirmedAnswers: { ["form-answer-v2-" + "a".repeat(64)]: "Private candidate answer" } }))
    const needs = {
      missing: [{ key: "form-answer-v2-" + "b".repeat(64), label: "Work authorization" }],
      sensitive: [{ key: "form-answer-v2-" + "c".repeat(64), label: "Salary expectation" }],
    }
    vi.mocked(inspectFormReviewNeeds).mockResolvedValue(needs)

    const result = await executeApplicationFillForReview({ pool, lease: lease() })

    expect(result).toMatchObject({ status: "waiting_for_user", failureReason: "unknown_sensitive_field" })
    expect(persistApplicationFillWait).toHaveBeenCalledWith(pool, expect.objectContaining({ needs }))
    expect(JSON.stringify(vi.mocked(executeBrowserFill).mock.calls[0]?.[0])).not.toContain("Private candidate answer")
  })

  it("recovers browser_active as a durable uncertain wait without relaunching", async () => {
    const { pool, connects } = poolFor(context({ checkpoint: "browser_active" }))
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "waiting_for_user", failureReason: "fill_outcome_uncertain" })
    expect(persistApplicationFillWait).toHaveBeenCalledWith(pool, expect.objectContaining({ checkpoint: "fill_outcome_uncertain", detail: "fill_outcome_uncertain" }))
    expect(connects).toHaveBeenCalledTimes(1)
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it.each([["form_answer_required", "review_required"], ["fill_outcome_uncertain", "fill_outcome_uncertain"]])("returns an already-persisted %s wait on redelivery", async (checkpoint, reason) => {
    const { pool, connects } = poolFor(context({ taskStatus: "waiting_for_user", checkpoint, sessionStatus: "waiting_for_user", turnStatus: "waiting_for_user" }))
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "waiting_for_user", failureReason: reason })
    expect(connects).toHaveBeenCalledTimes(1)
    expect(persistApplicationFillWait).not.toHaveBeenCalled()
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it("reports a committed form_filled result only after the completion helper confirms it", async () => {
    const { pool, connects } = poolFor(context({ taskStatus: "waiting_for_authorization", checkpoint: "form_filled", sessionStatus: "waiting_for_user", turnStatus: "waiting_for_approval" }))
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "completed", result: { status: "filled_for_user_review" } })
    expect(completeApplicationFillForReview).toHaveBeenCalledWith(pool, { lease: expect.objectContaining({ turnId: "turn-1" }) })
    expect(connects).toHaveBeenCalledTimes(1)
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it("replays an approved submission decision without restarting the fill", async () => {
    const { pool } = poolFor(context({ taskStatus: "filling", checkpoint: "submission_authorized", sessionStatus: "running", turnStatus: "waiting_for_approval" }))
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "completed", result: { status: "filled_for_user_review" } })
    expect(completeApplicationFillForReview).toHaveBeenCalledWith(pool, { lease: expect.objectContaining({ turnId: "turn-1" }) })
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it("recovers an approved queue retry without restarting the fill", async () => {
    const { pool } = poolFor(context({ taskStatus: "waiting_for_authorization", checkpoint: "queue_retry", sessionStatus: "waiting_for_user", turnStatus: "waiting_for_approval" }))
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "completed", result: { status: "filled_for_user_review" } })
    expect(completeApplicationFillForReview).toHaveBeenCalledWith(pool, { lease: expect.objectContaining({ turnId: "turn-1" }) })
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it("fails closed when the submission decision is consumed or no longer matches", async () => {
    vi.mocked(completeApplicationFillForReview).mockResolvedValue({ status: "conflict" })
    const { pool } = poolFor(context({ taskStatus: "filling", checkpoint: "submission_authorized", sessionStatus: "running", turnStatus: "waiting_for_approval" }))
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_completion_conflict" })
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it.each([
    ["captcha", "captcha_required"], ["login_required", "authentication_required"], ["mfa_required", "mfa_required"],
    ["unknown_sensitive_field", "unknown_sensitive_field"], ["stale_review", "stale_review"],
  ])("maps %s to a fixed user wait", async (reason, detail) => {
    vi.mocked(detectBrowserWait).mockResolvedValue({ reason: reason as "captcha", message: "Never persist this page text" })
    const { pool } = poolFor(context())
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "waiting_for_user", failureReason: detail })
    expect(persistApplicationFillWait).toHaveBeenCalledWith(pool, expect.objectContaining({ checkpoint: "form_answer_required", detail }))
    expect(JSON.stringify(vi.mocked(persistApplicationFillWait).mock.calls[0]?.[1])).not.toContain("Never persist this page text")
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it("projects a cancelled fill without writing a result or user wait", async () => {
    vi.mocked(executeBrowserFill).mockResolvedValue({ status: "manual", error: "cancelled", durationMs: 1, classification: "cancelled" } as HarnessResult)
    const { pool } = poolFor(context())
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_cancelled" })
    expect(acknowledgeApplicationFillCancellation).toHaveBeenCalledWith(pool, { lease: expect.objectContaining({ turnId: "turn-1" }) })
    expect(persistApplicationFillWait).not.toHaveBeenCalled()
    expect(completeApplicationFillForReview).not.toHaveBeenCalled()
  })

  it("closes the active page and stops filling when the lease aborts during navigation", async () => {
    const controller = new AbortController()
    let finishNavigation!: () => void
    browserPageMock.goto.mockReturnValue(new Promise<null>(resolve => { finishNavigation = () => resolve(null) }))
    vi.mocked(withCloakContext).mockImplementation(async (_userId, run) => {
      const filling = run(browserPage)
      controller.abort()
      finishNavigation()
      return filling
    })
    const { pool } = poolFor(context())
    const result = await executeApplicationFillForReview({ pool, lease: lease({ signal: controller.signal }) })

    expect(browserPageMock.close).toHaveBeenCalledTimes(1)
    expect(executeBrowserFill).not.toHaveBeenCalled()
    expect(completeApplicationFillForReview).not.toHaveBeenCalled()
    expect(acknowledgeApplicationFillCancellation).toHaveBeenCalledWith(pool, { lease: expect.objectContaining({ turnId: "turn-1" }) })
    expect(persistApplicationFillWait).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_cancelled" })
  })

  it("routes an already-aborted lease to cancellation acknowledgement before reading fill context", async () => {
    const controller = new AbortController(); controller.abort()
    const { pool, connects } = poolFor(context())
    const result = await executeApplicationFillForReview({ pool, lease: lease({ signal: controller.signal }) })
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_cancelled" })
    expect(acknowledgeApplicationFillCancellation).toHaveBeenCalledOnce()
    expect(connects).not.toHaveBeenCalled()
    expect(persistApplicationFillWait).not.toHaveBeenCalled()
    expect(withCloakContext).not.toHaveBeenCalled()
  })

  it("checks durable cancellation when Stop races browser claim", async () => {
    const { pool } = poolFor(context(), { interruptBeforeStart: true })
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_cancelled" })
    expect(acknowledgeApplicationFillCancellation).toHaveBeenCalledWith(pool, { lease: expect.objectContaining({ turnId: "turn-1" }) })
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it("rechecks lease expiry against wall time after the session lock is acquired", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"))
    const { pool, queries } = poolFor(context(), { delaySessionLockMs: 2_000 })
    const currentLease = lease({ leaseExpiresAt: new Date(Date.now() + 1_000) })
    vi.mocked(acknowledgeApplicationFillCancellation).mockResolvedValue({ status: "stale" })

    const result = await executeApplicationFillForReview({ pool, lease: currentLease })

    expect(result).toMatchObject({ status: "failed", failureReason: "lease_lost" })
    const claim = queries.mock.calls.find(([sql]) => sql.includes('SELECT sub."id"'))
    expect(claim?.[0]).toContain('sub."leaseExpiresAt">clock_timestamp()')
    expect(claim?.[0]).not.toContain('sub."leaseExpiresAt">CURRENT_TIMESTAMP')
    expect(acknowledgeApplicationFillCancellation).toHaveBeenCalledOnce()
    expect(withCloakContext).not.toHaveBeenCalled()
    expect(executeBrowserFill).not.toHaveBeenCalled()
  })

  it("commits a terminal pre-browser failure only on the final retry attempt", async () => {
    vi.mocked(generateResumePdf).mockRejectedValue(new Error("resume generation failed"))
    const { pool } = poolFor(context())
    const currentLease = lease({ attemptCount: 3, maxAttempts: 3 })
    const result = await executeApplicationFillForReview({ pool, lease: currentLease })

    expect(failApplicationFillBeforeBrowser).toHaveBeenCalledWith(pool, { lease: currentLease })
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_material_unavailable" })
    expect(result).not.toHaveProperty("retryDisposition", "retryable")
    expect(withCloakContext).not.toHaveBeenCalled()
  })

  it("keeps a pre-browser failure retryable before the final attempt", async () => {
    vi.mocked(generateResumePdf).mockRejectedValue(new Error("resume generation failed"))
    const { pool } = poolFor(context())
    const result = await executeApplicationFillForReview({ pool, lease: lease({ attemptCount: 1, maxAttempts: 3 }) })

    expect(failApplicationFillBeforeBrowser).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: "failed", failureReason: "fill_material_unavailable", retryDisposition: "retryable" })
    expect(withCloakContext).not.toHaveBeenCalled()
  })

  it("keeps browser-start uncertainty terminal and never replays the fill", async () => {
    vi.mocked(withCloakContext).mockRejectedValue(new Error("browser stopped after launch"))
    const { pool } = poolFor(context())
    const result = await executeApplicationFillForReview({ pool, lease: lease() })
    expect(result).toMatchObject({ status: "waiting_for_user", failureReason: "fill_outcome_uncertain" })
    expect(persistApplicationFillWait).toHaveBeenCalledWith(pool, expect.objectContaining({ checkpoint: "fill_outcome_uncertain", detail: "fill_outcome_uncertain" }))
    expect(result).not.toHaveProperty("retryDisposition", "retryable")
  })
})
