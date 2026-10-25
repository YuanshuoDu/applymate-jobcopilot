import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PipelineCtx } from "./types"
import { runPipeline } from "./pipeline"
import { isScheduledTaskGraphAuditRuntime, markScheduledTaskGraphAuditRuntime } from "./scheduled-taskgraph-audit-runtime"

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  customAgents: vi.fn(),
  audit: vi.fn(),
  execute: vi.fn(),
  recordRoleRun: vi.fn(),
}))

vi.mock("./orchestrator", () => ({
  OrchestratorAgent: class {
    plan = mocks.plan
    beginStage = vi.fn()
    nextAttempt = vi.fn(() => 1)
    emitRetry = vi.fn()
    recordFailure = vi.fn()
    isExhausted = vi.fn(() => false)
    decideOnExhaustion = vi.fn()
    applyFix = vi.fn()
    evaluate = vi.fn(async () => ({ decision: "proceed", thinking: "ok" }))
    ask = vi.fn()
    applyOptionAction = vi.fn()
    complete = vi.fn()
  },
}))
vi.mock("./role-config", () => ({ ROLE_META: {}, recordRoleRun: mocks.recordRoleRun }))
vi.mock("./stages/custom", () => ({
  runCustomAgents: mocks.customAgents,
  summarizeCustomAgentResults: vi.fn(() => []),
}))
vi.mock("./stages/audit", () => ({ runAudit: mocks.audit }))
vi.mock("./stages/execute", () => ({
  runExecute: mocks.execute,
  acceptExecute: vi.fn(() => ({ ok: true })),
}))

const owner = {
  userId: "user_1",
  sessionId: "session_1",
  turnId: "turn_1",
  rootTaskId: "root_1",
  rootAttemptCount: 2,
  turnLeaseOwnerId: "root_worker_1",
  turnLeaseVersion: 4,
  executionId: "execution_1",
  executionAttemptCount: 0,
}
const key = `scheduled-taskgraph:sha256:${"a".repeat(64)}`
const claimToken = "claim_1"
const job = { id: "job_1", company: "Acme", role: "Engineer", description: "TypeScript", updatedAt: new Date() }
const scored = { job, score: 90, matchedKeywords: ["TypeScript"], missingKeywords: [], recommendation: "strong" }
const gateOutput = { approved: [], pending: [], skipped: [] }

function scheduledState(nextStage: "execute" | "audit" = "audit") {
  const continuation = {
    schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
    key,
    owner: { ...owner },
    snapshotDigest: `sha256:${"b".repeat(64)}`,
    graphRevision: 3,
    evidenceDigest: "c".repeat(64),
  }
  return {
    nextStage,
    scoutedJobs: [job] as never,
    scoredJobs: [scored] as never,
    preparedPackages: [],
    gateOutput,
    executeOutput: { queued: [], failed: [] },
    analysisFailed: 0,
    scheduledTaskGraphContinuation: continuation,
    scheduledTaskGraphClaim: {
      schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1",
      key,
      claimToken,
      owner: { ...owner },
      claimedAt: "2026-10-25T09:00:00.000Z",
      leaseExpiresAt: "2026-10-25T09:10:00.000Z",
    },
  }
}

function context(input: {
  stage?: "execute" | "audit"
  branded?: boolean
  fakeJsonFlag?: boolean
  current?: () => Promise<boolean>
  checkpoint?: (state: unknown) => Promise<void>
} = {}) {
  const resumeState = scheduledState(input.stage)
  const ownerFence = {
    owner: { ...owner },
    key,
    claimToken,
    assertCurrent: vi.fn(async () => true),
  }
  const ctx = {
    userId: owner.userId,
    sessionId: owner.sessionId,
    turnId: owner.turnId,
    agentCfg: {
      dailyLimit: 5, minMatchScore: 70, autoApply: false, requireApproval: true,
      targetLocations: [], targetRoles: [], excludeCompanies: [], priorityCompanies: [],
      autoCoverLetter: false, coverTone: "professional", useTailoredCV: false, model: "test",
    },
    roleConfigs: {},
    resumeText: "resume",
    resumeContent: {},
    defaultResume: { id: "resume_1", name: "CV", templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: { provider: "minimax", model: "test", apiKey: "test-key" },
    autonomous: false,
    emit: vi.fn(),
    executionAttempt: { id: owner.executionId, attemptCount: owner.executionAttemptCount },
    resumeState,
    checkpoint: input.checkpoint ?? vi.fn(async () => undefined),
    assertExecutionCurrent: input.current ?? vi.fn(async () => true),
    scheduledTaskGraphOwnerFence: ownerFence,
    ...(input.fakeJsonFlag ? { scheduledTaskGraphAuditRuntime: true } : {}),
  } as unknown as PipelineCtx

  return { ctx, resumeState, ownerFence }
}

describe("scheduled Audit pipeline runtime", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.plan.mockResolvedValue("Continue the verified scheduled run.")
    mocks.customAgents.mockResolvedValue([])
    mocks.audit.mockResolvedValue({ data: { warnings: [], report: {} }, metrics: { durationMs: 1, count: 1 } })
    mocks.execute.mockResolvedValue({ data: { queued: [], failed: [] }, metrics: { durationMs: 1, count: 0 } })
    mocks.recordRoleRun.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(["execute", "audit"] as const)("completes a branded Audit %s checkpoint without planning or custom agents", async stage => {
    const current = vi.fn(async () => true)
    const checkpoint = vi.fn(async () => undefined)
    const { ctx } = context({ stage, current, checkpoint })
    markScheduledTaskGraphAuditRuntime(ctx)
    mocks.plan.mockImplementation(async () => { throw new Error("unexpected_model_call") })
    mocks.customAgents.mockImplementation(async () => { throw new Error("unexpected_custom_agent_call") })

    const report = await runPipeline(ctx)

    expect(report).toEqual(expect.objectContaining({ processed: 1, applied: 0, queued: 0, pending: 0, skipped: 0, failed: 0 }))
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ nextStage: "audit" }))
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ nextStage: "completed", report }))
    expect(current).toHaveBeenCalled()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.customAgents).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledTimes(stage === "execute" ? 1 : 0)
    expect(mocks.audit).toHaveBeenCalledOnce()
  })

  it("keeps ordinary pipeline behavior for an unbranded context with a forged JSON flag", async () => {
    const { ctx } = context({ fakeJsonFlag: true })

    expect(isScheduledTaskGraphAuditRuntime(ctx)).toBe(false)
    const report = await runPipeline(ctx)

    expect(report.processed).toBe(1)
    expect(mocks.plan).toHaveBeenCalledOnce()
    expect(mocks.customAgents).toHaveBeenCalledWith(expect.anything(), [job], "auditor")
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.audit).toHaveBeenCalledOnce()
  })
})
