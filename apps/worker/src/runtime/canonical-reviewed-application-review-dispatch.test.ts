import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { TurnLease } from "./turns/lease.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import type { TurnEngineOptions } from "./turns/turn-engine-types.js"
import type { CanonicalApprovedApplicationSubmitResumeProof } from "./canonical-approved-application-submit-resume-proof.js"
import { resolveProductionAgentFlags } from "./production-agent-flags.js"

const { reviewTurn, loadState, readResumeProof, finishResume } = vi.hoisted(() => ({
  reviewTurn: { run: vi.fn() }, loadState: vi.fn(), readResumeProof: vi.fn(), finishResume: vi.fn(),
}))
vi.mock("./canonical-reviewed-application-review-turn.js", () => ({ runCanonicalReviewedApplicationReviewTurn: reviewTurn.run }))
vi.mock("./canonical-turn-state.js", () => ({ loadCanonicalTurnState: loadState }))
vi.mock("./canonical-approved-application-submit-resume.js", () => ({
  readCurrentApprovedApplicationSubmitResumeProof: readResumeProof, finishApprovedApplicationFillTurn: finishResume,
}))
vi.mock("./canonical-approved-application-submit-resume-proof.js", () => ({
  sameCanonicalApprovedApplicationSubmitResumeProof: (before: unknown, after: unknown) => before === after,
}))

import { dispatchCanonicalReviewedApplicationReview, loadAndDispatchCanonicalReviewedApplicationReview } from "./canonical-reviewed-application-review-dispatch.js"

const lease: TurnLease = { turnId: "turn-review", sessionId: "session-review", ownerId: "worker-review", userId: "user-review",
  leaseVersion: 2, leaseStartedAt: new Date("2026-11-21T10:00:00Z"), leaseExpiresAt: new Date("2026-11-21T10:01:00Z") }
const intent = { kind: "reviewed_application_review", version: 1, sourceTurnId: "source-turn", jobId: "job-review" } as const
const NOW = new Date("2026-11-21T10:00:00Z")

describe("canonical reviewed application review dispatch", () => {
  beforeEach(() => reviewTurn.run.mockReset().mockResolvedValue({ status: "waiting_for_approval", stepCount: 0,
    toolCallCount: 0, waitId: "reviewed-application-review:turn-review" }))

  it("issues only an eligible user Turn under a root with no allowed actions", async () => {
    const f = fixture()
    await expect(dispatchCanonicalReviewedApplicationReview(f.input)).resolves.toEqual({
      status: "waiting_for_approval", summary: undefined, waitId: "reviewed-application-review:turn-review",
    })
    expect(f.rootTasks.ensure).toHaveBeenCalledWith(expect.objectContaining({ allowedActions: [] }))
    expect(reviewTurn.run).toHaveBeenCalledWith(expect.objectContaining({
      rootTaskId: "root-review", intent, rootInputId: "review-input", rootContextInputId: "review-input",
    }))
    expect(f.rootTasks.finish).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({
      status: "waiting_for_approval", stepCount: 0, toolCallCount: 0,
    }) }))
    expect(f.execution.start).toHaveBeenCalledOnce()
    expect(f.execution.finish).toHaveBeenCalledOnce()
    expect(f.session.start).toHaveBeenCalledOnce()
    expect(f.session.finish).toHaveBeenCalledOnce()
  })

  it("fails closed on automation source and leaves ordinary Turns to standard setup", async () => {
    const f = fixture({ source: "automation" })
    await expect(dispatchCanonicalReviewedApplicationReview(f.input)).resolves.toMatchObject({
      status: "failed", summary: "reviewed_application_review_runtime_unavailable",
    })
    expect(f.rootTasks.ensure).toHaveBeenCalledWith(expect.objectContaining({ allowedActions: [] }))
    expect(reviewTurn.run).not.toHaveBeenCalled()

    const ordinary = fixture({ intent: undefined })
    await expect(dispatchCanonicalReviewedApplicationReview(ordinary.input)).resolves.toBeUndefined()
    expect(ordinary.rootTasks.ensure).not.toHaveBeenCalled()
    expect(ordinary.execution.start).not.toHaveBeenCalled()
  })
})

