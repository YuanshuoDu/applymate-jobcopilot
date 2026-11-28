import { describe, expect, it, vi } from "vitest"
import { SELECTED_JOB_BATCH_TEMPLATE_CATALOG } from "@jobcopilot/agent-protocol"
import { makeObjectiveTailorWaveCandidateSelection, bindObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys } from "./objective-tailor-correction-proof.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

const graphMocks = vi.hoisted(() => ({
  hasPersistedTaskGraphMembership: vi.fn(),
  loadTaskGraph: vi.fn(),
}))
const inventoryMock = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => graphMocks)
vi.mock("./objective-tailor-wave-inventory.js", () => ({ readObjectiveTailorWaveInventory: inventoryMock.read }))

import {
  assertPersistedWriterReviewDependency, TaskGraphWriterReviewFeedbackError, writerReviewDependencyFromTaskContext,
} from "./task-graph-writer-review-feedback.js"

const artifactRef = {
  artifactId: "cover-letter:job-1", version: 3,
  contentHash: "sha256:" + "a".repeat(64), sourceDigest: "sha256:" + "b".repeat(64),
}
const reviewHash = "sha256:" + "c".repeat(64)
const scope = { userId: "user-1", sessionId: "session-1", jobId: "job-1" }
const dependencyContext = (reviewStatus = "needs_revision", overrides: Record<string, unknown> = {}) => ({
  selectedJobPreparation: { jobId: scope.jobId },
  taskGraphDependencyResults: {
    schemaVersion: "agent-harness.v2.task-graph.dependency-evidence",
    items: [{
      dependencyKey: "reviewer-node", dependencyTaskId: "reviewer-1", role: "reviewer", taskStatus: "completed",
      result: {
        schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "reviewer", status: "completed", artifactRef, reviewStatus, reviewHash,
      },
    }],
  },
  ...overrides,
})

function writerFixture(templateId: string, dependsOn: string[], context: unknown) {
  const task = {
    id: "writer-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    role: "writer", taskType: "cover_letter_draft", status: "running", leaseOwner: "worker-1", attemptCount: 1, interruptRequestedAt: null, context,
  } as unknown as SubagentTaskRecord
  const lease = { ...task, ownerId: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00Z"), signal: new AbortController().signal } as SubagentLease
  const nativeDelegation = templateId === "native" ? {
    schemaVersion: "agent-harness.v2.task-graph.native-delegation.v1", operationKind: "spawn",
    operationId: "native-writer-operation", requestFingerprint: "d".repeat(64), callerTaskId: "root-1",
    role: "writer", taskType: task.taskType, contextDigest: "e".repeat(64), contextBytes: 0,
  } : undefined
  const graph = {
    rootTaskId: "root-1",
    snapshot: { nodes: [
      { key: "writer-node", taskId: task.id, templateId, dependsOn, ...(nativeDelegation ? { nativeDelegation } : {}) },
      { key: "analyst-node", taskId: "analyst-1", templateId: "analyst", dependsOn: [] },
      { key: "reviewer-node", taskId: "reviewer-1", templateId: "cover_letter_reviewer", dependsOn: [] },
    ] },
    tasks: new Map([
      [task.id, { id: task.id, role: "writer", status: "running", failureReason: null }],
      ["analyst-1", { id: "analyst-1", role: "analyst", status: "completed", failureReason: null }],
      ["reviewer-1", { id: "reviewer-1", role: "reviewer", status: "completed", failureReason: null }],
    ]),
  }
  graphMocks.loadTaskGraph.mockResolvedValue(graph)
  const queries: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql)
      const isWriterLeaseRead = sql.includes('FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session')
      return {
        rows: isWriterLeaseRead ? [{
          id: task.id, userId: task.userId, sessionId: task.sessionId, turnId: task.turnId,
          rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, status: task.status, role: task.role,
          leaseOwner: task.leaseOwner, attemptCount: task.attemptCount, interruptRequestedAt: null,
        }] : [],
        rowCount: isWriterLeaseRead ? 1 : 0,
      }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) }
  return { task, lease, pool, queries, client, graph }
}

