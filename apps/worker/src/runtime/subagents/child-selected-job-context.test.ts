import { beforeEach, describe, expect, it, vi } from "vitest"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection } from "./objective-tailor-wave-witness.js"
import { OBJECTIVE_TAILOR_CANDIDATE_WITNESS_SCHEMA } from "./objective-tailor-witness.js"
import type pg from "pg"
import { loadChildSelectedJobSource, projectChildTaskContext } from "./child-selected-job-context.js"
import { bindObjectiveTailorCandidateWitness, makeObjectiveTailorCandidateSelection } from "./objective-tailor-witness.js"
import { bindObjectiveTailorCorrectionProof } from "./objective-tailor-correction-proof.js"
import { objectiveTailorNodeKeysForCandidate } from "./objective-task-graph-child-authority.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

const mocks = vi.hoisted(() => ({ loadGraph: vi.fn(), loadObjective: vi.fn(), loadScheduled: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: mocks.loadGraph }))
vi.mock("./objective-tailor-writer-source.js", () => ({ loadObjectiveTailorChildSource: mocks.loadObjective }))
vi.mock("./scheduled-draft-writer-source.js", () => ({ loadSelectedJobArtifactContextForChild: mocks.loadScheduled }))

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
const selection = makeObjectiveTailorCandidateSelection({ scope, sourceGraphRevision: 1, sourceGraphDigest: "a".repeat(64),
  sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
  candidate: { jobId, score: 8.5, materialDigest: `sha256:${"d".repeat(64)}` }, sourceAnalystKeys: ["analyst-1"] })!
const witness = bindObjectiveTailorCandidateWitness(selection, {
  ...objectiveTailorNodeKeysForCandidate(selection.candidateRef)!, admittedRevision: 2,
})!
const waveSelection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 1, sourceGraphDigest: "e".repeat(64),
  sourceStatusDigest: "f".repeat(64), analystProofDigest: "1".repeat(64),
  candidate: { jobId, score: 8.5, materialDigest: `sha256:${"d".repeat(64)}` }, sourceAnalystKey: "analyst-1" })!
const waveWitness = bindObjectiveTailorWaveCandidateWitness(waveSelection, { slotId: "tailor-1", admittedRevision: 2 })!
const correctionProof = bindObjectiveTailorCorrectionProof({ graphRevision: 3, slotId: waveWitness.slotId,
  candidateWitness: waveWitness, writerTaskId: "writer-initial", reviewerTaskId: "reviewer-initial",
  artifactRef: { artifactId: "artifact-1", version: 1, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}` },
  artifactVersion: { artifactId: "artifact-1", artifactType: "cover_letter", taskId: "writer-initial", version: 1,
    contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}`, previousHash: null },
  reviewReceipt: { jobId, artifactId: "artifact-1", version: 1, contentHash: `sha256:${"a".repeat(64)}`,
    sourceDigest: `sha256:${"d".repeat(64)}`, currentSourceDigest: `sha256:${"d".repeat(64)}`, status: "needs_revision",
    taskId: "reviewer-initial", toolCallId: "review-call", reviewHash: `sha256:${"e".repeat(64)}` } })!

function objectiveTask(role: "writer" | "reviewer" = "writer"): SubagentTaskRecord {
  return {
    id: `${role}-1`, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, path: "/root/child", depth: 1,
    role, taskType: role === "writer" ? "cover_letter_draft" : "cover_letter_review", status: "running",
    goal: "Prepare or review a cover letter", constraints: [], successCriteria: [], allowedActions: [],
    context: { objectiveTailorCandidateMode: true, objectiveTailorCandidateWitness: witness, selectedJobPreparation: { jobId },
      taskGraphDependencyResults: { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [] } },
    expectedOutputSchema: {}, modelProfileSnapshot: {}, result: null, failureReason: null, attemptCount: 1,
    maxAttempts: 1, leaseOwner: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null,
    budgetSnapshot: {}, toolPolicySnapshot: {},
  }
}

