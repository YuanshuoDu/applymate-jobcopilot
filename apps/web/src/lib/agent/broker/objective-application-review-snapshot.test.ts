import { createHash } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ envelope: null as unknown, sourceRoot: "source-root-distinct",
  slot: null as null | { slotId: string; writerNodeKey: string; reviewerNodeKey: string;
    correction?: { writerNodeKey: string; reviewerNodeKey: string } } }))
const hash = "a".repeat(64), artifactHash = `sha256:${hash}`, digest = `sha256:${"b".repeat(64)}`
const selectionHash = createHash("sha256").update("canonical-selection").digest("hex")
const graphId = `task-graph-${createHash("sha256").update("source-root-distinct").digest("hex")}`
const selection = { schema: "agent-harness.v2.objective-application-review-selection.v1", sourceTurnId: "source-turn",
  rootTaskId: "source-root-distinct", graphItemId: graphId, graphRevision: 7, slotOrdinals: [1] }
const resumeWitness = { schema: "agent-harness.v2.objective-application-resume-witness.v1", userId: "user-1",
  jobId: "job-1", resumeId: "resume-1", finalResumeAssignmentRevision: 2, materialRevision: 4, materialHash: hash }
const proof = { schema: "agent-harness.v1.objective-application-review-member-proof.v1",
  source: { jobId: "job-1", sourceTurnId: "source-turn", rootTaskId: "source-root-distinct", graphItemId: graphId,
    graphRevision: 7, finalItemId: "source-final", slotOrdinal: 1, writerTaskId: "writer-1", reviewerTaskId: "reviewer-1",
    reviewerToolCallId: "review-call", reviewHash: artifactHash, artifactId: "artifact-1", version: 1, contentHash: artifactHash, sourceDigest: digest },
  resumeWitness, materialProofHash: hash }
const setId = (sessionId: string, turnId: string) => `objective-review-${createHash("sha256")
  .update(`objective-application-review-set.v1\0${sessionId}\0${turnId}`).digest("hex").slice(0, 40)}`

vi.mock("@jobcopilot/agent-protocol", () => ({
  hashApprovalScope: vi.fn(async () => hash), objectiveApplicationApprovalSetItemId: vi.fn((id: string) => `item:${id}`),
  parseObjectiveApplicationApprovalSet: vi.fn(() => ({ setId: setId("session-1", "review-turn"), sourceTurnId: "source-turn",
    intentHash: selectionHash, expiresAt: "2099-01-01T00:00:00.000Z", members: [{ slotOrdinal: 1, approvalId: `objective-review:${setId("session-1", "review-turn")}:1` }] })),
  parseObjectiveApplicationReviewIntent: vi.fn(() => selection),
  parseObjectiveTailorGraph: vi.fn(() => ({ slots: fixture.slot ? [fixture.slot] : [] })),
  parseObjectiveTailorFinalOutcomeSidecar: vi.fn(() => ({ slots: [{ ordinal: 1, status: "ready" }] })),
}))
vi.mock("@jobcopilot/shared", () => ({
  buildObjectiveApplicationResumeWitness: vi.fn(() => resumeWitness), canonicalJson: vi.fn(() => "canonical-selection"),
  readAgentSelectedJobMaterial: vi.fn(async () => ({ preparation: { sourceDigest: digest } })),
}))
vi.mock("../artifacts/hash", () => ({ hashArtifactContent: vi.fn(() => artifactHash) }))
vi.mock("../approval/types", () => ({ protocolScope: vi.fn((value: unknown) => value) }))
vi.mock("./objective-approval-set-decision-data", () => ({
  parseObjectiveApprovalSetMemberEnvelope: vi.fn(() => fixture.envelope),
}))

import { readObjectiveApplicationReviewSnapshot } from "./objective-application-review-snapshot"

describe("readObjectiveApplicationReviewSnapshot", () => {
  beforeEach(() => { fixture.envelope = null; fixture.sourceRoot = "source-root-distinct"; fixture.slot = null })

  it("binds a distinct review Root to the completed source Root", async () => {
    const { database, tx, approvalSetId } = makeDatabase()
    const snapshot = await readObjectiveApplicationReviewSnapshot(database, { userId: "user-1", sessionId: "session-1", turnId: "review-turn" })
    expect(snapshot?.members[0]?.decisionAvailable).toBe(true)
    expect(tx.subAgentTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "review-root" }) }))
    expect(tx.agentTurn.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ rootTaskId: "source-root-distinct" }) }))
    expect(approvalSetId).toBe(setId("session-1", "review-turn"))
  })

  it("keeps a stale pending artifact visible but disables approval", async () => {
    const { database } = makeDatabase({ headVersion: 2 })
    const snapshot = await readObjectiveApplicationReviewSnapshot(database, { userId: "user-1", sessionId: "session-1", turnId: "review-turn" })
    expect(snapshot?.members[0]).toMatchObject({ status: "pending", decisionAvailable: false,
      artifactRef: { artifactId: "artifact-1", version: 1 } })
  })

  it("binds approval to the corrected Writer and Reviewer", async () => {
    const { database } = makeDatabase({ correction: true })
    const snapshot = await readObjectiveApplicationReviewSnapshot(database, { userId: "user-1", sessionId: "session-1", turnId: "review-turn" })
    expect(snapshot?.members[0]).toMatchObject({ status: "pending", decisionAvailable: true })
  })

  it("disables approval when a corrected child identity has drifted", async () => {
    const { database } = makeDatabase({ correction: true, correctionDrift: true })
    const snapshot = await readObjectiveApplicationReviewSnapshot(database, { userId: "user-1", sessionId: "session-1", turnId: "review-turn" })
    expect(snapshot?.members[0]).toMatchObject({ status: "pending", decisionAvailable: false })
  })

  it("fails closed when the source Turn Root differs from the bound proof", async () => {
    fixture.sourceRoot = "different-source-root"
    const { database } = makeDatabase()
    expect(await readObjectiveApplicationReviewSnapshot(database, { userId: "user-1", sessionId: "session-1", turnId: "review-turn" })).toBeNull()
  })
})

