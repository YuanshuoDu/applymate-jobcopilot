import { describe, expect, it, vi } from "vitest"
import { SELECTED_JOB_BATCH_TEMPLATE_CATALOG } from "@jobcopilot/agent-protocol"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

const graphMocks = vi.hoisted(() => ({
  hasPersistedTaskGraphMembership: vi.fn(),
  loadTaskGraph: vi.fn(),
}))
vi.mock("./task-graph-pg-state.js", () => graphMocks)

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
      dependencyKey: "review", dependencyTaskId: "reviewer-1", role: "reviewer", taskStatus: "completed",
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

describe("private Writer review feedback handoff", () => {
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

  it.each(SELECTED_JOB_BATCH_TEMPLATE_CATALOG.map(entry => entry.writerTemplateId))(
    "allows exact initial batch Writer template %s without dependency evidence", async templateId => {
      const context = { selectedJobPreparation: { jobId: scope.jobId } }
      const fixture = writerFixture(templateId, [], context)
      const dependency = writerReviewDependencyFromTaskContext(context, scope.jobId)

      expect(dependency).toBeNull()
      await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency)).resolves.toBeUndefined()
      expect(fixture.queries).toContain("COMMIT")
    },
  )

  it.each([
    ["non-catalog near match", "cover_letter_writer_slot_5", [], { selectedJobPreparation: { jobId: scope.jobId } }, null],
    ["prefixed catalog lookalike", "cover_letter_writer_slot_1_shadow", [], { selectedJobPreparation: { jobId: scope.jobId } }, null],
    ["Reviewer counterpart", SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].reviewerTemplateId, [], { selectedJobPreparation: { jobId: scope.jobId } }, null],
    ["dependency edge", SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, ["analyst-node"], { selectedJobPreparation: { jobId: scope.jobId } }, null],
    ["dependency result context", SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, [], dependencyContext("needs_revision", {
      taskGraphDependencyResults: { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [] },
    }), null],
    ["dependency object", SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, [], { selectedJobPreparation: { jobId: scope.jobId } }, {
      dependencyTaskId: "reviewer-1", artifactRef, reviewHash,
    }],
  ] as const)("rejects initial batch Writer with %s", async (_label, templateId, edges, context, suppliedDependency) => {
    const fixture = writerFixture(templateId, [...edges], context)
    const dependency = suppliedDependency ?? writerReviewDependencyFromTaskContext(context, scope.jobId)

    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, dependency))
      .rejects.toMatchObject({ code: "writer_review_dependency_invalid" })
    expect(fixture.queries).toContain("ROLLBACK")
  })

  it.each(["graph writer", "task record", "lease"] as const)("keeps initial batch Writer %s running", async target => {
    const context = { selectedJobPreparation: { jobId: scope.jobId } }
    const fixture = writerFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, [], context)
    if (target === "graph writer") fixture.graph.tasks.get(fixture.task.id)!.status = "queued"
    if (target === "task record") fixture.task.status = "queued"
    if (target === "lease") fixture.lease.status = "queued"

    await expect(assertPersistedWriterReviewDependency(fixture.pool as never, fixture.task, fixture.lease, null))
      .rejects.toMatchObject({ code: "writer_review_receipt_unavailable" })
    expect(fixture.queries).toContain("ROLLBACK")
  })

  it.each(["task identity", "task role", "lease role"] as const)("keeps initial batch Writer %s owner-fenced", async target => {
    const context = { selectedJobPreparation: { jobId: scope.jobId } }
    const fixture = writerFixture(SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0].writerTemplateId, [], context)
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
      dependencyTaskId: "reviewer-1", artifactRef, reviewHash,
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
