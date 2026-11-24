import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import type { TaskGraphCurrentState, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { LoadedGraph } from "./subagents/task-graph-pg-state.js"
import type { ObjectiveTailorCandidateWitness } from "./subagents/objective-tailor-witness.js"
import type { ObjectiveTailorCurrentBinding } from "./subagents/objective-tailor-current-binding.js"
import type { SelectedJobArtifactCompletionGateWithWitnessResult } from "./selected-job-completion-gate.js"
import type { SelectedJobArtifactFinalizationGuardInput } from "./selected-job-finalization-guard.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"

const deps = vi.hoisted(() => ({
  lock: vi.fn(async (..._args: unknown[]) => ({})),
  load: vi.fn(async (..._args: unknown[]): Promise<LoadedGraph> => ({} as LoadedGraph)),
  graph: vi.fn((): TaskGraphCurrentState => ({ revision: 1, nodes: [] })),
  binding: vi.fn(async (..._args: unknown[]): Promise<ObjectiveTailorCurrentBinding> => ({ status: "absent" })),
  candidateGate: vi.fn(async (..._args: unknown[]): Promise<SelectedJobArtifactCompletionGateWithWitnessResult> => ({
    ok: true, witness: { revision: 1, nodes: [] },
  })),
  finalize: vi.fn(async (..._args: unknown[]): Promise<TurnEngineCompletionGateResult> => ({ ok: true })),
  draft: vi.fn(async (..._args: unknown[]) => null), review: vi.fn(async (..._args: unknown[]) => null),
  digest: vi.fn(async (..._args: unknown[]) => "a".repeat(64)),
}))
vi.mock("./subagents/task-graph-pg-state.js", () => ({
  lockTaskGraphScope: deps.lock, loadTaskGraph: deps.load, currentTaskGraph: deps.graph,
}))
vi.mock("./subagents/objective-tailor-current-binding.js", () => ({ readCurrentObjectiveTailorBinding: deps.binding }))
vi.mock("./selected-job-completion-gate.js", () => ({ selectedJobArtifactCompletionGateWithWitness: deps.candidateGate }))
vi.mock("./selected-job-finalization-guard.js", () => ({ selectedJobArtifactFinalizationGuard: deps.finalize }))
vi.mock("../db/agent-artifact-repo.js", () => ({
  findCurrentDraftHeadWithClient: deps.draft, findReviewReceiptWithClient: deps.review,
}))
vi.mock("./subagents/selected-job-artifact-context.js", () => ({ readSelectedJobSourceDigestWithClient: deps.digest }))

import { createCanonicalObjectiveTailorRuntime } from "./objective-tailor-runtime.js"

const lease = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 3 } as never
const root = { id: "root-1", attemptCount: 2 }
const readScope: TaskGraphReadScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  rootTaskId: "root-1", parentTaskId: "root-1", turnLeaseOwner: "worker-1", turnLeaseVersion: 3,
  parentLeaseOwner: "worker-1", parentAttemptCount: 2 }
const witness: ObjectiveTailorCandidateWitness = {
  schemaVersion: "agent-harness.v2.objective-tailor-candidate-witness.v1", candidateRef: `otc1_${"a".repeat(64)}`,
  sourceGraphRevision: 1, sourceGraphDigest: "b".repeat(64), sourceStatusDigest: "c".repeat(64), analystProofDigest: "d".repeat(64),
  candidate: { jobId: "job-1", score: 8, materialDigest: `sha256:${"e".repeat(64)}` }, sourceAnalystKeys: ["analyst"],
  writerNodeKey: `objective-tailor-writer-${"a".repeat(64)}`, reviewerNodeKey: `objective-tailor-reviewer-${"a".repeat(64)}`, admittedRevision: 2,
}
const bound = { status: "bound" as const, witness, writerTaskId: "writer-1", reviewerTaskId: "reviewer-1" }
const graph: TaskGraphCurrentState = { revision: 2, nodes: [] }
const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() } as never as PoolClient
const commandPort = { appendAndSchedule: vi.fn(), readCurrent: vi.fn(), readCurrentWithClient: vi.fn() } as never
const pool = { connect: vi.fn(async () => client) } as never

beforeEach(() => {
  vi.clearAllMocks()
  deps.lock.mockResolvedValue({})
  deps.load.mockResolvedValue({} as LoadedGraph)
  deps.graph.mockReturnValue(graph)
  deps.binding.mockResolvedValue({ status: "absent" })
  deps.candidateGate.mockResolvedValue({ ok: true, witness: graph })
  deps.finalize.mockResolvedValue({ ok: true })
})

