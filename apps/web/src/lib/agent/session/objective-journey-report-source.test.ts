import { beforeEach, describe, expect, it, vi } from "vitest"
import { canonicalTaskGraphItemId, canonicalTaskGraphSourceKey } from "./final-task-graph-source-detail"
import { readFinalTaskGraphSourceSnapshot } from "./objective-tailor-final-source-graph"
import { parseObjectiveTailorProgressSnapshot } from "./objective-tailor-progress-snapshot"
import { readObjectiveJourneySource } from "./objective-journey-report-source"

const mocks = vi.hoisted(() => ({ pairProof: vi.fn(), validManifest: vi.fn() }))
vi.mock("../broker/objective-application-review-source-proof", async importOriginal => {
  const actual = await importOriginal<typeof import("../broker/objective-application-review-source-proof")>()
  return { ...actual, objectiveApplicationReviewPairProof: mocks.pairProof, validObjectiveApplicationSourceManifest: mocks.validManifest }
})

const userId = "owner-1", sessionId = "session-1", turnId = "source-turn-1", rootId = "source-root-1", finalId = "source-final-1"
const graphId = canonicalTaskGraphItemId(rootId)

describe("readObjectiveJourneySource", () => {
  beforeEach(() => { mocks.pairProof.mockReset(); mocks.validManifest.mockReturnValue(true) })

  it("keeps each tailoring status when one ready slot has a missing Job and accepts multi-Analyst candidate context", async () => {
    const fixture = sourceFixture()
    const tx = fixture.client
    expect(parseObjectiveTailorProgressSnapshot(fixture.graphContent)).toBeDefined()
    expect(readFinalTaskGraphSourceSnapshot(fixture.graphContent, fixture.content)?.kind).toBe("objective-tailor")
    const result = await readObjectiveJourneySource(tx as never, { userId, sessionId, finalItemId: finalId })

    expect(result?.slots.map(slot => [slot.ordinal, slot.tailoringStatus, slot.job, slot.sourceReady])).toEqual([
      [1, "ready", null, false], [2, "needs_revision", { company: "Acme", role: "Engineer" }, false],
    ])
    expect(result?.slots[0]?.jobId).toBeNull()
    expect(tx.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId, id: { in: ["job-deleted", "job-2"] } } }))
    expect(mocks.pairProof).not.toHaveBeenCalled()
  })

  it("rejects duplicate persisted task identities instead of binding an ambiguous graph", async () => {
    const fixture = sourceFixture()
    fixture.taskRows[fixture.taskRows.length - 1] = { ...fixture.taskRows[0] }
    const result = await readObjectiveJourneySource(fixture.client as never, { userId, sessionId, finalItemId: finalId })
    expect(result).toBeNull()
  })
})

