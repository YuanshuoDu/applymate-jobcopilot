import { beforeEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING, type TaskGraphFinalSummaryBinding } from "./subagents/task-graph-final-summary-binding.js"
import type { SelectedJobBatchCompletionWitness } from "./multi-selected-job-completion-gate.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"

const mocks = vi.hoisted(() => ({ verify: vi.fn(), attach: vi.fn() }))
vi.mock("./canonical-selected-job-batch-completion.js", () => ({ verifyCanonicalSelectedJobBatchCompletion: mocks.verify }))
vi.mock("./subagents/selected-job-batch-final-outcome.js", () => ({ attachSelectedJobBatchFinalOutcome: mocks.attach }))

import { createCanonicalSelectedJobBatchRuntime, scopeSelectedJobBatchRootState } from "./canonical-selected-job-batch-runtime.js"
import type { TurnLease } from "./turns/lease.js"
import type { PoolClient } from "pg"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", userId: "user-1", ownerId: "worker-1", leaseVersion: 3,
  leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000),
}
const graphBinding = { rootTaskId: "root-1", graphItemId: "graph-1", graphRevision: 8,
  members: [], summary: { graphRevision: 8 } } as unknown as TaskGraphFinalSummaryBinding
const enrichedBinding = { ...graphBinding, selectedJobBatchFinalOutcome: { graphRevision: 8 } } as TaskGraphFinalSummaryBinding
const witness = { graph: { revision: 8, nodes: [] }, slots: [] } as unknown as SelectedJobBatchCompletionWitness

function fakeClient(failCommit = false) {
  const calls: string[] = []
  const query = vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql === "COMMIT" && failCommit) throw new Error("commit_failed")
    return { rows: [], rowCount: 0 }
  })
  return { client: { query, release: vi.fn() } as unknown as PoolClient, calls, query }
}

function fixture(options: { failCommit?: boolean; rootResult?: TurnEngineCompletionGateResult } = {}) {
  const candidateClient = fakeClient(options.failCommit)
  const pool = { connect: vi.fn(async () => candidateClient.client) }
  const rootCheck = vi.fn(async (_input: { client?: PoolClient }): Promise<TurnEngineCompletionGateResult> => options.rootResult ??
    ({ ok: true, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: graphBinding }))
  const runtime = createCanonicalSelectedJobBatchRuntime({
    pool, lease, root: { id: "root-1", attemptCount: 2 }, binding: {} as never,
    commandPort: {} as never, rootTasks: { checkCompletion: rootCheck }, now: () => new Date(1),
  })
  return { runtime, candidateClient, pool, rootCheck }
}

beforeEach(() => {
  mocks.verify.mockReset().mockResolvedValue({ status: "ready", outcomes: [], witness })
  mocks.attach.mockReset().mockReturnValue(enrichedBinding)
})

describe("canonical selected-job batch runtime", () => {
  it("checks the ordinary graph and batch proof on one tenant candidate client, then the exact final-commit client", async () => {
    const state = fixture(), terminal = fakeClient()

    await expect(state.runtime.checkCandidate(false)).resolves.toMatchObject({ ok: true })
    expect(state.candidateClient.calls).toEqual(["BEGIN", "SELECT set_config('app.user_id', $1, true)", "COMMIT"])
    expect(state.rootCheck).toHaveBeenCalledWith(expect.objectContaining({ client: state.candidateClient.client,
      lease, rootTaskId: "root-1", taskGraphVerification: true, requireTaskGraph: true, nativeVerificationPassed: false }))
    expect(mocks.verify).toHaveBeenNthCalledWith(1, expect.objectContaining({ client: state.candidateClient.client, binding: {} }))
    expect(mocks.attach).toHaveBeenCalledWith(graphBinding, witness)

    await expect(state.runtime.checkTerminal(terminal.client, true)).resolves.toMatchObject({ ok: true })
    expect(state.pool.connect).toHaveBeenCalledOnce()
    expect(state.rootCheck).toHaveBeenLastCalledWith(expect.objectContaining({ client: terminal.client, nativeVerificationPassed: true }))
    expect(mocks.verify).toHaveBeenNthCalledWith(2, expect.objectContaining({ client: terminal.client, acceptedWitness: witness }))
    expect(mocks.attach).toHaveBeenLastCalledWith(graphBinding, witness)
  })

  it("does not retain candidate proof when its transaction fails to commit", async () => {
    const state = fixture({ failCommit: true }), terminal = fakeClient()

    await expect(state.runtime.checkCandidate(false)).rejects.toThrow("commit_failed")
    await expect(state.runtime.checkTerminal(terminal.client, false)).resolves.toMatchObject({ ok: false })
    expect(state.candidateClient.calls).toContain("ROLLBACK")
    expect(state.candidateClient.client.release).toHaveBeenCalledOnce()
    expect(state.rootCheck).toHaveBeenCalledOnce()
    expect(mocks.verify).toHaveBeenCalledOnce()
  })

  it("clears accepted proof for a new candidate and denies terminal checks without one", async () => {
    const state = fixture(), terminal = fakeClient()
    await state.runtime.checkCandidate(false)
    state.runtime.clear()

    await expect(state.runtime.checkTerminal(terminal.client, false)).resolves.toMatchObject({ ok: false })
    expect(state.rootCheck).toHaveBeenCalledOnce()
    expect(mocks.verify).toHaveBeenCalledOnce()
  })

  it("denies a terminal proof that changed after candidate acceptance", async () => {
    const state = fixture(), terminal = fakeClient()
    await state.runtime.checkCandidate(false)
    mocks.verify.mockResolvedValueOnce({ status: "drifted", outcomes: [] })

    await expect(state.runtime.checkTerminal(terminal.client, false)).resolves.toMatchObject({ ok: false })
    expect(mocks.verify).toHaveBeenLastCalledWith(expect.objectContaining({ client: terminal.client, acceptedWitness: witness }))
    expect(mocks.attach).toHaveBeenCalledOnce()
  })

  it("propagates the ordinary root graph denial and rejects a pending batch result", async () => {
    const rootDenied = { ok: false as const, blocker: "child_tasks_pending", feedback: "pending" }
    const first = fixture({ rootResult: rootDenied })
    await expect(first.runtime.checkCandidate(false)).resolves.toEqual(rootDenied)
    expect(mocks.verify).not.toHaveBeenCalled()

    const second = fixture()
    mocks.verify.mockResolvedValueOnce({ status: "pending", outcomes: [{ status: "pending" }] })
    await expect(second.runtime.checkCandidate(false)).resolves.toMatchObject({ ok: false })
    await expect(second.runtime.checkTerminal(fakeClient().client, false)).resolves.toMatchObject({ ok: false })
    expect(mocks.attach).not.toHaveBeenCalled()
  })

  it("limits fresh and recovered Root business references to the exact selected Jobs", () => {
    const source = { snapshot: { system: [], profile: [], steerHistory: [], toolObservations: [], businessRefs: [
      { id: "job-a", kind: "job", ownerId: "user-1" }, { id: "job-b", kind: "jd", ownerId: "user-1" },
      { id: "job-other", kind: "job", ownerId: "user-1" }, { id: "resume-1", kind: "attachment", ownerId: "user-1" },
    ] } } as unknown as CanonicalTurnState
    const scoped = scopeSelectedJobBatchRootState(source, ["job-a", "job-b"])

    expect(scoped.snapshot.businessRefs.map(reference => reference.id)).toEqual(["job-a", "job-b", "resume-1"])
    expect(source.snapshot.businessRefs).toHaveLength(4)
  })
})