type BatchFixtureOptions = Readonly<{ correction?: boolean; selectedSlots?: number; reviewerJobId?: string }>
function batchWriterFixture(templateId: string, dependsOn: string[], context: unknown, options: BatchFixtureOptions = {}) {
  const batchIndex = SELECTED_JOB_BATCH_TEMPLATE_CATALOG.findIndex(entry => entry.writerTemplateId === templateId)
  const selectedSlots = options.selectedSlots ?? Math.min(3, Math.max(2, batchIndex + 1))
  const jobId = "job-" + (batchIndex + 1)
  const task = {
    id: "writer-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    role: "writer", taskType: "cover_letter_draft", status: "running", leaseOwner: "worker-1", attemptCount: 1, interruptRequestedAt: null, context,
  } as unknown as SubagentTaskRecord
  const lease = { ...task, ownerId: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00Z"), signal: new AbortController().signal } as SubagentLease
  const nodes: Array<Record<string, unknown> & { key: string; taskId: string; templateId: string; dependsOn: string[] }> = []
  const taskRows = new Map<string, Record<string, unknown>>(), dbRows = new Map<string, Record<string, unknown>>()
  for (let index = 0; index < selectedSlots; index++) {
    const entry = SELECTED_JOB_BATCH_TEMPLATE_CATALOG[index]!, current = index === batchIndex, selectedJob = "job-" + (index + 1)
    if (options.correction && current) {
      nodes.push(
        { key: "initial-writer-node", taskId: "writer-initial", templateId: entry.writerTemplateId, dependsOn: [], verificationDisposition: "specialized" },
        { key: "reviewer-node", taskId: "reviewer-1", templateId: entry.reviewerTemplateId, dependsOn: ["initial-writer-node"], verificationDisposition: "specialized" },
        { key: "writer-node", taskId: task.id, templateId: entry.writerTemplateId, dependsOn, verificationDisposition: "specialized" },
        { key: "correction-reviewer-node", taskId: "reviewer-correction-1", templateId: entry.reviewerTemplateId, dependsOn: ["writer-node"], verificationDisposition: "specialized" },
      )
      taskRows.set("writer-initial", { id: "writer-initial", role: "writer", taskType: "cover_letter_draft", status: "completed", failureReason: null })
      taskRows.set("reviewer-correction-1", { id: "reviewer-correction-1", role: "reviewer", taskType: "cover_letter_review", status: "queued", failureReason: null })
      dbRows.set("reviewer-1", {
        id: "reviewer-1", context: { selectedJobPreparation: { jobId: options.reviewerJobId ?? selectedJob } },
        role: "reviewer", taskType: "cover_letter_review", status: "completed", failureReason: null,
      })
    } else {
      const writerKey = current ? "writer-node" : "writer-node-" + (index + 1)
      const writerId = current ? task.id : "other-writer-" + (index + 1)
      const reviewerKey = current ? "reviewer-node" : "reviewer-node-" + (index + 1)
      const reviewerId = current ? "reviewer-1" : "other-reviewer-" + (index + 1)
      nodes.push(
        { key: writerKey, taskId: writerId, templateId: entry.writerTemplateId, dependsOn: current ? dependsOn : [], verificationDisposition: "specialized" },
        { key: reviewerKey, taskId: reviewerId, templateId: entry.reviewerTemplateId, dependsOn: [writerKey], verificationDisposition: "specialized" },
      )
      dbRows.set(reviewerId, {
        id: reviewerId, context: { selectedJobPreparation: { jobId: current ? options.reviewerJobId ?? selectedJob : selectedJob } },
        role: "reviewer", taskType: "cover_letter_review", status: "completed", failureReason: null,
      })
    }
    taskRows.set(current ? task.id : "other-writer-" + (index + 1), {
      id: current ? task.id : "other-writer-" + (index + 1), role: "writer", taskType: "cover_letter_draft",
      status: current ? "running" : "completed", failureReason: null,
    })
    taskRows.set(current ? "reviewer-1" : "other-reviewer-" + (index + 1), {
      id: current ? "reviewer-1" : "other-reviewer-" + (index + 1), role: "reviewer", taskType: "cover_letter_review",
      status: "completed", failureReason: null,
    })
  }
  dbRows.set(task.id, {
    id: task.id, userId: task.userId, sessionId: task.sessionId, turnId: task.turnId,
    rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, status: task.status, role: task.role, taskType: task.taskType,
    leaseOwner: task.leaseOwner, attemptCount: task.attemptCount, interruptRequestedAt: null, context,
  })
  const graph = { rootTaskId: "root-1", discoveryTurnEligibility: "ordinary" as const, snapshot: { nodes }, tasks: taskRows }
  graphMocks.loadTaskGraph.mockResolvedValue(graph)
  const queries: string[] = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(sql)
      const writerRead = sql.includes('task."leaseOwner" = $7')
      const reviewerRead = sql.includes('SELECT task."id", task."context", task."role"')
      const id = reviewerRead ? String(values?.[0]) : task.id
      return { rows: (writerRead || reviewerRead) && dbRows.has(id) ? [dbRows.get(id)] : [],
        rowCount: writerRead || reviewerRead ? 1 : 0 }
    }),
    release: vi.fn(),
  }
  return { task, lease, pool: { connect: vi.fn(async () => client) }, queries, client, graph, dbRows, jobId }
}