function makeDatabase(options: { headVersion?: number; correction?: boolean; correctionDrift?: boolean } = {}) {
  const expiresAt = new Date("2099-01-01T00:00:00.000Z"), id = `objective-review:${setId("session-1", "review-turn")}:1`
  const writerTaskId = options.correction ? "writer-corrected-1" : "writer-1"
  const reviewerTaskId = options.correction ? "reviewer-corrected-1" : "reviewer-1"
  fixture.slot = { slotId: "tailor-1", writerNodeKey: "writer-node", reviewerNodeKey: "reviewer-node",
    ...(options.correction ? { correction: { writerNodeKey: "corrected-writer-node", reviewerNodeKey: "corrected-reviewer-node" } } : {}) }
  const selectedProof = options.correction ? { ...proof, source: { ...proof.source, writerTaskId, reviewerTaskId } } : proof
  const intent = { clientMessageId: "review-command", goal: "Review the selected completed Objective materials for application preparation.",
    content: [{ type: "text", text: "Review the selected verified materials. This does not authorize an application or submission." }],
    intent: { kind: "objective_application_review", version: 1, selection } }
  const receipt = { id, userId: "user-1", sessionId: "session-1", turnId: "review-turn", type: "review_application", status: "pending",
    taskId: "application-task-1", jobId: "job-1", toolCallId: "review-call", revision: 0, expiresAt, decidedAt: null, consumedAt: null,
    resourceHash: hash, answersHash: hash, materialHash: hash, scopeHash: hash, nonceHash: hash, payload: { fixture: true } }
  fixture.envelope = { schema: "objective-application-approval-set-member.v1", setId: setId("session-1", "review-turn"),
    sourceTurnId: "source-turn", slotOrdinal: 1, proof: selectedProof }
  const pointer = { kind: "agent_artifact_version", artifactId: "artifact-1", version: options.headVersion ?? 1, contentHash: artifactHash }
  const finalResume = { id: "resume-1", userId: "user-1", name: "Resume", content: {}, templateId: null,
    templateOptions: null, kind: "adapted", targetJobId: "job-1", parentResumeId: null, basicsDetached: false, materialRevision: 4 }
  const tx = {
    agentTurn: { findMany: vi.fn(async ({ where }: { where: { id: string } }) => where.id === "review-turn"
      ? [{ id: "review-turn", userId: "user-1", sessionId: "session-1", source: "user", executionMode: "canonical_task_graph",
        status: "waiting_for_approval", revision: 3, rootTaskId: "review-root", input: intent }]
      : fixture.sourceRoot === selection.rootTaskId ? [{ id: "source-turn" }] : []) },
    subAgentTask: { findMany: vi.fn(async ({ where }: { where: { id: string } }) => where.id === "review-root"
      ? [{ id: "review-root" }] : [{ result: { status: "completed", finalItemId: "source-final" } }]) },
    agentItem: { findMany: vi.fn(async ({ where }: { where: { id: string; type: string } }) => where.type === "approval_request"
      ? [{ id: `item:${setId("session-1", "review-turn")}`, sessionId: "session-1", turnId: "review-turn", stepId: null,
        taskId: null, type: "approval_request", status: "started", phase: "commentary", revision: 0, content: {}, startedAt: new Date(), completedAt: null }]
      : where.type === "task_graph" ? [{ id: graphId, revision: 7, content: { objectiveTailor: {}, nodes: [
        { key: "writer-node", taskId: "writer-1" }, { key: "reviewer-node", taskId: "reviewer-1" },
        { key: "corrected-writer-node", taskId: options.correctionDrift ? "wrong-writer" : writerTaskId },
        { key: "corrected-reviewer-node", taskId: reviewerTaskId }] } }]
        : [{ id: "source-final", content: { text: "done", final: { schemaVersion: "agent-harness.v2.final", response: "done" },
          objectiveTailorFinalOutcomes: {} } }]) },
    agentApproval: { findMany: vi.fn(async () => [receipt]) },
    job: { findMany: vi.fn(async () => [{ id: "job-1", company: "Example", role: "Engineer", finalResumeId: "resume-1",
      finalResumeAssignmentRevision: 2, finalResume }]) },
    applicationTask: { findMany: vi.fn(async () => [{ id: "application-task-1", resumeId: "resume-1", status: "waiting_for_user",
      checkpoint: "materials_ready", workerTaskId: null, fillTurnId: null, fillTurnSessionId: null, fillTurnUserId: null,
      startedAt: null, completedAt: null }]) },
    agentArtifactVersion: { findMany: vi.fn(async () => [{ taskId: writerTaskId, artifactId: "artifact-1", version: 1,
      contentHash: artifactHash, sourceDigest: digest, content: "draft" }]) },
    agentArtifact: { findMany: vi.fn(async () => [{ id: "artifact-1", version: options.headVersion ?? 1, hash: artifactHash,
      content: { ...pointer, version: options.headVersion ?? 1 } }]) },
    agentArtifactReview: { findMany: vi.fn(async () => [{ artifactId: "artifact-1", status: "passed", currentSourceDigest: digest }]) },
    $queryRawUnsafe: vi.fn(async () => []),
  }
  const database = { $transaction: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback(tx)) } as unknown as PrismaClient
  return { database, tx, approvalSetId: setId("session-1", "review-turn") }
}
