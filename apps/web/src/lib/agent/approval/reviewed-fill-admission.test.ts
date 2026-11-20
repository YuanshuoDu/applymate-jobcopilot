import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"
import type { ReviewedFillHandoffIntent } from "@jobcopilot/shared"
import { AutoApplyError } from "@/lib/auto-apply-guards"

const mocks = vi.hoisted(() => ({
  userFind: vi.fn(), taskFind: vi.fn(), jobFind: vi.fn(), featureAllowed: vi.fn(), aiAccess: vi.fn(), runtimeFlag: vi.fn(),
  assess: vi.fn(), supportedUrl: vi.fn(), policy: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: {
  user: { findUnique: mocks.userFind }, applicationTask: { findFirst: mocks.taskFind }, job: { findFirst: mocks.jobFind },
} }))
vi.mock("@/lib/entitlements", () => ({ isFeatureAllowed: mocks.featureAllowed, resolveAiAccess: mocks.aiAccess }))
vi.mock("@/lib/runtime-feature-flags", () => ({ isRuntimeFeatureEnabled: mocks.runtimeFlag }))
vi.mock("@/lib/agent/application-preflight", () => ({
  assessApplicationPreflight: mocks.assess, isSupportedAutomatedApplyUrl: mocks.supportedUrl,
}))
vi.mock("@/lib/agent/policy/legacy", () => ({ requireLegacyPolicy: mocks.policy }))

import { acknowledgeExistingReviewedFillHandoff, assertReviewedFillLaunchAllowed } from "./reviewed-fill-admission"
import { REVIEWED_FILL_SOURCE_SCHEMA, REVIEWED_FILL_SOURCE_EVENT } from "./reviewed-fill-source-binding"
import { waitItemId } from "../broker/item-ids"

const NOW = new Date("2026-11-20T12:00:00.000Z")
const intent: ReviewedFillHandoffIntent = {
  schemaVersion: "agent-harness.v2.reviewed-fill-handoff.v1", userId: "user_1", sessionId: "session_1",
  applicationTaskId: "task_1", approvalId: "approval_1", predecessorTurnId: "predecessor_1",
}
const key = "agent-reviewed-fill:approval_1"

function makeReadOnlyClient(existingFill: boolean) {
  const task = {
    id: "task_1", status: existingFill ? "filling" : "waiting_for_user", checkpoint: "materials_ready",
    fillTurnId: existingFill ? "fill_1" : null,
    fillTurnSessionId: existingFill ? "session_1" : null, fillTurnUserId: existingFill ? "user_1" : null,
  }
  const approval = {
    id: "approval_1", userId: "user_1", sessionId: "session_1", turnId: "predecessor_1", taskId: "task_1",
    jobId: "job_1", toolCallId: "call_1", type: "review_application", status: "approved", scopeHash: "scope_1",
    revision: 3, expiresAt: new Date("2099-01-01T00:00:00.000Z"), decidedAt: NOW,
    payload: { applicationTaskId: "task_1", jobId: "job_1" },
  }
  const sourceTurn = { id: "source_1", userId: "user_1", sessionId: "session_1", source: "user", status: "completed",
    rootTaskId: "source_root", input: { selectedJobPreparation: { jobId: "job_1" } } }
  const predecessor = { id: "predecessor_1", userId: "user_1", sessionId: "session_1", source: "user",
    status: "completed", rootTaskId: "root_1" }
  const fill = { id: "fill_1", userId: "user_1", sessionId: "session_1", source: "user", status: "in_progress",
    input: { clientMessageId: key, reviewedApplicationMaterialSource: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, sourceTurnId: sourceTurn.id } } }
  const event = { id: "source_binding_1", data: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, approvalId: approval.id, sourceTurnId: sourceTurn.id } }
  const wait = { id: waitItemId("approval", approval.id), sessionId: "session_1", turnId: predecessor.id,
    type: "approval_request", status: "completed", revision: 1, content: {
      waitKind: "approval", approvalId: approval.id, toolCallId: approval.toolCallId, action: "review_application",
      scopeHash: approval.scopeHash, receiptRevision: approval.revision, expiresAt: approval.expiresAt.toISOString(),
      decision: "approved", responseAvailable: true, respondedAt: NOW.toISOString(),
    } }
  let rawRead = 0
  const tx = {
    $queryRaw: vi.fn(async () => (++rawRead === 1 ? [{ id: "session_1" }] : [task])),
    agentInput: { findFirst: vi.fn(async () => existingFill ? { id: "input_1", targetTurnId: "fill_1", delivery: "follow_up", acceptedSequence: BigInt(1) } : null) },
    agentApproval: { findFirst: vi.fn(async () => approval) },
    applicationTask: { findFirst: vi.fn(async () => task) },
    applicationTaskEvent: { findMany: vi.fn(async () => [event]) },
    agentTurn: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.id === sourceTurn.id ? sourceTurn : where.id === predecessor.id ? predecessor : where.id === fill.id ? fill : null),
      findMany: vi.fn(async () => []), create: vi.fn(),
    },
    agentItem: { findFirst: vi.fn(async () => wait) },
    agentEvent: { findFirst: vi.fn(async () => null) },
    agentOutbox: { create: vi.fn() },
    applicationTaskEventCreate: vi.fn(),
  }
  const client = { $transaction: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback(tx)) }
  return { client, tx }
}