function objectiveCorrectionFixture(contextOverride?: unknown) {
  const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479", sourceDigest = artifactRef.sourceDigest
  const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
  const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 1, sourceGraphDigest: "d".repeat(64),
    sourceStatusDigest: "e".repeat(64), analystProofDigest: "f".repeat(64), candidate: { jobId, score: 8, materialDigest: sourceDigest },
    sourceAnalystKey: "analyst-node" })!
  const witness = bindObjectiveTailorWaveCandidateWitness(selection, { slotId: "tailor-1", admittedRevision: 2 })!
  const correctionKeys = objectiveTailorCorrectionNodeKeys(witness.slotId)!
  const proof = bindObjectiveTailorCorrectionProof({ graphRevision: 2, slotId: witness.slotId, candidateWitness: witness,
    writerTaskId: "writer-initial", reviewerTaskId: "reviewer-1", artifactRef,
    artifactVersion: { artifactId: artifactRef.artifactId, artifactType: "cover_letter", taskId: "writer-initial", version: artifactRef.version,
      contentHash: artifactRef.contentHash, sourceDigest, previousHash: null },
    reviewReceipt: { jobId, artifactId: artifactRef.artifactId, version: artifactRef.version, contentHash: artifactRef.contentHash,
      sourceDigest, currentSourceDigest: sourceDigest, status: "needs_revision", taskId: "reviewer-1", toolCallId: "review-call", reviewHash } })!
  const context = contextOverride ?? { ...dependencyContext(), selectedJobPreparation: { jobId }, objectiveTailorCandidateMode: true,
    objectiveTailorCandidateWitness: witness, objectiveTailorCorrectionProof: proof,
    taskGraphDependencyResults: { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{
      dependencyKey: witness.reviewerNodeKey, dependencyTaskId: "reviewer-1", role: "reviewer", taskStatus: "completed",
      result: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "reviewer", status: "completed", artifactRef, reviewStatus: "needs_revision", reviewHash },
    }] } }
  const task = { id: "writer-1", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.parentTaskId, role: "writer", taskType: "cover_letter_draft", status: "running", leaseOwner: "worker-1",
    attemptCount: 1, interruptRequestedAt: null, context } as unknown as SubagentTaskRecord
  const lease = { ...task, ownerId: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00Z"), signal: new AbortController().signal } as SubagentLease
  const markerSlot = { slotId: witness.slotId, sourceAnalystNodeKey: "analyst-node", writerNodeKey: witness.writerNodeKey,
    reviewerNodeKey: witness.reviewerNodeKey, correction: correctionKeys }
  const nodes = [
    { key: "analyst-node", taskId: "analyst-1", templateId: "analyst", dependsOn: [] },
    { key: witness.writerNodeKey, taskId: "writer-initial", templateId: "cover_letter_writer", dependsOn: [] },
    { key: witness.reviewerNodeKey, taskId: "reviewer-1", templateId: "cover_letter_reviewer", dependsOn: [witness.writerNodeKey] },
    { key: correctionKeys.writerNodeKey, taskId: task.id, templateId: "cover_letter_writer", dependsOn: [witness.reviewerNodeKey] },
    { key: correctionKeys.reviewerNodeKey, taskId: "reviewer-correction", templateId: "cover_letter_reviewer", dependsOn: [correctionKeys.writerNodeKey] },
  ]
  const statuses = new Map(nodes.map(node => [node.taskId, node.taskId === task.id ? "running" : node.taskId === correctionKeys.reviewerNodeKey ? "queued" : "completed"]))
  const taskRows = new Map(nodes.map(node => [node.taskId, { id: node.taskId,
    role: node.templateId === "cover_letter_writer" ? "writer" : node.templateId === "cover_letter_reviewer" ? "reviewer" : "analyst",
    taskType: node.templateId === "cover_letter_writer" ? "cover_letter_draft" : node.templateId === "cover_letter_reviewer" ? "cover_letter_review" : "job_analysis",
    status: statuses.get(node.taskId), failureReason: null }]))
  const graph = { rootTaskId: scope.rootTaskId, discoveryTurnEligibility: "ordinary" as const,
    item: { revision: 3 }, snapshot: { nodes, objectiveTailor: { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2, slots: [markerSlot] } },
    state: { revision: 3, nodes: nodes.map(node => ({ key: node.key, taskId: node.taskId, status: statuses.get(node.taskId) })),
      objectiveTailor: { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2, slots: [markerSlot] } }, tasks: taskRows }
  graphMocks.loadTaskGraph.mockResolvedValue(graph)
  inventoryMock.read.mockResolvedValue({ marker: graph.snapshot.objectiveTailor, occupiedSlots: [{ slotId: witness.slotId, witness,
    jobId, sourceAnalystNodeKey: "analyst-node", writerTaskId: "writer-initial", reviewerTaskId: "reviewer-1",
    correction: { proof, writerTaskId: task.id, reviewerTaskId: "reviewer-correction" } }] })
  const queries: string[] = []
  const client = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: sql.includes('FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session')
    ? [{ id: task.id, userId: task.userId, sessionId: task.sessionId, turnId: task.turnId, rootTaskId: task.rootTaskId,
      parentTaskId: task.parentTaskId, status: task.status, role: task.role, leaseOwner: task.leaseOwner,
      attemptCount: task.attemptCount, interruptRequestedAt: null, context }] : [], rowCount: 1 } }), release: vi.fn() }
  return { task, lease, graph, client, queries, pool: { connect: vi.fn(async () => client) }, context, proof }
}
describe("private Writer review feedback handoff", () => {
  it("admits a correction Writer only from its exact persisted slot and original needs-revision Reviewer", async () => {
    const fixture = objectiveCorrectionFixture(), dependency = writerReviewDependencyFromTaskContext(fixture.context, "f47ac10b-58cc-4372-a567-0e02b2c3d479")
    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency)).resolves.toBeUndefined()
    expect(inventoryMock.read).toHaveBeenCalledWith(fixture.client, expect.objectContaining({ userId: scope.userId }), fixture.graph)
    expect(fixture.queries).toContain("COMMIT")
  })

  it("rejects a correction Writer when its persisted dependency context changed after lease read", async () => {
    const fixture = objectiveCorrectionFixture(), dependency = writerReviewDependencyFromTaskContext(fixture.context, "f47ac10b-58cc-4372-a567-0e02b2c3d479")
    fixture.lease.context = { ...fixture.context as object, taskGraphDependencyResults: { schemaVersion: "bad", items: [] } }
    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency))
      .rejects.toMatchObject({ code: "writer_review_receipt_unavailable" })
    expect(fixture.queries).toContain("ROLLBACK")
  })

  it("rejects a correction dependency that changes the prior immutable artifact identity", async () => {
    const fixture = objectiveCorrectionFixture(), dependency = writerReviewDependencyFromTaskContext(fixture.context, "f47ac10b-58cc-4372-a567-0e02b2c3d479")!
    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease,
      { ...dependency, artifactRef: { ...dependency.artifactRef, version: dependency.artifactRef.version + 1 } }))
      .rejects.toMatchObject({ code: "writer_review_dependency_invalid" })
    expect(fixture.queries).toContain("ROLLBACK")
  })

  it("allows a native selected-job Writer first draft with no Reviewer feedback dependency", async () => {
    const context = {
      selectedJobPreparation: { jobId: scope.jobId },
      taskGraphDependencyResults: {
        schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{ role: "analyst" }],
      },
    }
    const fixture = writerFixture("native", [], context)
    const dependency = writerReviewDependencyFromTaskContext(context, scope.jobId)
    const feedbackRead = vi.fn()
    const modelCall = vi.fn()

    expect(dependency).toBeNull()
    await assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency)
    if (dependency) feedbackRead()
    modelCall()

    expect(fixture.queries).toContain("COMMIT")
    expect(feedbackRead).not.toHaveBeenCalled()
    expect(modelCall).toHaveBeenCalledOnce()
  })

  it("allows a registered selected-job Writer first draft with no Reviewer feedback dependency", async () => {
    const context = {
      selectedJobPreparation: { jobId: scope.jobId },
      taskGraphDependencyResults: {
        schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{ role: "analyst" }],
      },
    }
    const fixture = writerFixture("cover_letter_writer", ["analyst-node"], context)
    const dependency = writerReviewDependencyFromTaskContext(context, scope.jobId)
    const feedbackRead = vi.fn()
    const modelCall = vi.fn()

    expect(dependency).toBeNull()
    await assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency)
    if (dependency) feedbackRead()
    modelCall()

    expect(fixture.queries).toContain("COMMIT")
    expect(feedbackRead).not.toHaveBeenCalled()
    expect(modelCall).toHaveBeenCalledOnce()
  })

  it.each(SELECTED_JOB_BATCH_TEMPLATE_CATALOG.slice(0, 3))(
    "allows initial batch Writer template $writerTemplateId within the verified shortlist", async entry => {
      const index = SELECTED_JOB_BATCH_TEMPLATE_CATALOG.indexOf(entry), jobId = "job-" + (index + 1)
      const context = { selectedJobPreparation: { jobId } }
      const fixture = batchWriterFixture(entry.writerTemplateId, [], context, { selectedSlots: Math.max(2, index + 1) })
      const dependency = writerReviewDependencyFromTaskContext(context, jobId)
      expect(dependency).toBeNull()
      await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency)).resolves.toBeUndefined()
      expect(fixture.queries).toContain("COMMIT")
    },
  )

  it("denies catalog slot four outside the verified three-Job shortlist", async () => {
    const templateId = SELECTED_JOB_BATCH_TEMPLATE_CATALOG[3]!.writerTemplateId
    const context = { selectedJobPreparation: { jobId: "job-4" } }
    const fixture = batchWriterFixture(templateId, [], context, { selectedSlots: 4 })
    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, null))
      .rejects.toMatchObject({ code: "writer_review_dependency_invalid" })
  })

  it.each(["bad job id", "x".repeat(81)])("rejects a batch Writer with malformed selected Job id %s", async jobId => {
    const context = { selectedJobPreparation: { jobId } }
    const fixture = batchWriterFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0]!.writerTemplateId, [], context)
    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, null))
      .rejects.toMatchObject({ code: "writer_review_dependency_invalid" })
  })

  it("allows a correction Writer only from its exact same-slot completed needs-revision Reviewer", async () => {
    const context = dependencyContext()
    const fixture = batchWriterFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0]!.writerTemplateId, ["reviewer-node"], context, { correction: true })
    const dependency = writerReviewDependencyFromTaskContext(context, scope.jobId)
    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency)).resolves.toBeUndefined()
    expect(fixture.queries).toContain("COMMIT")
    expect(fixture.queries.some(sql => sql.includes('task."leaseOwner" = $7'))).toBe(true)
    expect(fixture.queries.some(sql => sql.includes('SELECT task."id", task."context", task."role"'))).toBe(true)
  })

  it("rejects a correction edge that points to another Job slot", async () => {
    const context = dependencyContext()
    const fixture = batchWriterFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0]!.writerTemplateId, ["reviewer-node"], context, { correction: true })
    fixture.graph.snapshot.nodes.find(node => node.taskId === fixture.task.id)!.dependsOn[0] = "reviewer-node-2"
    const dependency = writerReviewDependencyFromTaskContext(context, scope.jobId)
    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency))
      .rejects.toMatchObject({ code: "writer_review_dependency_invalid" })
  })

  it.each(["wrong Reviewer Job", "changed persisted artifact reference", "changed persisted source digest"] as const)(
    "rejects a correction with %s", async variant => {
      const context = dependencyContext()
      const fixture = batchWriterFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0]!.writerTemplateId, ["reviewer-node"], context, { correction: true })
      if (variant === "wrong Reviewer Job") fixture.dbRows.get("reviewer-1")!.context = { selectedJobPreparation: { jobId: "job-2" } }
      else fixture.dbRows.get(fixture.task.id)!.context = dependencyContext("needs_revision", {
        taskGraphDependencyResults: {
          schemaVersion: "agent-harness.v2.task-graph.dependency-evidence",
          items: [{ ...dependencyContext().taskGraphDependencyResults.items[0], result: {
            ...dependencyContext().taskGraphDependencyResults.items[0]?.result,
            artifactRef: variant === "changed persisted source digest"
              ? { ...artifactRef, sourceDigest: `sha256:${"a".repeat(64)}` }
              : { ...artifactRef, version: 4 },
          } }],
        },
      })
      const dependency = writerReviewDependencyFromTaskContext(context, scope.jobId)
      await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency))
        .rejects.toMatchObject({ code: "writer_review_receipt_unavailable" })
      expect(fixture.queries).toContain("ROLLBACK")
    },
  )

  it("does not let a correction fall back to an initial Writer without its dependency", async () => {
    const fixture = batchWriterFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0]!.writerTemplateId, ["reviewer-node"],
      { selectedJobPreparation: { jobId: scope.jobId } }, { correction: true })
    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, null))
      .rejects.toMatchObject({ code: "writer_review_dependency_invalid" })
  })

  it.each([
    ["non-catalog near match", "cover_letter_writer_slot_5", [], { selectedJobPreparation: { jobId: scope.jobId } }, null],
    ["prefixed catalog lookalike", "cover_letter_writer_slot_1_shadow", [], { selectedJobPreparation: { jobId: scope.jobId } }, null],
    ["Reviewer counterpart", SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].reviewerTemplateId, [], { selectedJobPreparation: { jobId: scope.jobId } }, null],
    ["dependency edge", SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, ["analyst-node"], { selectedJobPreparation: { jobId: scope.jobId } }, null],
    ["dependency result context", SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, [], dependencyContext("needs_revision", {
      taskGraphDependencyResults: { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [] },
    }), null],
    ["dependency object", SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, [], { selectedJobPreparation: { jobId: scope.jobId } }, {
      dependencyKey: "reviewer-node", dependencyTaskId: "reviewer-1", artifactRef, reviewHash,
    }],
  ] as const)("rejects initial batch Writer with %s", async (_label, templateId, edges, context, suppliedDependency) => {
    const fixture = batchWriterFixture(templateId, [...edges], context)
    const dependency = suppliedDependency ?? writerReviewDependencyFromTaskContext(context, scope.jobId)

    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency))
      .rejects.toMatchObject({ code: "writer_review_dependency_invalid" })
    expect(fixture.queries).toContain("ROLLBACK")
  })

  it.each(["graph writer", "task record", "lease"] as const)("keeps initial batch Writer %s running", async target => {
    const context = { selectedJobPreparation: { jobId: scope.jobId } }
    const fixture = batchWriterFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, [], context)
    if (target === "graph writer") fixture.graph.tasks.get(fixture.task.id)!.status = "queued"
    if (target === "task record") fixture.task.status = "queued"
    if (target === "lease") fixture.lease.status = "queued"

    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, null))
      .rejects.toMatchObject({ code: "writer_review_receipt_unavailable" })
    expect(fixture.queries).toContain("ROLLBACK")
  })

  it.each(["task identity", "task role", "lease role"] as const)("keeps initial batch Writer %s owner-fenced", async target => {
    const context = { selectedJobPreparation: { jobId: scope.jobId } }
    const fixture = batchWriterFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, [], context)
    if (target === "task identity") fixture.task.id = "other-writer"
    if (target === "task role") fixture.task.role = "analyst"
    if (target === "lease role") fixture.lease.role = "analyst"

    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, null))
      .rejects.toMatchObject({ code: "writer_review_receipt_unavailable" })
    expect(fixture.pool.connect).not.toHaveBeenCalled()
  })

  it("rejects caller-forged Reviewer context before feedback or model calls without a persisted edge", async () => {
    const context = dependencyContext()
    const fixture = writerFixture("native", [], context)
    const dependency = writerReviewDependencyFromTaskContext(context, scope.jobId)
    const feedbackRead = vi.fn()
    const modelCall = vi.fn()
    const runWriter = async () => {
      await assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency)
      feedbackRead()
      modelCall()
    }

    await expect(runWriter()).rejects.toMatchObject({ code: "writer_review_dependency_invalid" })
    expect(fixture.queries).toContain("ROLLBACK")
    expect(feedbackRead).not.toHaveBeenCalled()
    expect(modelCall).not.toHaveBeenCalled()
  })

  it("allows feedback and model access for one persisted direct Reviewer edge assigned to the Writer", async () => {
    const context = dependencyContext()
    const fixture = writerFixture("cover_letter_writer", ["reviewer-node"], context)
    const dependency = writerReviewDependencyFromTaskContext(context, scope.jobId)
    const feedbackRead = vi.fn()
    const modelCall = vi.fn()
    const runWriter = async () => {
      await assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency)
      feedbackRead()
      modelCall()
    }

    await expect(runWriter()).resolves.toBeUndefined()
    expect(fixture.queries).toContain("COMMIT")
    expect(feedbackRead).toHaveBeenCalledOnce()
    expect(modelCall).toHaveBeenCalledOnce()
  })

  it("accepts one exact direct completed Reviewer receipt at the context parser", () => {
    expect(writerReviewDependencyFromTaskContext({ selectedJobPreparation: { jobId: scope.jobId } }, scope.jobId)).toBeNull()
    expect(writerReviewDependencyFromTaskContext(dependencyContext(), scope.jobId)).toEqual({
      dependencyKey: "reviewer-node", dependencyTaskId: "reviewer-1", artifactRef, reviewHash,
    })
  })

  it.each([
    ["wrong selected job", dependencyContext("needs_revision", { selectedJobPreparation: { jobId: "job-2" } })],
    ["passed receipt", dependencyContext("passed")],
    ["rejected receipt", dependencyContext("rejected")],
    ["missing task id", dependencyContext("needs_revision", { taskGraphDependencyResults: { ...dependencyContext().taskGraphDependencyResults, items: [{ ...dependencyContext().taskGraphDependencyResults.items[0], dependencyTaskId: undefined }] } })],
    ["duplicate reviewers", dependencyContext("needs_revision", { taskGraphDependencyResults: { ...dependencyContext().taskGraphDependencyResults, items: [...dependencyContext().taskGraphDependencyResults.items, ...dependencyContext().taskGraphDependencyResults.items] } })],
    ["malformed projection", dependencyContext("needs_revision", { taskGraphDependencyResults: { schemaVersion: "bad", items: [] } })],
  ] as const)("fails closed for %s", (_label, value) => {
    expect(() => writerReviewDependencyFromTaskContext(value, scope.jobId)).toThrow(TaskGraphWriterReviewFeedbackError)
  })

})
