import { describe, expect, it, vi } from "vitest"
import {
  verifySelectedJobBatchCompletion,
  type SelectedJobBatchTaskContext,
  type VerifySelectedJobBatchCompletionInput,
} from "./multi-selected-job-completion-gate.js"
import {
  TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
  type TaskGraphCurrentNode,
  type TaskGraphCurrentState,
} from "./subagents/task-graph-command-port.js"
import type { SelectedJobBatchPair } from "./subagents/selected-job-batch-plan.js"
import type { TurnLease } from "./turns/lease.js"

const lease: TurnLease = {
  turnId: "turn-batch", sessionId: "session-batch", ownerId: "worker", userId: "user",
  leaseVersion: 2, leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000),
}
const root = { id: "root-batch", attemptCount: 1 }
const pairs: readonly SelectedJobBatchPair[] = [
  { slotId: "slot-1", jobId: "job-a", writerTemplateId: "cover_letter_writer_slot_1", writerNodeKey: "writer-a", reviewerTemplateId: "cover_letter_reviewer_slot_1", reviewerNodeKey: "reviewer-a" },
  { slotId: "slot-2", jobId: "job-b", writerTemplateId: "cover_letter_writer_slot_2", writerNodeKey: "writer-b", reviewerTemplateId: "cover_letter_reviewer_slot_2", reviewerNodeKey: "reviewer-b" },
]
type TestReference = Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
const references: Readonly<Record<string, TestReference>> = {
  "job-a": { artifactId: "draft-a", version: 3, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` },
  "job-b": { artifactId: "draft-b", version: 2, contentHash: `sha256:${"c".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}` },
}
const correctionReferences: Readonly<Record<string, TestReference>> = {
  "job-a": { artifactId: "draft-a", version: 4, contentHash: `sha256:${"9".repeat(64)}`, sourceDigest: references["job-a"].sourceDigest },
  "job-b": { artifactId: "draft-b", version: 3, contentHash: `sha256:${"8".repeat(64)}`, sourceDigest: references["job-b"].sourceDigest },
}

function graph(options: Readonly<{
  statuses?: Readonly<Record<string, TaskGraphCurrentNode["status"]>>
  writerRefs?: Readonly<Record<string, TestReference>>
  reviewStatuses?: Readonly<Record<string, "passed" | "needs_revision" | "rejected">>
  dependencies?: Readonly<Record<string, readonly string[]>>
  corrections?: readonly string[]
}> = {}): TaskGraphCurrentState {
  const nodes = pairs.flatMap(pair => {
    const writerStatus = options.statuses?.[pair.writerNodeKey] ?? "completed"
    const reviewerStatus = options.statuses?.[pair.reviewerNodeKey] ?? "completed"
    const writerRef = options.writerRefs?.[pair.jobId] ?? references[pair.jobId]
    const reviewRef = writerRef
    const correction = options.corrections?.includes(pair.jobId) ?? false
    const initialReview = node(pair.reviewerNodeKey, pair.reviewerTemplateId, reviewerStatus,
      options.dependencies?.[pair.reviewerNodeKey] ?? [pair.writerNodeKey], reviewRef, "reviewer",
      options.reviewStatuses?.[pair.jobId] ?? (correction ? "needs_revision" : "passed"))
    const result = [node(pair.writerNodeKey, pair.writerTemplateId, writerStatus, [], writerRef, "writer"), initialReview]
    if (correction) {
      const correctionWriterKey = `${pair.writerNodeKey}-correction`, correctionReviewerKey = `${pair.reviewerNodeKey}-correction`
      const correctionRef = correctionReferences[pair.jobId]
      result.push(node(correctionWriterKey, pair.writerTemplateId, options.statuses?.[correctionWriterKey] ?? "completed",
        [pair.reviewerNodeKey], correctionRef, "writer"))
      result.push(node(correctionReviewerKey, pair.reviewerTemplateId, options.statuses?.[correctionReviewerKey] ?? "completed",
        [correctionWriterKey], correctionRef, "reviewer", options.reviewStatuses?.[`${pair.jobId}-correction`] ?? "passed"))
    }
    return result
  })
  return { revision: 7, nodes }
}

function node(
  key: string, templateId: string, status: TaskGraphCurrentNode["status"], dependsOn: readonly string[], artifactRef: typeof references["job-a"],
  role: "writer" | "reviewer", reviewStatus: "passed" | "needs_revision" | "rejected" = "passed",
): TaskGraphCurrentNode {
  const resultProjection = status !== "completed" ? undefined : role === "writer"
    ? { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const, role, status, artifactRef }
    : { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const, role, status, artifactRef, reviewStatus, reviewHash: `sha256:${key === "reviewer-a" ? "e" : "f"}`.padEnd(71, "0") }
  return {
    key, templateId, status, goal: "Prepare selected job", successCriteria: ["Review material"], dependsOn,
    taskId: `${key}-task`, readiness: "terminal", resultSummary: null, failureReason: null,
    ...(resultProjection ? { resultProjection } : {}),
  }
}

function contexts(state = graph(), options: { crossedJob?: boolean; wrongCorrectionReview?: boolean } = {}): SelectedJobBatchTaskContext[] {
  return state.nodes.map(current => {
    const pair = pairs.find(value => current.templateId.includes(value.slotId.replace("-", "_")))!
    const dependency = current.dependsOn[0] ? state.nodes.find(value => value.key === current.dependsOn[0]) : undefined
    const selectedJobId = options.crossedJob && current.key === "reviewer-b" ? "job-a" : pair.jobId
    let context: Record<string, unknown> = { selectedJobPreparation: { jobId: selectedJobId } }
    if (current.templateId.includes("writer") && current.key.endsWith("-correction") && dependency?.resultProjection) {
      const result = options.wrongCorrectionReview ? { ...dependency.resultProjection, reviewHash: `sha256:${"e".repeat(64)}` } : dependency.resultProjection
      context = { ...context, taskGraphDependencyResults: dependencyEvidence(dependency, result) }
    } else if (current.templateId.includes("reviewer") && dependency?.resultProjection) {
      context = { ...context, taskGraphDependencyResults: dependencyEvidence(dependency, dependency.resultProjection) }
    }
    return { taskId: current.taskId!, role: current.templateId.includes("writer") ? "writer" : "reviewer", context }
  })
}

function dependencyEvidence(node: TaskGraphCurrentNode, result: unknown) {
  return { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{ dependencyKey: node.key,
    ...(node.templateId.includes("reviewer") ? { dependencyTaskId: node.taskId } : {}),
    role: node.templateId.includes("writer") ? "writer" : "reviewer", taskStatus: "completed", result }] }
}

function input(overrides: Partial<VerifySelectedJobBatchCompletionInput> = {}): VerifySelectedJobBatchCompletionInput {
  const currentGraph = overrides.graph ?? graph()
  return {
    graph: currentGraph, pairs, taskContexts: overrides.taskContexts ?? contexts(currentGraph), lease, root,
    readCurrentDraftHead: vi.fn(async scope => {
      const pair = pairs.find(value => value.jobId === scope.jobId)
      const correctionKey = pair && `${pair.writerNodeKey}-correction`
      const reference = correctionKey && currentGraph.nodes.some(node => node.key === correctionKey)
        ? correctionReferences[scope.jobId] : references[scope.jobId]
      return reference ? { ...reference, artifactId: scope.artifactId } : null
    }),
    readArtifactVersion: vi.fn(async scope => {
      const correction = scope.taskId.includes("correction")
      const reference = correction ? correctionReferences[scope.jobId] : references[scope.jobId]
      return reference ? { ...reference, artifactType: "cover_letter" as const, taskId: scope.taskId,
        previousHash: correction ? references[scope.jobId]?.contentHash ?? null : null } : null
    }),
    readCurrentSourceDigest: vi.fn(async jobId => references[jobId]?.sourceDigest ?? null),
    readCurrentReviewReceipt: vi.fn(async scope => ({ ...scope, toolCallId: `review-${scope.jobId}` })),
    ...overrides,
  }
}

describe("multi-selected-job completion evidence gate", () => {
  it("verifies disjoint Job evidence and keeps the original finite slot graph in its witness", async () => {
    const args = input()
    const result = await verifySelectedJobBatchCompletion(args)

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.outcomes.map(value => [value.slotId, value.jobId, value.status])).toEqual([
      ["slot-1", "job-a", "completed"], ["slot-2", "job-b", "completed"],
    ])
    expect(result.outcomes[0]).toMatchObject({
      writerTaskId: "writer-a-task", reviewerTaskId: "reviewer-a-task",
      evidence: { artifactRef: references["job-a"], reviewReceipt: { taskId: "reviewer-a-task", status: "passed" } },
    })
    expect(result.witness.graph.nodes.map(value => value.templateId)).toEqual(pairs.flatMap(pair => [pair.writerTemplateId, pair.reviewerTemplateId]))
    expect(args.readCurrentSourceDigest).toHaveBeenCalledTimes(6)
    expect(args.readCurrentReviewReceipt).toHaveBeenCalledTimes(2)
  })

  it("blocks borrowed artifact evidence for one Job without erasing the other Job's valid result", async () => {
    const result = await verifySelectedJobBatchCompletion(input({ graph: graph({ writerRefs: { "job-b": references["job-a"] } }) }))

    expect(result.status).toBe("blocked")
    expect(result.outcomes.map(value => [value.jobId, value.status])).toEqual([["job-a", "completed"], ["job-b", "invalid"]])
  })

  it("keeps ordinary mixed progress pending and reports a settled branch failure separately", async () => {
    const inProgress = graph({ statuses: { "writer-a": "failed", "reviewer-a": "queued" } })
    const pending = await verifySelectedJobBatchCompletion(input({ graph: inProgress, taskContexts: contexts(inProgress) }))
    expect(pending.status).toBe("pending")
    expect(pending.outcomes.map(value => [value.jobId, value.status])).toEqual([["job-a", "pending"], ["job-b", "completed"]])

    const settled = graph({ statuses: { "writer-a": "failed", "reviewer-a": "cancelled" } })
    const partial = await verifySelectedJobBatchCompletion(input({ graph: settled, taskContexts: contexts(settled) }))
    expect(partial.status).toBe("ready")
    expect(partial.outcomes.map(value => [value.jobId, value.status])).toEqual([["job-a", "failed"], ["job-b", "completed"]])
  })

  it("does not turn a rejected Reviewer receipt into a passed result", async () => {
    const result = await verifySelectedJobBatchCompletion(input({ graph: graph({ reviewStatuses: { "job-a": "rejected" } }) }))

    expect(result.status).toBe("ready")
    expect(result.outcomes[0]).toMatchObject({ status: "completed", evidence: { reviewReceipt: { status: "rejected" } } })
  })

  it("blocks cross-slot dependencies, context mismatches, and a changed finalization witness", async () => {
    const crossed = await verifySelectedJobBatchCompletion(input({ graph: graph({ dependencies: { "reviewer-b": ["writer-a"] } }) }))
    expect(crossed.status).toBe("blocked")

    const taskContexts = contexts()
    taskContexts[3] = { ...taskContexts[3]!, context: { selectedJobPreparation: { jobId: "job-a" } } }
    const changedContext = await verifySelectedJobBatchCompletion(input({ taskContexts }))
    expect(changedContext.status).toBe("blocked")

    const first = await verifySelectedJobBatchCompletion(input())
    if (first.status !== "ready") throw new Error("test setup did not verify batch")
    const changedGraph = { ...graph(), revision: graph().revision + 1 }
    const recheck = await verifySelectedJobBatchCompletion(input({ graph: changedGraph, expectedWitness: first.witness }))
    expect(recheck.status).toBe("blocked")
    expect(recheck.outcomes.every(value => value.status === "completed")).toBe(true)
  })

  it("uses the latest correction pair while retaining the exact initial Reviewer evidence", async () => {
    const corrected = graph({ corrections: ["job-a"] })
    const args = input({ graph: corrected, taskContexts: contexts(corrected) })
    const result = await verifySelectedJobBatchCompletion(args)

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.outcomes[0]).toMatchObject({ status: "completed", writerTaskId: "writer-a-correction-task",
      reviewerTaskId: "reviewer-a-correction-task", evidence: { artifactRef: correctionReferences["job-a"] },
      priorEvidence: { writerTaskId: "writer-a-task", reviewerTaskId: "reviewer-a-task", artifactRef: references["job-a"],
        reviewStatus: "needs_revision", reviewReceipt: { status: "needs_revision", taskId: "reviewer-a-task" } } })
    expect(result.witness.graph.nodes).toHaveLength(6)
    expect(args.readArtifactVersion).toHaveBeenCalledWith({ userId: lease.userId, sessionId: lease.sessionId, jobId: "job-a",
      artifactId: references["job-a"].artifactId, taskId: "writer-a-task", version: references["job-a"].version })
    expect(args.readArtifactVersion).toHaveBeenCalledWith({ userId: lease.userId, sessionId: lease.sessionId, jobId: "job-a",
      artifactId: correctionReferences["job-a"].artifactId, taskId: "writer-a-correction-task", version: correctionReferences["job-a"].version })
  })

  it.each([
    ["prior review passed", graph({ corrections: ["job-a"], reviewStatuses: { "job-a": "passed" } }), false],
    ["feedback hash changed", graph({ corrections: ["job-a"] }), true],
    ["new version skipped", graph({ corrections: ["job-a"] }), false],
  ])("blocks a correction with %s", async (_label, value, wrongFeedback) => {
    const taskContexts = contexts(value, { wrongCorrectionReview: wrongFeedback })
    const readArtifactVersion = vi.fn(async scope => {
      const row = scope.taskId.includes("correction") ? { ...correctionReferences[scope.jobId], artifactType: "cover_letter" as const,
        taskId: scope.taskId, previousHash: references[scope.jobId]?.contentHash ?? null } : {
        ...references[scope.jobId], artifactType: "cover_letter" as const, taskId: scope.taskId, previousHash: null,
      }
      return _label === "new version skipped" && scope.taskId.includes("correction") ? { ...row, version: row.version + 1 } : row
    })
    const result = await verifySelectedJobBatchCompletion(input({ graph: value, taskContexts, readArtifactVersion }))
    expect(result.status).toBe("blocked")
    expect(result.outcomes[0]?.status).toBe("invalid")
  })

  it("keeps a failed or pending correction explicit instead of falling back to the initial pair", async () => {
    const pendingGraph = graph({ corrections: ["job-a"], statuses: { "reviewer-a-correction": "queued" } })
    const pending = await verifySelectedJobBatchCompletion(input({ graph: pendingGraph, taskContexts: contexts(pendingGraph) }))
    expect(pending.status).toBe("pending")
    expect(pending.outcomes[0]).toMatchObject({ status: "pending", writerTaskId: "writer-a-correction-task", reviewerTaskId: "reviewer-a-correction-task" })

    const failedGraph = graph({ corrections: ["job-a"], statuses: { "reviewer-a-correction": "failed" } })
    const failed = await verifySelectedJobBatchCompletion(input({ graph: failedGraph, taskContexts: contexts(failedGraph) }))
    expect(failed.status).toBe("ready")
    expect(failed.outcomes[0]).toMatchObject({ status: "failed", writerTaskId: "writer-a-correction-task", reviewerTaskId: "reviewer-a-correction-task",
      priorEvidence: { reviewerTaskId: "reviewer-a-task" } })
  })

  it("keeps a successful sibling visible when a transaction-bound evidence read is lost", async () => {
    const args = input({ readCurrentDraftHead: vi.fn(async scope => scope.jobId === "job-b"
      ? null : { ...references["job-a"], artifactId: scope.artifactId }) })
    const result = await verifySelectedJobBatchCompletion(args)

    expect(result.status).toBe("blocked")
    expect(result.outcomes.map(value => [value.jobId, value.status])).toEqual([["job-a", "completed"], ["job-b", "invalid"]])
  })
})