describe("reviewed fill admission", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_APPLICATION_FILL_TASKGRAPH", "1")
    mocks.userFind.mockResolvedValue({ accountStatus: "active" })
    mocks.taskFind.mockResolvedValue({ jobId: "job_1" })
    mocks.jobFind.mockResolvedValue({ url: "https://jobs.example.test/apply" })
    mocks.featureAllowed.mockResolvedValue(true)
    mocks.aiAccess.mockResolvedValue("enabled")
    mocks.runtimeFlag.mockResolvedValue(true)
    mocks.assess.mockReturnValue({ canAutomate: true, issues: [] })
    mocks.supportedUrl.mockReturnValue(true)
    mocks.policy.mockReturnValue({ outcome: "allow" })
  })

  it("proves an exact existing fill read-only and returns no fallthrough command", async () => {
    const fake = makeReadOnlyClient(true)
    const result = await acknowledgeExistingReviewedFillHandoff(fake.client as unknown as PrismaClient, intent, key)
    expect(result.kind).toBe("duplicate")
    if (result.kind === "duplicate") expect(result.result).toMatchObject({ disposition: "duplicate", turnId: "fill_1" })
    expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
    expect(fake.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fake.tx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it("returns an explicit no-existing-fill result without creating or accepting anything", async () => {
    const fake = makeReadOnlyClient(false)
    await expect(acknowledgeExistingReviewedFillHandoff(fake.client as unknown as PrismaClient, intent, key))
      .resolves.toEqual({ kind: "none" })
    expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
    expect(fake.tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("applies the existing account, entitlement, URL, Job and fill policy gates before a new start", async () => {
    await expect(assertReviewedFillLaunchAllowed(intent)).resolves.toBeUndefined()
    expect(mocks.userFind).toHaveBeenCalledWith({ where: { id: "user_1" }, select: { accountStatus: true } })
    expect(mocks.featureAllowed).toHaveBeenCalledWith("user_1", "auto_apply")
    expect(mocks.taskFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "task_1", userId: "user_1", sessionId: "session_1" } }))
    expect(mocks.supportedUrl).toHaveBeenCalledWith("https://jobs.example.test/apply")
    expect(mocks.policy).toHaveBeenCalledWith(expect.objectContaining({ stepId: "application.fill", toolName: "application.fill" }))
  })

  it("keeps launch denials permanent but lets unexpected entitlement failures remain retryable", async () => {
    mocks.policy.mockImplementationOnce(() => { throw new Error("policy detail") })
    await expect(assertReviewedFillLaunchAllowed(intent)).rejects.toBeInstanceOf(AutoApplyError)
    mocks.aiAccess.mockRejectedValueOnce(new Error("database unavailable"))
    await expect(assertReviewedFillLaunchAllowed(intent)).rejects.toThrow("database unavailable")
  })
})