describe("approved application fill terminal dispatch", () => {
  beforeEach(() => {
    reviewTurn.run.mockClear()
    loadState.mockReset()
    readResumeProof.mockReset()
    finishResume.mockReset().mockResolvedValue({ status: "completed" })
  })

  it("requires a read-only proof before consuming child Waits and then completes the same Turn", async () => {
    const proof = { state: "form_filled" } as CanonicalApprovedApplicationSubmitResumeProof
    const state: CanonicalTurnState = { scope: { userId: lease.userId }, source: "user", goal: "Fill application",
      rootTaskId: "root-fill", modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } }
    loadState.mockResolvedValue(state)
    readResumeProof.mockResolvedValue({ rootTaskId: "root-fill", proof })
    let rootStatus = "waiting_for_user"
    const ensureRoot = vi.fn(async () => {
      expect(rootStatus).toBe("waiting_for_user")
      rootStatus = "running"
      return { id: "root-fill", attemptCount: 1 }
    })
    const rootTasks = { ensure: ensureRoot, finish: vi.fn(), checkCompletion: vi.fn() } as unknown as RootTaskStore
    const executionProjection = { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalExecutionProjection
    const sessionProjection = { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalSessionProjection
    const input = { pool: { connect: vi.fn() } as unknown as pg.Pool, lease, signal: new AbortController().signal,
      options: { productionFlags: resolveProductionAgentFlags({ ENABLE_AGENT_TASK_GRAPH_PLANNING: "1",
        ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" }), taskGraphCommandPort: {} as TaskGraphCommandPort },
      rootTasks, executionProjection, sessionProjection, now: () => NOW,
      coordinationEnabled: true, childExecutionEnabled: true, consumeWaitOutcomes: true }

    await expect(loadAndDispatchCanonicalReviewedApplicationReview(input)).resolves.toMatchObject({ result: { status: "completed" } })
    expect(readResumeProof).toHaveBeenCalledTimes(3)
    expect(readResumeProof.mock.invocationCallOrder[0]).toBeLessThan(loadState.mock.invocationCallOrder[0]!)
    expect(readResumeProof.mock.invocationCallOrder[1]).toBeLessThan(ensureRoot.mock.invocationCallOrder[0]!)
    expect(ensureRoot.mock.invocationCallOrder[0]).toBeLessThan(readResumeProof.mock.invocationCallOrder[2]!)
    expect(readResumeProof.mock.invocationCallOrder[2]).toBeLessThan(finishResume.mock.invocationCallOrder[0]!)
    expect(rootStatus).toBe("running")
    expect(ensureRoot).toHaveBeenCalledWith(expect.objectContaining({ lease, goal: state.goal, allowedActions: [] }))
    expect(loadState).toHaveBeenCalledWith(input.pool, lease, NOW, expect.objectContaining({ consumeWaitOutcomes: true }))
    expect(finishResume).toHaveBeenCalledWith(expect.objectContaining({ state, proof, rootTaskId: "root-fill" }))
    expect(reviewTurn.run).not.toHaveBeenCalled()
  })

  it("keeps the existing single state-load path when there is no exact resume proof", async () => {
    const state: CanonicalTurnState = { scope: { userId: lease.userId }, source: "user", goal: "Ordinary Turn",
      modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } }
    loadState.mockResolvedValue(state)
    readResumeProof.mockResolvedValue(null)
    const input = { pool: { connect: vi.fn() } as unknown as pg.Pool, lease, signal: new AbortController().signal,
      options: { productionFlags: resolveProductionAgentFlags({ ENABLE_AGENT_TASK_GRAPH_PLANNING: "1",
        ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" }), taskGraphCommandPort: {} as TaskGraphCommandPort },
      rootTasks: { checkCompletion: vi.fn(), ensure: vi.fn(), finish: vi.fn() } as unknown as RootTaskStore,
      executionProjection: { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalExecutionProjection,
      sessionProjection: { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalSessionProjection,
      now: () => NOW, coordinationEnabled: true, childExecutionEnabled: true, consumeWaitOutcomes: true }

    await expect(loadAndDispatchCanonicalReviewedApplicationReview(input)).resolves.toMatchObject({ result: undefined })
    expect(readResumeProof).toHaveBeenCalledOnce()
    expect(loadState).toHaveBeenCalledOnce()
    expect(finishResume).not.toHaveBeenCalled()
  })
})

function fixture(overrides: Partial<CanonicalTurnState> = {}) {
  const state: CanonicalTurnState = {
    scope: { userId: lease.userId }, goal: "Review application materials", source: "user", rootInputId: "review-input",
    intent, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    ...overrides,
  }
  const rootTasks = { ensure: vi.fn(async () => ({ id: "root-review", attemptCount: 1 })), finish: vi.fn(async () => undefined),
    checkCompletion: vi.fn() } as unknown as RootTaskStore
  const execution = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) } as unknown as CanonicalExecutionProjection
  const session = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) } as unknown as CanonicalSessionProjection
  const issue = vi.fn(async () => ({ status: "waiting" as const, approvalId: "approval-review", waitItemId: "wait-review" }))
  const contextBuilderFactory = vi.fn(() => ({} as TurnEngineOptions["contextBuilder"]))
  const options = { productionFlags: resolveProductionAgentFlags({ ENABLE_AGENT_TASK_GRAPH_PLANNING: "1",
    ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" }),
    taskGraphCommandPort: {} as TaskGraphCommandPort, reviewedApplicationReviewIssuer: issue, contextBuilderFactory }
  const input = { pool: { connect: vi.fn() } as unknown as pg.Pool, lease, signal: new AbortController().signal, state, options,
    rootTasks, executionProjection: execution, sessionProjection: session, now: () => NOW,
    coordinationEnabled: true, childExecutionEnabled: true, consumeWaitOutcomes: true }
  return { input, rootTasks, execution, session, issue, contextBuilderFactory }
}