describe("createCanonicalObjectiveTailorRuntime", () => {
  it("accepts a truly absent pair and rechecks absence in the terminal client", async () => {
    deps.binding.mockResolvedValueOnce({ status: "absent" }).mockResolvedValueOnce({ status: "absent" })
    const runtime = createCanonicalObjectiveTailorRuntime({ pool, lease, root, commandPort })

    await expect(runtime.complete()).resolves.toEqual({ ok: true })
    await expect(runtime.finalize(client)).resolves.toEqual({ ok: true })
    expect(client.query).toHaveBeenCalledWith("COMMIT")
    expect(deps.finalize).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("requires the same exact persisted pair and selected-job proof at terminal", async () => {
    deps.binding.mockResolvedValueOnce(bound).mockResolvedValueOnce(bound)
    deps.candidateGate.mockResolvedValue({ ok: true, witness: graph })
    deps.finalize.mockImplementation(async (...args) => {
      const input = args[0] as unknown as SelectedJobArtifactFinalizationGuardInput
      const readCurrent = input.commandPort?.readCurrentWithClient
      if (!readCurrent) throw new Error("terminal graph reader was not installed")
      const current = await readCurrent(input.client, readScope)
      expect(current).toBe(graph)
      return { ok: true }
    })
    const runtime = createCanonicalObjectiveTailorRuntime({ pool, lease, root, commandPort })

    await expect(runtime.complete()).resolves.toEqual({ ok: true })
    await expect(runtime.finalize(client)).resolves.toEqual({ ok: true })
    expect(deps.candidateGate).toHaveBeenCalledWith(expect.objectContaining({
      selectedJobId: "job-1", readCurrentDraftHead: expect.any(Function), readCurrentReviewReceipt: expect.any(Function),
    }))
    const gateInput = deps.candidateGate.mock.calls[0]?.[0] as unknown as { readCurrentSourceDigest: unknown }
    expect(gateInput.readCurrentSourceDigest).toBeInstanceOf(Function)
    expect(deps.finalize).toHaveBeenCalledWith(expect.objectContaining({ client, selectedJobId: "job-1", acceptedGraphWitness: graph }))
    const port = (deps.finalize.mock.calls[0]?.[0] as unknown as SelectedJobArtifactFinalizationGuardInput).commandPort
    await expect(port?.readCurrentWithClient?.(client, readScope)).resolves.toBe(graph)
    await expect(port?.readCurrentWithClient?.({} as PoolClient, readScope)).rejects.toThrow("objective_tailor_terminal_scope_mismatch")
  })

  it("blocks a changed pair, a newly appeared pair after absence, and an invalid binding", async () => {
    deps.binding.mockResolvedValueOnce(bound).mockResolvedValueOnce({ ...bound, reviewerTaskId: "reviewer-2" })
    const changed = createCanonicalObjectiveTailorRuntime({ pool, lease, root, commandPort })
    await changed.complete()
    await expect(changed.finalize(client)).resolves.toMatchObject({ ok: false })
    expect(deps.finalize).not.toHaveBeenCalled()

    deps.binding.mockResolvedValueOnce({ status: "absent" }).mockResolvedValueOnce(bound)
    const appeared = createCanonicalObjectiveTailorRuntime({ pool, lease, root, commandPort })
    await appeared.complete()
    await expect(appeared.finalize(client)).resolves.toMatchObject({ ok: false })

    deps.binding.mockResolvedValueOnce({ status: "invalid" })
    const invalid = createCanonicalObjectiveTailorRuntime({ pool, lease, root, commandPort })
    await expect(invalid.complete()).resolves.toMatchObject({ ok: false })
    await expect(invalid.finalize(client)).resolves.toMatchObject({ ok: false })
  })

  it("fails closed and rolls back when artifact completion evidence is unavailable", async () => {
    deps.binding.mockResolvedValueOnce(bound)
    deps.candidateGate.mockResolvedValue({ ok: false, blocker: "selected_job_draft_review_required", feedback: "safe" })
    const runtime = createCanonicalObjectiveTailorRuntime({ pool, lease, root, commandPort })

    await expect(runtime.complete()).resolves.toMatchObject({ ok: false })
    expect(client.query).toHaveBeenCalledWith("ROLLBACK")
    expect(client.query).not.toHaveBeenCalledWith("COMMIT")
    expect(client.release).toHaveBeenCalledOnce()
  })
})
