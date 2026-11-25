import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION,
  OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { canonicalTaskGraphJson, taskGraphItemId, taskGraphState, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { buildTaskGraphFinalSummaryBinding, sameTaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { buildCurrentTaskGraphFinalSummaryBinding, OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA, renderObjectiveTailorFinalOutcome } from "./objective-tailor-final-summary-binding.js"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection,
  objectiveTailorWavePairPlan } from "./objective-tailor-wave-witness.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import type { TurnLease } from "../turns/lease.js"
import type { ObjectiveTailorWaveCompletionWitness, ObjectiveTailorWaveSlotOutcome } from "../canonical-objective-tailor-wave-completion.js"

const mocks = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock("../canonical-objective-tailor-wave-completion.js", async importOriginal => ({
  ...await importOriginal<typeof import("../canonical-objective-tailor-wave-completion.js")>(),
  verifyCanonicalObjectiveTailorWaveCompletion: mocks.verify,
}))

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const lease: TurnLease = { ...scope, ownerId: "owner-1", leaseVersion: 3, leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000) }
const taskDigest = (value: unknown) => createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex")
const verification = (role: "scout" | "analyst", dependencyNodeKey?: string) => ({
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role,
  criteria: [{ id: "current-evidence", check: role === "scout" ? { kind: "candidate_count_gte", minimum: 1 }
    : { kind: "findings_from_scout_dependency", dependencyNodeKey: dependencyNodeKey! } }],
})

function fixture() {
  const sourceNodes = [
    ...Array.from({ length: 4 }, (_, index) => ({ key: "scout-" + (index + 1), taskId: "scout-task-" + (index + 1),
      templateId: "scout", goal: "Find candidates", successCriteria: ["Find current jobs"], dependsOn: [], depth: 1,
      verificationDisposition: "typed", verification: verification("scout" as const) })),
    ...Array.from({ length: 4 }, (_, index) => ({ key: "analyst-" + (index + 1), taskId: "analyst-task-" + (index + 1),
      templateId: "analyst", goal: "Verify candidates", successCriteria: ["Verify current jobs"], dependsOn: ["scout-" + (index + 1)], depth: 2,
      verificationDisposition: "typed", verification: verification("analyst" as const, "scout-" + (index + 1)) })),
  ]
  const sourceSnapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: sourceNodes })
  const sourceGraphDigest = taskDigest(sourceSnapshot)
  const sourceStatusDigest = taskDigest(sourceNodes.map(node => ({ key: node.key, status: "completed" })))
  const materialDigest = "sha256:" + "d".repeat(64)
  const pairs = Array.from({ length: 8 }, (_, index) => {
    const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d47" + (index + 1)
    const sourceAnalystKey = "analyst-" + (index % 4 + 1)
    const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 10, sourceGraphDigest,
      sourceStatusDigest, analystProofDigest: "b".repeat(64),
      candidate: { jobId, score: 9 - index / 10, materialDigest }, sourceAnalystKey })!
    const witness = bindObjectiveTailorWaveCandidateWitness(selection, { slotId: "tailor-" + (index + 1), admittedRevision: 11 + index })!
    return { witness, plan: objectiveTailorWavePairPlan(witness)! }
  })
  const marker = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: 8,
    slots: pairs.map(({ witness }) => ({ slotId: witness.slotId, sourceAnalystNodeKey: witness.sourceAnalystKeys[0],
      writerNodeKey: witness.writerNodeKey, reviewerNodeKey: witness.reviewerNodeKey })) }
  const nodes: Array<Record<string, unknown>> = [...sourceNodes]
  const statuses = new Map<string, { status: "completed"; failureReason: null }>()
  const tasks = new Map<string, GraphTaskRow>()
  for (const node of sourceNodes) {
    statuses.set(node.taskId, { status: "completed", failureReason: null })
    tasks.set(node.taskId, { id: node.taskId, role: node.templateId, taskType: node.templateId === "scout" ? "job_discovery" : "job_analysis",
      status: "completed", failureReason: null, result: null })
  }
  const outcomes: ObjectiveTailorWaveSlotOutcome[] = []
  for (const [index, pair] of pairs.entries()) {
    const writerTaskId = "writer-task-" + (index + 1), reviewerTaskId = "reviewer-task-" + (index + 1)
    const writer = pair.plan.proposal.nodes[0]!, reviewer = pair.plan.proposal.nodes[1]!
    nodes.push({ ...writer, taskId: writerTaskId, depth: 3 }, { ...reviewer, taskId: reviewerTaskId, depth: 4 })
    for (const [id, role, taskType] of [[writerTaskId, "writer", "cover_letter_draft"], [reviewerTaskId, "reviewer", "cover_letter_review"]] as const) {
      statuses.set(id, { status: "completed", failureReason: null })
      tasks.set(id, { id, role, taskType, status: "completed", failureReason: null, result: null })
    }
    outcomes.push({ slotId: pair.witness.slotId, jobId: pair.witness.candidate.jobId, writerTaskId, reviewerTaskId,
      status: index === 0 ? "ready" : "needs_revision", candidateWitness: pair.witness })
  }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes, objectiveTailor: marker })
  const graphRevision = 24
  const loaded: LoadedGraph = { rootTaskId: scope.rootTaskId, snapshot,
    item: { id: taskGraphItemId(scope.rootTaskId), revision: graphRevision, content: snapshot, createdAt: new Date(0) },
    state: taskGraphState(snapshot, graphRevision, statuses, []), tasks, discoveryTurnEligibility: "ordinary" }
  const waveMarker = snapshot.objectiveTailor!
  const witness: ObjectiveTailorWaveCompletionWitness = { graphRevision, graphDigest: taskDigest(snapshot), marker: waveMarker,
    sourceGraphRevision: 10, sourceGraphDigest, sourceStatusDigest, outcomes }
  const client = { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: scope.rootTaskId, attemptCount: 2,
    turnInput: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } }], rowCount: 1 })) }
  return { loaded, client, witness, outcomes }
}