function objectiveLease(role: "writer" | "reviewer" = "writer"): SubagentLease {
  return { ...objectiveTask(role), turnId: scope.turnId, parentTaskId: scope.parentTaskId,
    leaseExpiresAt: new Date(Date.now() + 60_000), ownerId: "worker-1", signal: new AbortController().signal }
}

function fakePool() {
  const client = { query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) }
  return { client, pool: pool as unknown as pg.Pool }
}

describe("child selected-job context", () => {
  beforeEach(() => { mocks.loadGraph.mockReset(); mocks.loadObjective.mockReset(); mocks.loadScheduled.mockReset() })

  it("projects only the selected Job's dependency evidence and strips private Objective proof", () => {
    const baseContext = objectiveTask().context as Record<string, unknown>
    const task = {
      ...objectiveTask(), context: {
        ...baseContext,
        taskGraphDependencyResults: { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [
          { role: "analyst", result: { role: "analyst", findings: [{ jobId, note: "keep" }, { jobId: "2b9c7d54-008f-4d88-a716-8ba51497c63b", note: "exclude" }], findingCount: 2 } },
          { role: "scout", result: { role: "scout", candidates: [{ jobId, score: 8 }, { jobId: "2b9c7d54-008f-4d88-a716-8ba51497c63b", score: 9 }], candidateCount: 2 } },
        ] },
      },
    }
    const projection = projectChildTaskContext(task)
    const serialized = JSON.stringify(projection.context)

    expect(projection).toMatchObject({ selectedJobId: jobId, scheduledDraft: false })
    expect(serialized).toContain(`"jobId":"${jobId}"`)
    expect(serialized).not.toContain("2b9c7d54-008f-4d88-a716-8ba51497c63b")
    expect(serialized).not.toContain("objectiveTailorCandidateMode")
    expect(serialized).not.toContain("objectiveTailorCandidateWitness")
    expect(serialized).not.toContain(witness.candidateRef)
    expect(projection.context).toMatchObject({ taskGraphDependencyResults: { items: [
      { result: { findings: [{ jobId, note: "keep" }], findingCount: 1 } },
      { result: { candidates: [{ jobId, score: 8 }], candidateCount: 1 } },
    ] } })
  })

  it("projects the closed V2 witness through the same private-field and selected-Job boundary", () => {
    const task = { ...objectiveTask(), context: { ...objectiveTask().context as object,
      objectiveTailorCandidateWitness: waveWitness } }
    const projection = projectChildTaskContext(task)
    const serialized = JSON.stringify(projection.context)
    expect(projection).toMatchObject({ selectedJobId: jobId, scheduledDraft: false })
    expect(serialized).not.toContain("objectiveTailorCandidateMode")
    expect(serialized).not.toContain("objectiveTailorCandidateWitness")
    expect(serialized).not.toContain(waveWitness.candidateRef)
  })

  it("strips a valid correction proof before model context and rejects malformed proof", () => {
    const context = { ...objectiveTask().context as object, objectiveTailorCandidateWitness: waveWitness,
      objectiveTailorCorrectionProof: correctionProof }
    const projected = projectChildTaskContext({ ...objectiveTask(), context })
    const serialized = JSON.stringify(projected.context)
    expect(projected.selectedJobId).toBe(jobId)
    expect(serialized).not.toContain("objectiveTailorCorrectionProof")
    expect(serialized).not.toContain("review-call")
    expect(serialized).not.toContain("writer-initial")
    expect(() => projectChildTaskContext({ ...objectiveTask(), context: {
      ...context, objectiveTailorCorrectionProof: { ...correctionProof, prior: {} },
    } })).toThrow("objective_tailor_child_context_invalid")
  })

  it.each([
    ["unknown schema", { ...waveWitness, schemaVersion: "agent-harness.v2.objective-tailor-wave-witness.v9" }],
    ["mixed schema", { ...waveWitness, schemaVersion: OBJECTIVE_TAILOR_CANDIDATE_WITNESS_SCHEMA }],
    ["malformed V2", { ...waveWitness, candidateRef: [] }],
  ])("rejects %s without falling back to another witness version", (_name, badWitness) => {
    const task = { ...objectiveTask(), context: { ...objectiveTask().context as object,
      objectiveTailorCandidateWitness: badWitness } }
    expect(() => projectChildTaskContext(task)).toThrow("objective_tailor_child_context_invalid")
  })

  it.each([
    ["missing mode", { objectiveTailorCandidateWitness: witness, selectedJobPreparation: { jobId } }],
    ["missing witness", { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId } }],
    ["wrong mode", { objectiveTailorCandidateMode: false, objectiveTailorCandidateWitness: witness, selectedJobPreparation: { jobId } }],
    ["wrong job", { objectiveTailorCandidateMode: true, objectiveTailorCandidateWitness: witness, selectedJobPreparation: { jobId: "2b9c7d54-008f-4d88-a716-8ba51497c63b" } }],
  ])("fails closed for malformed Objective child context: %s", (_name, context) => {
    expect(() => projectChildTaskContext({ ...objectiveTask(), context })).toThrow("objective_tailor_child_context_invalid")
  })

  it("loads an Objective source under one owner-scoped client and does not fall back when stale", async () => {
    const { client, pool } = fakePool()
    const loaded = { rootTaskId: scope.rootTaskId } as LoadedGraph
    mocks.loadGraph.mockResolvedValue(loaded)
    const source = { context: { preparation: { jobId }, transientSources: [] } }
    mocks.loadObjective.mockResolvedValueOnce(source).mockResolvedValueOnce(undefined)
    mocks.loadScheduled.mockReset()

    await expect(loadChildSelectedJobSource(pool, objectiveLease(), jobId)).resolves.toBe(source)
    expect(mocks.loadGraph).toHaveBeenCalledWith(client, scope, false)
    expect(mocks.loadObjective).toHaveBeenCalledWith(client, scope, loaded, expect.objectContaining({ id: "writer-1" }))
    expect(client.query.mock.calls).toEqual([
      ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"],
      ["SELECT set_config('app.user_id', $1, true)", ["user-1"]],
      ["COMMIT"],
    ])
    expect(mocks.loadScheduled).not.toHaveBeenCalled()

    client.query.mockClear()
    await expect(loadChildSelectedJobSource(pool, objectiveLease("reviewer"), jobId))
      .rejects.toThrow("writer_review_receipt_unavailable")
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK")
    expect(mocks.loadScheduled).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledTimes(2)
  })

  it("rejects a private Objective marker with no selected Job before opening a source connection", async () => {
    const { pool } = fakePool()
    const lease = { ...objectiveLease(), context: { objectiveTailorCandidateMode: true, objectiveTailorCandidateWitness: witness } }

    await expect(loadChildSelectedJobSource(pool, lease, undefined)).rejects.toThrow("writer_review_receipt_unavailable")
    expect(pool.connect).not.toHaveBeenCalled()
    expect(mocks.loadScheduled).not.toHaveBeenCalled()
  })

  it("preserves the scheduled and ordinary selected-job loader paths", async () => {
    const { pool } = fakePool()
    const task = objectiveTask()
    const ordinary = { ...objectiveLease(), context: { selectedJobPreparation: { jobId } } }
    const scheduled = { ...objectiveLease(), context: { selectedJobPreparation: { jobId }, scheduledDraftCandidateMode: true, scheduledDraftCandidateWitness: {} } }
    mocks.loadScheduled.mockResolvedValue({ context: {} })

    await loadChildSelectedJobSource(pool, ordinary, jobId)
    await loadChildSelectedJobSource(pool, scheduled, jobId)
    expect(mocks.loadScheduled).toHaveBeenNthCalledWith(1, pool, "user-1", jobId, ordinary.context)
    expect(mocks.loadScheduled).toHaveBeenNthCalledWith(2, pool, "user-1", jobId, scheduled.context)
  })
})
