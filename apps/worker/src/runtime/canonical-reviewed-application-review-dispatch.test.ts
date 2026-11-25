import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { TurnLease } from "./turns/lease.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import type { TurnEngineOptions } from "./turns/turn-engine-types.js"
import { OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA } from "@jobcopilot/agent-protocol"
import { resolveProductionAgentFlags } from "./production-agent-flags.js"

const reviewTurn = vi.hoisted(() => ({ run: vi.fn() }))
const objectiveReviewTurn = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./canonical-reviewed-application-review-turn.js", () => ({ runCanonicalReviewedApplicationReviewTurn: reviewTurn.run }))
vi.mock("./canonical-objective-application-review-turn.js", () => ({ runCanonicalObjectiveApplicationReviewTurn: objectiveReviewTurn.run }))

import { dispatchCanonicalReviewedApplicationReview } from "./canonical-reviewed-application-review-dispatch.js"

const lease: TurnLease = { turnId: "turn-review", sessionId: "session-review", ownerId: "worker-review", userId: "user-review",
  leaseVersion: 2, leaseStartedAt: new Date("2026-11-21T10:00:00Z"), leaseExpiresAt: new Date("2026-11-21T10:01:00Z") }
const intent = { kind: "reviewed_application_review", version: 1, sourceTurnId: "source-turn", jobId: "job-review" } as const
const NOW = new Date("2026-11-21T10:00:00Z")

describe("canonical reviewed application review dispatch", () => {
  beforeEach(() => reviewTurn.run.mockReset().mockResolvedValue({ status: "waiting_for_approval", stepCount: 0,
    toolCallCount: 0, waitId: "reviewed-application-review:turn-review" }))

  beforeEach(() => objectiveReviewTurn.run.mockReset().mockResolvedValue({ status: "waiting_for_approval", stepCount: 0,
    toolCallCount: 0, waitId: "objective-review-set" }))

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

  it("routes the exact objective review intent only when its server feature gate is enabled", async () => {
    const intent = { kind: "objective_application_review", version: 1, selection: {
      schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, sourceTurnId: "source-turn", rootTaskId: "source-root",
      graphItemId: "source-graph", graphRevision: 9, slotOrdinals: [1, 2],
    } } as Extract<NonNullable<CanonicalTurnState["intent"]>, { kind: "objective_application_review" }>
    const f = fixture({ intent })
    await expect(dispatchCanonicalReviewedApplicationReview(f.input)).resolves.toEqual({
      status: "waiting_for_approval", summary: undefined, waitId: "objective-review-set",
    })
    expect(objectiveReviewTurn.run).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-review", intent, rootInputId: "review-input" }))
    expect(reviewTurn.run).not.toHaveBeenCalled()

    const disabled = fixture({ intent }, false)
    await expect(dispatchCanonicalReviewedApplicationReview(disabled.input)).resolves.toMatchObject({
      status: "failed", summary: "objective_application_review_runtime_unavailable",
    })
    expect(objectiveReviewTurn.run).toHaveBeenCalledOnce()
    expect(disabled.rootTasks.finish).toHaveBeenCalledOnce()
  })
})

function fixture(overrides: Partial<CanonicalTurnState> = {}, objectiveTailorEnabled = true) {
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
    ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1", ...(objectiveTailorEnabled ? { ENABLE_AGENT_OBJECTIVE_TAILOR: "1" } : {}) }),
    taskGraphCommandPort: {} as TaskGraphCommandPort, reviewedApplicationReviewIssuer: issue,
    objectiveApplicationReviewIssuer: vi.fn(), objectiveApplicationReviewSetStateReader: vi.fn(), contextBuilderFactory }
  const input = { pool: { connect: vi.fn() } as unknown as pg.Pool, lease, signal: new AbortController().signal, state, options,
    rootTasks, executionProjection: execution, sessionProjection: session, now: () => NOW,
    coordinationEnabled: true, childExecutionEnabled: true, consumeWaitOutcomes: true }
  return { input, rootTasks, execution, session, issue, contextBuilderFactory }
}