beforeEach(() => vi.resetAllMocks())

describe("Objective Tailor final summary binding", () => {
  it("summarizes a verified 24-node wave from only its typed eight-node source prefix", async () => {
    const { loaded, client, witness, outcomes } = fixture()
    mocks.verify.mockResolvedValue({ status: "ready", outcomes, witness })

    const binding = await buildCurrentTaskGraphFinalSummaryBinding({ client: client as never, lease,
      rootTaskId: scope.rootTaskId, loaded, buildOrdinary: buildTaskGraphFinalSummaryBinding })

    expect(binding?.graphRevision).toBe(24)
    expect(binding?.members).toHaveLength(8)
    expect(binding?.summary.taskOutcomes).toHaveLength(8)
    expect(binding?.objectiveTailorFinalOutcome).toMatchObject({ schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA,
      rootAttemptCount: 2, graphRevision: 24, sourceNodeCount: 8 })
    expect(binding?.objectiveTailorFinalOutcome?.slots.map(({ ordinal, status }) => ({ ordinal, status }))).toEqual([
      { ordinal: 1, status: "ready" }, ...Array.from({ length: 7 }, (_, index) => ({ ordinal: index + 2, status: "needs_revision" })),
    ])
    expect(binding?.objectiveTailorFinalOutcome?.reportedScoreFloor).toEqual({ status: "not_requested" })
    const changedFloor = { ...binding!, objectiveTailorFinalOutcome: { ...binding!.objectiveTailorFinalOutcome!,
      reportedScoreFloor: { status: "complete" as const, source: "analyst_verification" as const,
        minimumScore: 7, minimumFindings: 1, aggregation: "any" as const, qualifyingJobCount: 0 } } }
    expect(sameTaskGraphFinalSummaryBinding(binding, changedFloor)).toBe(false)
    expect(client.query).toHaveBeenCalledTimes(1)
    const sql = client.query.mock.calls[0]?.[0] as string
    expect(sql).toContain("clock_timestamp()")
    expect(sql).not.toMatch(/FOR UPDATE/i)
    expect(renderObjectiveTailorFinalOutcome(binding)).toEqual([
      "Objective Tailor review: 1 ready (review passed and source current), 7 not ready (7 needs revision).",
      "Per-slot review: slot 1 ready, slot 2 needs revision, slot 3 needs revision, slot 4 needs revision, slot 5 needs revision, slot 6 needs revision, slot 7 needs revision, slot 8 needs revision.",
    ])
    expect(JSON.stringify(renderObjectiveTailorFinalOutcome(binding))).not.toMatch(/f47ac|writer-task|artifact|sha256|reviewHash/)
  })

  it("keeps ordinary unmarked summaries on the existing reducer path", async () => {
    const loaded: LoadedGraph = { rootTaskId: scope.rootTaskId, item: null, snapshot: null, state: null, tasks: new Map() }
    const client = { query: vi.fn() }, ordinary = vi.fn(() => null)
    await expect(buildCurrentTaskGraphFinalSummaryBinding({ client: client as never, lease, rootTaskId: scope.rootTaskId,
      loaded, buildOrdinary: ordinary })).resolves.toBeNull()
    expect(ordinary).toHaveBeenCalledWith(loaded, undefined, undefined)
    expect(client.query).not.toHaveBeenCalled()
  })

  it("withholds a requested count when the leased Turn input no longer matches the V2 marker", async () => {
    const value = fixture(), prior = value.loaded.snapshot!.objectiveTailor!
    const marker = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION,
      sourceNodeCount: 8, reportScoreFloor: 8, slots: prior.slots }
    const snapshot = { ...value.loaded.snapshot!, objectiveTailor: marker }
    const loaded = { ...value.loaded, snapshot, item: { ...value.loaded.item!, content: snapshot },
      state: { ...value.loaded.state!, objectiveTailor: marker } }
    const witness = { ...value.witness, graphDigest: taskDigest(snapshot), marker }
    mocks.verify.mockResolvedValue({ status: "ready", outcomes: value.outcomes, witness })
    value.client.query.mockResolvedValue({ rows: [{ id: scope.rootTaskId, attemptCount: 2,
      turnInput: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, reportScoreFloor: 9 } }], rowCount: 1 } as never)

    const binding = await buildCurrentTaskGraphFinalSummaryBinding({ client: value.client as never, lease,
      rootTaskId: scope.rootTaskId, loaded, buildOrdinary: buildTaskGraphFinalSummaryBinding })
    expect(binding?.objectiveTailorFinalOutcome?.reportedScoreFloor).toEqual({ status: "unavailable" })
  })

  it("fails closed for a blocked V2 verification without falling back to the ordinary reducer", async () => {
    const { loaded, client } = fixture(), ordinary = vi.fn(() => null)
    mocks.verify.mockResolvedValue({ status: "blocked", outcomes: [] })
    await expect(buildCurrentTaskGraphFinalSummaryBinding({ client: client as never, lease, rootTaskId: scope.rootTaskId,
      loaded, buildOrdinary: ordinary })).resolves.toBeNull()
    expect(ordinary).not.toHaveBeenCalled()
  })
})
