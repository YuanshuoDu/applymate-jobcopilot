import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { createCanonicalScheduledDraftRuntime } from "./scheduled-draft-runtime.js"
import type { LoadedScheduledDraftCandidateBinding } from "./subagents/scheduled-draft-candidate.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
type BoundBinding = Extract<LoadedScheduledDraftCandidateBinding, { status: "bound" }>

const mocks = vi.hoisted(() => ({
  readBinding: vi.fn(), validateBinding: vi.fn(), completionGate: vi.fn(), finalizationGate: vi.fn(), loadContext: vi.fn(),
}))

vi.mock("./subagents/scheduled-draft-candidate.js", () => ({
  readScheduledDraftCandidateBinding: mocks.readBinding,
  validateScheduledDraftCandidateWitness: mocks.validateBinding,
}))
vi.mock("./selected-job-completion-gate.js", () => ({ selectedJobArtifactCompletionGateWithWitness: mocks.completionGate }))
vi.mock("./selected-job-finalization-guard.js", () => ({ selectedJobArtifactFinalizationGuard: mocks.finalizationGate }))
vi.mock("./subagents/selected-job-artifact-context.js", () => ({
  loadSelectedJobArtifactContext: mocks.loadContext,
  readSelectedJobSourceDigestWithClient: vi.fn(),
}))

const lease = {
  turnId: "turn-1", sessionId: "session-1", userId: "user-1", ownerId: "owner-1", leaseVersion: 2,
  leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000),
}
const root = { id: "root-1", attemptCount: 3 }
const graphWitness = { revision: 7, nodes: [{ key: "writer", taskId: "writer-1" }] } as never
const binding = {
  status: "bound" as const, jobId: "job-1", graphRevision: 7,
  witness: { bindingVersion: 1, graphRevision: 7, candidate: { jobId: "job-1", score: 9 } },
  snapshot: { schemaVersion: "agent-harness.v2.task-graph", nodes: [] },
} as unknown as BoundBinding

function runtime(bindingReader: () => LoadedScheduledDraftCandidateBinding = () => binding) {
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
  const client = { query, release: vi.fn() } as unknown as PoolClient
  const pool = { connect: vi.fn(async () => client) }
  const commandPort = { readCurrentWithClient: vi.fn(async () => ({ revision: 7 })) } as unknown as TaskGraphCommandPort
  const artifactRepository = {
    findCurrentDraftHead: vi.fn(async () => null),
    findReviewReceipt: vi.fn(async () => null),
  } as never
  mocks.readBinding.mockImplementation(bindingReader)
  mocks.validateBinding.mockResolvedValue(true)
  mocks.completionGate.mockResolvedValue({ ok: true, witness: graphWitness })
  mocks.finalizationGate.mockResolvedValue({ ok: true })
  mocks.loadContext.mockResolvedValue({ preparation: { sourceDigest: "sha256:source" } })
  return {
    instance: createCanonicalScheduledDraftRuntime({ pool: pool as never, commandPort, lease, root, artifactRepository }),
    client, pool, commandPort,
  }
}

describe("canonical scheduled draft runtime", () => {
  beforeEach(() => vi.clearAllMocks())

  it("allows ordinary completion when no scheduled pair was persisted", async () => {
    const state = runtime(() => ({ status: "absent" }))

    await expect(state.instance.complete()).resolves.toEqual({ ok: true })
    await expect(state.instance.finalize(state.client)).resolves.toEqual({ ok: true })

    expect(mocks.validateBinding).not.toHaveBeenCalled()
    expect(mocks.finalizationGate).not.toHaveBeenCalled()
  })

  it("blocks a changed candidate witness before accepting completion", async () => {
    const state = runtime()
    mocks.validateBinding.mockResolvedValueOnce(false)

    await expect(state.instance.complete()).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
    await expect(state.instance.finalize(state.client)).resolves.toMatchObject({ ok: false })

    expect(mocks.completionGate).not.toHaveBeenCalled()
    expect(mocks.finalizationGate).not.toHaveBeenCalled()
  })

  it("keeps the graph witness private while revalidating the same binding in terminal finalization", async () => {
    const state = runtime()

    const completion = await state.instance.complete()
    expect(completion).toEqual({ ok: true })
    expect(JSON.stringify(completion)).not.toContain("witness")
    await expect(state.instance.finalize(state.client)).resolves.toEqual({ ok: true })

    expect(mocks.validateBinding).toHaveBeenCalledTimes(2)
    expect(mocks.validateBinding).toHaveBeenLastCalledWith(state.client, expect.any(Object), binding.snapshot, 7, "job-1", binding.witness)
    expect(mocks.finalizationGate).toHaveBeenCalledWith(expect.objectContaining({
      client: state.client, selectedJobId: "job-1", acceptedGraphWitness: graphWitness,
    }))
    expect(state.pool.connect).toHaveBeenCalledOnce()
    expect(state.commandPort.readCurrentWithClient).toHaveBeenCalledWith(state.client, expect.any(Object))
  })

  it("rejects a binding that changes after completion was accepted", async () => {
    let current: BoundBinding = binding
    const state = runtime(() => current)
    await state.instance.complete()
    current = { ...binding, jobId: "job-2", witness: { ...binding.witness, candidate: { jobId: "job-2", score: 8 } } }

    await expect(state.instance.finalize(state.client)).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
    expect(mocks.finalizationGate).not.toHaveBeenCalled()
  })
})