function sourceFixture() {
  const verify = (role: "scout" | "analyst") => ({ schemaVersion: "agent-harness.v2.task-graph-verification.v1", role,
    criteria: [{ id: role === "scout" ? "candidate-count" : "finding-count",
      check: { kind: role === "scout" ? "candidate_count_gte" : "finding_count_gte", minimum: 1 } }] })
  const sources = [
    node("scout-1", "task-scout-1", "scout", [], 1, verify("scout")),
    node("analyst-1", "task-analyst-1", "analyst", ["scout-1"], 2, verify("analyst")),
    node("analyst-2", "task-analyst-2", "analyst", ["scout-1"], 2, verify("analyst")),
  ]
  const slots = [1, 2].map(ordinal => ({ slotId: `tailor-${ordinal}`, sourceAnalystNodeKey: `analyst-${ordinal}`,
    writerNodeKey: `writer-${ordinal}`, reviewerNodeKey: `reviewer-${ordinal}` }))
  const suffix = slots.flatMap((slot, index) => [
    node(slot.writerNodeKey, `task-${slot.writerNodeKey}`, "cover_letter_writer", [slot.sourceAnalystNodeKey], 3, undefined),
    node(slot.reviewerNodeKey, `task-${slot.reviewerNodeKey}`, "cover_letter_reviewer", [slot.writerNodeKey], 4, undefined),
  ])
  const witness = (ordinal: number) => ({ schemaVersion: "agent-harness.v2.objective-tailor-wave-witness.v1",
    candidateRef: `otc2_${String(ordinal).repeat(64)}`, sourceGraphRevision: 8, sourceGraphDigest: "a".repeat(64),
    sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
    candidate: { jobId: ordinal === 1 ? "job-deleted" : "job-2", score: 8, materialDigest: `sha256:${"d".repeat(64)}` },
    sourceAnalystKeys: ordinal === 1 ? ["analyst-1", "analyst-2"] : ["analyst-2"], slotId: `tailor-${ordinal}`,
    writerNodeKey: `writer-${ordinal}`, reviewerNodeKey: `reviewer-${ordinal}`, admittedRevision: 9 })
  const contexts = slots.map((slot, index) => ({ objectiveTailorCandidateMode: true,
    objectiveTailorCandidateWitness: witness(index + 1), selectedJobPreparation: { jobId: witness(index + 1).candidate.jobId } }))
  const taskRows = [
    { id: rootId, sessionId, turnId, rootTaskId: rootId, parentTaskId: null, role: "orchestrator", taskType: "root", status: "completed",
      result: { status: "completed", finalItemId: finalId }, context: {} },
    ...sources.map((source, index) => ({ id: source.taskId, sessionId, turnId, rootTaskId: rootId, parentTaskId: rootId,
      role: source.templateId, taskType: source.templateId, status: "completed", result: {}, context: {} })),
    ...suffix.map((task, index) => ({ id: task.taskId, sessionId, turnId, rootTaskId: rootId, parentTaskId: rootId,
      role: task.templateId === "cover_letter_writer" ? "writer" : "reviewer", taskType: task.templateId,
      status: "completed", result: {}, context: contexts[Math.floor(index / 2)] })),
  ]
  const content = { text: "Final answer", final: { schemaVersion: "agent-harness.v2.final", response: "Final answer" },
    taskGraphSources: { schemaVersion: "agent-harness.v2.task-graph-sources.v1", graphRevision: 9,
      sources: sources.map((source, nodeIndex) => ({ sourceKey: canonicalTaskGraphSourceKey(finalId, 9, nodeIndex), nodeIndex,
        role: source.templateId, taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" })) },
    objectiveTailorFinalOutcomes: { schemaVersion: "agent-harness.v2.objective-tailor-final-outcomes.v1",
      slots: [{ ordinal: 1, status: "ready" }, { ordinal: 2, status: "needs_revision" }] } }
  const graphContent = { schemaVersion: "agent-harness.v2.task-graph", nodes: [...sources, ...suffix],
    objectiveTailor: { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: sources.length, slots } }
  const itemRows = (where: Record<string, unknown>) => where.id === finalId ? [{ id: finalId, sessionId, turnId, taskId: rootId,
    type: "agent_message", status: "completed", phase: "final_answer", content }] : [{ id: graphId, sessionId, turnId,
    taskId: rootId, type: "task_graph", revision: 9, content: graphContent }]
  const client = {
    agentSession: { findMany: vi.fn(async () => [{ id: sessionId, userId }]) },
    agentItem: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => itemRows(where)) },
    agentTurn: { findMany: vi.fn(async () => [{ id: turnId, userId, sessionId, status: "completed", source: "user",
      executionMode: "canonical_task_graph", rootTaskId: rootId }]) },
    subAgentTask: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.parentTaskId === null
      ? [{ id: rootId, status: "completed", result: { status: "completed", finalItemId: finalId }, failureReason: null,
        completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null }]
      : taskRows.filter(row => (where.id as { in: string[] }).in.includes(row.id))) },
    job: { findMany: vi.fn(async () => [{ id: "job-2", userId, company: "Acme", role: "Engineer" }]) },
  }
  return { client, taskRows, content, graphContent }
}

function node(key: string, taskId: string, templateId: string, dependsOn: string[], depth: number, verification: unknown) {
  return { key, taskId, templateId, goal: "Source work", successCriteria: ["Return typed evidence"], dependsOn, depth,
    ...(verification ? { verification, verificationDisposition: "typed" } : { verificationDisposition: "specialized" }) }
}
