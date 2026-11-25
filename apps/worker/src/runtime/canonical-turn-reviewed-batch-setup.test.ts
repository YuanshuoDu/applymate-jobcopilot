import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  loadAndDispatchReview: vi.fn(),
  finalizeObjectiveSubmit: vi.fn(),
  prepareSetup: vi.fn(),
  createBatchRuntime: vi.fn(),
  prepareBatchRuntime: vi.fn(),
}))

vi.mock("./canonical-reviewed-application-review-dispatch.js", () => ({
  loadAndDispatchCanonicalReviewedApplicationReview: mocks.loadAndDispatchReview,
}))
vi.mock("./canonical-objective-application-submit-finalizer.js", () => ({
  finalizeCanonicalObjectiveApplicationSubmit: mocks.finalizeObjectiveSubmit,
}))
vi.mock("./canonical-turn-runtime-turn-setup.js", () => ({
  prepareCanonicalTurnSetup: mocks.prepareSetup,
}))
vi.mock("./canonical-selected-job-batch-runtime.js", () => ({
  createCanonicalSelectedJobBatchRuntime: mocks.createBatchRuntime,
  prepareCanonicalSelectedJobBatchRuntime: mocks.prepareBatchRuntime,
}))

import { prepareCanonicalTurnReviewedBatchSetup } from "./canonical-turn-reviewed-batch-setup.js"

describe("prepareCanonicalTurnReviewedBatchSetup", () => {
  beforeEach(() => vi.clearAllMocks())

  const input = () => ({
    pool: {} as never,
    lease: {} as never,
    signal: new AbortController().signal,
    now: () => new Date(0),
    options: { taskGraphCommandPort: { marker: "command-port" } } as never,
    manager: {} as never,
    rootTasks: {} as never,
    executionProjection: {} as never,
    sessionProjection: {} as never,
    coordinationEnabled: true,
    childExecutionEnabled: true,
    consumeWaitOutcomes: true,
  })

  it("dispatches reviewed intent before setup and returns a reviewed terminal result", async () => {
    const earlyResult = { status: "completed", summary: "reviewed" }
    mocks.loadAndDispatchReview.mockResolvedValue({ result: earlyResult })

    await expect(prepareCanonicalTurnReviewedBatchSetup(input())).resolves.toEqual({ earlyResult })
    expect(mocks.prepareSetup).not.toHaveBeenCalled()
    expect(mocks.prepareBatchRuntime).not.toHaveBeenCalled()
  })

  it("forwards reviewed setup options, installs the batch gate, and keeps the review wait port", async () => {
    const setupOptions = { stateLoader: vi.fn().mockResolvedValue({ source: "user", resume: { stepCount: 2 } }) }
    const durableWaitPort = { marker: "review-port" }
    const state = { source: "user" }
    const scopedState = { source: "user", scoped: true }
    const selectedJobBatch = { binding: { selectedJobIds: ["job-1"] } }
    const runtime = { checkCandidate: vi.fn() }
    const setup = { state, selectedJobMode: false, selectedJobBatch, root: { id: "root-1" } }
    mocks.loadAndDispatchReview.mockResolvedValue({ result: undefined, setupOptions, durableWaitPort })
    mocks.finalizeObjectiveSubmit.mockResolvedValue(undefined)
    mocks.prepareSetup.mockResolvedValue(setup)
    mocks.prepareBatchRuntime.mockReturnValue({ state: scopedState, runtime })

    await expect(prepareCanonicalTurnReviewedBatchSetup(input())).resolves.toEqual({
      setup, state: scopedState, selectedJobRootMode: true, batchRuntime: runtime, durableWaitPort,
    })
    expect(mocks.prepareSetup).toHaveBeenCalledWith(expect.objectContaining({ options: setupOptions, batchCompletionGate: mocks.createBatchRuntime }))
    expect(mocks.finalizeObjectiveSubmit).toHaveBeenCalledWith(expect.objectContaining({ state: { source: "user", resume: { stepCount: 2 } } }))
    expect(mocks.prepareBatchRuntime).toHaveBeenCalledWith(expect.objectContaining({
      state, selectedJobBatch, root: setup.root, commandPort: { marker: "command-port" },
    }))
    expect(mocks.loadAndDispatchReview.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepareSetup.mock.invocationCallOrder[0])
    expect(mocks.prepareSetup.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepareBatchRuntime.mock.invocationCallOrder[0])
  })

  it("returns setup failures before constructing a batch runtime", async () => {
    const earlyResult = { status: "failed", summary: "setup-unavailable" }
    mocks.loadAndDispatchReview.mockResolvedValue({ result: undefined,
      setupOptions: { stateLoader: vi.fn().mockResolvedValue({ source: "automation" }) }, durableWaitPort: {} })
    mocks.finalizeObjectiveSubmit.mockResolvedValue(undefined)
    mocks.prepareSetup.mockResolvedValue({ earlyResult })

    await expect(prepareCanonicalTurnReviewedBatchSetup(input())).resolves.toEqual({ earlyResult })
    expect(mocks.prepareBatchRuntime).not.toHaveBeenCalled()
  })

  it("does not build model setup after the exact Objective submit finalizer handles the Turn", async () => {
    const state = { source: "user", resume: { stepCount: 3 } }
    const setupOptions = { stateLoader: vi.fn().mockResolvedValue(state) }
    const durableWaitPort = { marker: "review-port" }
    const terminal = { status: "completed", summary: "objective_submit_finalized" }
    mocks.loadAndDispatchReview.mockResolvedValue({ result: undefined, setupOptions, durableWaitPort })
    mocks.finalizeObjectiveSubmit.mockResolvedValue(terminal)

    await expect(prepareCanonicalTurnReviewedBatchSetup(input())).resolves.toEqual({ earlyResult: terminal })
    expect(mocks.prepareSetup).not.toHaveBeenCalled()
    expect(mocks.prepareBatchRuntime).not.toHaveBeenCalled()
  })
})
