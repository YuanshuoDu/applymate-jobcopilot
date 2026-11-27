import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  loadResources: vi.fn(), readDraftHead: vi.fn(), readReviewReceipt: vi.fn(), readSourceDigest: vi.fn(),
}))
vi.mock("./verified-shortlist-batch-resources.js", () => ({ loadVerifiedShortlistBatchResources: mocks.loadResources }))
vi.mock("../db/agent-artifact-repo.js", () => ({
  findCurrentDraftHeadWithClient: mocks.readDraftHead, findReviewReceiptWithClient: mocks.readReviewReceipt,
}))
vi.mock("./subagents/selected-job-artifact-context.js", () => ({ readSelectedJobSourceDigestWithClient: mocks.readSourceDigest }))

import { verifyCanonicalSelectedJobBatchCompletion, type CanonicalSelectedJobBatchCompletionInput } from "./canonical-selected-job-batch-completion.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCommandPort, type TaskGraphCurrentNode, type TaskGraphCurrentState, type TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { SelectedJobBatchSlot } from "./subagents/selected-job-batch-plan.js"
import type { TurnLease } from "./turns/lease.js"
import type { PoolClient } from "pg"

const lease: TurnLease = {
  turnId: "turn-batch", sessionId: "session-batch", ownerId: "worker-1", userId: "user-1", leaseVersion: 4,
  leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000),
}
const rootTaskId = "root-batch"
const slots: readonly SelectedJobBatchSlot[] = [
  { slotId: "slot-1", jobId: "job-a" }, { slotId: "slot-2", jobId: "job-b" },
]
const binding = { schemaVersion: "fixture-binding" }
const refs = {
  "job-a": { artifactId: "draft-a", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` },
  "job-b": { artifactId: "draft-b", version: 5, contentHash: `sha256:${"c".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}` },
}
const correctionRefs = {
  "job-a": { artifactId: "draft-a", version: 3, contentHash: `sha256:${"9".repeat(64)}`, sourceDigest: refs["job-a"].sourceDigest },
  "job-b": { artifactId: "draft-b", version: 6, contentHash: `sha256:${"8".repeat(64)}`, sourceDigest: refs["job-b"].sourceDigest },
}
type JobId = keyof typeof refs

function makeGraph(statuses: Readonly<Record<string, TaskGraphCurrentNode["status"]>> = {}): TaskGraphCurrentState {
  const nodes = slots.flatMap((slot, index) => {
    const suffix = index === 0 ? "a" : "b", writerKey = `writer-${suffix}`, reviewerKey = `reviewer-${suffix}`
    const writerTemplateId = `cover_letter_writer_${slot.slotId.replace("-", "_")}`
    const reviewerTemplateId = `cover_letter_reviewer_${slot.slotId.replace("-", "_")}`
    const ref = refs[slot.jobId as JobId]
    return [
      makeNode(writerKey, writerTemplateId, `${writerKey}-task`, "writer", ref, statuses[writerKey] ?? "completed", []),
      makeNode(reviewerKey, reviewerTemplateId, `${reviewerKey}-task`, "reviewer", ref, statuses[reviewerKey] ?? "completed", [writerKey]),
    ]
  })
  return { revision: 9, nodes }
}

function makeCorrectionGraph(): TaskGraphCurrentState {
  const graph = makeGraph()
  const nodes = graph.nodes.map(node => node.key === "reviewer-a" && node.resultProjection?.availability === "available" && node.resultProjection.role === "reviewer"
    ? { ...node, resultProjection: { ...node.resultProjection, reviewStatus: "needs_revision" as const } } : node)
  const writerTemplate = "cover_letter_writer_slot_1", reviewerTemplate = "cover_letter_reviewer_slot_1"
  return { revision: graph.revision + 1, nodes: [...nodes,
    makeNode("writer-a-correction", writerTemplate, "writer-a-correction-task", "writer", correctionRefs["job-a"], "completed", ["reviewer-a"]),
    makeNode("reviewer-a-correction", reviewerTemplate, "reviewer-a-correction-task", "reviewer", correctionRefs["job-a"], "completed", ["writer-a-correction"]),
  ] }
}

function makeNode(
  key: string, templateId: string, taskId: string, role: "writer" | "reviewer", ref: typeof refs["job-a"],
  status: TaskGraphCurrentNode["status"], dependsOn: readonly string[],
): TaskGraphCurrentNode {
  const resultProjection = status !== "completed" ? undefined : role === "writer"
    ? { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const, role, status, artifactRef: ref }
    : { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const, role, status, artifactRef: ref,
      reviewStatus: "passed" as const, reviewHash: `sha256:${"e".repeat(64)}` }
  return { key, templateId, taskId, status, goal: "Prepare selected job", successCriteria: ["Review material"], dependsOn,
    readiness: status === "completed" || status === "failed" || status === "cancelled" ? "terminal"
      : status === "running" ? "active" : "waiting_for_dependencies",
    resultSummary: null, failureReason: status === "failed" ? "branch_failed" : null,
    ...(resultProjection ? { resultProjection } : {}) }
}

function contextRows(graph: TaskGraphCurrentState, options: { crossedJob?: boolean; foreignOwner?: boolean } = {}) {
  return graph.nodes.map((node, index) => {
    const job = slots.find(slot => node.templateId.includes(slot.slotId.replace("-", "_")))!.jobId
    const selectedJobId = options.crossedJob && node.key === "reviewer-b" ? "job-a" : job
    const dependency = node.dependsOn[0] ? graph.nodes.find(candidate => candidate.key === node.dependsOn[0]) : undefined
    const dependencyContext = dependency?.resultProjection ? {
      schemaVersion: "agent-harness.v2.task-graph.dependency-evidence",
      items: [{ dependencyKey: dependency.key, ...(dependency.templateId.includes("reviewer") ? { dependencyTaskId: dependency.taskId } : {}),
        role: dependency.templateId.includes("writer") ? "writer" : "reviewer", taskStatus: "completed", result: dependency.resultProjection }],
    } : undefined
    return {
      taskId: node.taskId,
      taskSessionId: lease.sessionId, taskTurnId: lease.turnId, taskRootTaskId: rootTaskId, taskParentTaskId: rootTaskId,
      taskRole: node.key.startsWith("writer-") ? "writer" : "reviewer",
      context: { selectedJobPreparation: { jobId: selectedJobId }, ...(dependencyContext ? { taskGraphDependencyResults: dependencyContext } : {}) },
      sessionUserId: options.foreignOwner && index === 0 ? "other-user" : lease.userId,
      turnUserId: lease.userId, turnRootTaskId: rootTaskId,
    }
  })
}

function makeClient(graph: TaskGraphCurrentState, options: { crossedJob?: boolean; foreignOwner?: boolean; staleRoot?: boolean } = {}) {
  const contexts = contextRows(graph, options)
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{
      id: rootTaskId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId,
      parentTaskId: null, role: "orchestrator", taskType: "root", status: "running", attemptCount: 3,
      leaseOwner: options.staleRoot ? "old-worker" : lease.ownerId, interruptRequestedAt: null,
      sessionUserId: lease.userId, turnUserId: lease.userId,
    }] }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) {
      const ids = values[0] as string[]
      return { rows: contexts.filter(row => ids.includes(row.taskId)) }
    }
    if (sql.includes('FROM "agent_artifact_version"')) {
      const jobId = String(values[2]), taskId = String(values[5])
      const correction = taskId?.includes("correction") ?? false
      const reference = correction ? correctionRefs[jobId as JobId] : refs[jobId as JobId]
      return { rows: reference ? [{ ...reference, artifactType: "cover_letter", taskId, previousHash: correction ? refs[jobId as JobId].contentHash : null }] : [] }
    }
    throw new Error("unexpected completion query")
  })
  return { client: { query } as unknown as PoolClient, query }
}

function setup(options: {
  graph?: TaskGraphCurrentState
  contexts?: { crossedJob?: boolean; foreignOwner?: boolean }
  staleRoot?: boolean
  currentPort?: boolean
  graphReadFailure?: boolean
  sourceDigests?: Partial<Record<JobId, string | null>>
} = {}) {
  const currentGraph = options.graph ?? makeGraph()
  const { client, query } = makeClient(currentGraph, { ...options.contexts, staleRoot: options.staleRoot })
  mocks.loadResources.mockResolvedValue(slots)
  mocks.readDraftHead.mockImplementation(async (received: PoolClient, scope: { jobId: JobId; artifactId: string }) => {
    expect(received).toBe(client)
    const corrected = currentGraph.nodes.some(node => node.key === `writer-${scope.jobId === "job-a" ? "a" : "b"}-correction`)
    return { ...(corrected ? correctionRefs[scope.jobId] : refs[scope.jobId]), artifactId: scope.artifactId }
  })
  mocks.readReviewReceipt.mockImplementation(async (received: PoolClient, scope: Record<string, unknown>) => {
    expect(received).toBe(client)
    return { ...scope, toolCallId: `receipt-${String(scope.jobId)}` }
  })
  mocks.readSourceDigest.mockImplementation(async (received: PoolClient, _userId: string, jobId: JobId) => {
    expect(received).toBe(client)
    return options.sourceDigests && Object.hasOwn(options.sourceDigests, jobId) ? options.sourceDigests[jobId] : refs[jobId].sourceDigest
  })
  const readCurrentWithClient = vi.fn(async (received: PoolClient, scope: TaskGraphReadScope) => {
    expect(received).toBe(client)
    expect(scope).toMatchObject({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
      rootTaskId, parentTaskId: rootTaskId, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
      parentLeaseOwner: lease.ownerId, parentAttemptCount: 3 })
    return currentGraph
  })
  const readGraph = options.graphReadFailure
    ? vi.fn(async (_received: PoolClient, _scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> => { throw new Error("graph_unavailable") })
    : readCurrentWithClient
  const input: CanonicalSelectedJobBatchCompletionInput = {
    client, lease, rootTaskId, binding, acceptedWitness: undefined,
    commandPort: options.currentPort === false ? undefined : { readCurrentWithClient: readGraph } as Pick<TaskGraphCommandPort, "readCurrentWithClient">,
  }
  return { input, client, query, readCurrentWithClient }
}

describe("canonical selected-job batch completion transaction adapter", () => {
  beforeEach(() => vi.clearAllMocks())

  it("revalidates two Job branches and all evidence with the caller's exact client", async () => {
    const state = setup()
    const result = await verifyCanonicalSelectedJobBatchCompletion(state.input)

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.outcomes.map(outcome => [outcome.slotId, outcome.jobId, outcome.status])).toEqual([
      ["slot-1", "job-a", "completed"], ["slot-2", "job-b", "completed"],
    ])
    expect(result.witness.graph.revision).toBe(9)
    expect(state.readCurrentWithClient).toHaveBeenCalledTimes(1)
    expect(mocks.loadResources).toHaveBeenCalledWith({ client: state.client, lease, expectedRootTaskId: rootTaskId, binding })
    expect(state.query).toHaveBeenCalledTimes(4)
    const rootSql = state.query.mock.calls[0]![0], contextSql = state.query.mock.calls[1]![0]
    expect(rootSql).toContain("FOR UPDATE OF root")
    expect(rootSql).toContain('session."userId" = $2')
    expect(rootSql).toContain('turn."userId" = $2')
    expect(rootSql).not.toContain('root."userId"')
    expect(contextSql).toContain('task."rootTaskId" = $5 AND task."parentTaskId" = $5')
    expect(contextSql).toContain('turn."userId" = $2')
    expect(contextSql).not.toContain('task."userId"')
    expect(state.query.mock.calls[1]![1]).toEqual([
      ["writer-a-task", "reviewer-a-task", "writer-b-task", "reviewer-b-task"],
      lease.userId, lease.sessionId, lease.turnId, rootTaskId,
    ])
    expect(mocks.readDraftHead).toHaveBeenCalledTimes(2)
    expect(mocks.readSourceDigest).toHaveBeenCalledTimes(6)
    expect(mocks.readReviewReceipt).toHaveBeenCalledTimes(2)
    const versionReads = state.query.mock.calls.filter(([sql]) => sql.includes('FROM "agent_artifact_version"'))
    expect(versionReads.map(([, values]) => values)).toEqual([
      [lease.userId, lease.sessionId, "job-a", refs["job-a"].artifactId, refs["job-a"].version, "writer-a-task"],
      [lease.userId, lease.sessionId, "job-b", refs["job-b"].artifactId, refs["job-b"].version, "writer-b-task"],
    ])
    expect(versionReads.every(([sql]) => sql.includes('"artifactType" = \'cover_letter\'') && sql.includes('"taskId" = $6'))).toBe(true)
    expect(state.query.mock.calls.every(([sql]) => !sql.includes("BEGIN") && !sql.includes("COMMIT"))).toBe(true)
  })

  it.each([
    { label: "stale root lease", options: { staleRoot: true } },
    { label: "crossed Job context", options: { contexts: { crossedJob: true } } },
    { label: "foreign task context", options: { contexts: { foreignOwner: true } } },
  ])("blocks a $label without reading artifacts", async ({ options }) => {
    const state = setup(options)
    const result = await verifyCanonicalSelectedJobBatchCompletion(state.input)
    expect(result.status).toBe("blocked")
    expect(result.outcomes.map(row => row.status)).toEqual(["invalid", "invalid"])
    expect(mocks.readDraftHead).not.toHaveBeenCalled()
    expect(mocks.readReviewReceipt).not.toHaveBeenCalled()
  })

  it("fails closed when caller lacks a client-bound graph reader or it cannot load the graph", async () => {
    const missing = setup({ currentPort: false })
    expect((await verifyCanonicalSelectedJobBatchCompletion(missing.input)).status).toBe("blocked")

    const failing = setup({ graphReadFailure: true })
    const result = await verifyCanonicalSelectedJobBatchCompletion(failing.input)
    expect(result.status).toBe("blocked")
    expect(result.outcomes.map(row => row.status)).toEqual(["invalid", "invalid"])
  })

  it("keeps incomplete work pending, explicit terminal branch failures separate, and stale proof blocked", async () => {
    const pending = setup({ graph: makeGraph({ "reviewer-a": "queued" }) })
    const pendingResult = await verifyCanonicalSelectedJobBatchCompletion(pending.input)
    expect(pendingResult.status).toBe("pending")
    expect(pendingResult.outcomes.map(row => [row.jobId, row.status])).toEqual([["job-a", "pending"], ["job-b", "completed"]])

    const failed = setup({ graph: makeGraph({ "writer-a": "failed", "reviewer-a": "cancelled" }) })
    const failedResult = await verifyCanonicalSelectedJobBatchCompletion(failed.input)
    expect(failedResult.status).toBe("ready")
    expect(failedResult.outcomes.map(row => [row.jobId, row.status])).toEqual([["job-a", "failed"], ["job-b", "completed"]])

    const stale = setup({ sourceDigests: { "job-a": `sha256:${"f".repeat(64)}` } })
    const staleResult = await verifyCanonicalSelectedJobBatchCompletion(stale.input)
    expect(staleResult.status).toBe("blocked")
    expect(staleResult.outcomes.map(row => [row.jobId, row.status])).toEqual([["job-a", "invalid"], ["job-b", "completed"]])
  })

  it("rechecks accepted evidence against the same terminal graph and client reads", async () => {
    const candidate = setup()
    const accepted = await verifyCanonicalSelectedJobBatchCompletion(candidate.input)
    if (accepted.status !== "ready") throw new Error("test setup did not accept candidate evidence")

    const unchanged = setup()
    const final = await verifyCanonicalSelectedJobBatchCompletion({ ...unchanged.input, acceptedWitness: accepted.witness })
    expect(final.status).toBe("ready")

    const changedGraph = { ...makeGraph(), revision: 10 }
    const changed = setup({ graph: changedGraph })
    const rejected = await verifyCanonicalSelectedJobBatchCompletion({ ...changed.input, acceptedWitness: accepted.witness })
    expect(rejected.status).toBe("blocked")
  })

  it("resolves a correction slot through its latest pair while retaining the initial review proof", async () => {
    const state = setup({ graph: makeCorrectionGraph() })
    const result = await verifyCanonicalSelectedJobBatchCompletion(state.input)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.outcomes[0]).toMatchObject({ writerTaskId: "writer-a-correction-task", reviewerTaskId: "reviewer-a-correction-task",
      evidence: { artifactRef: correctionRefs["job-a"] }, priorEvidence: { writerTaskId: "writer-a-task", reviewerTaskId: "reviewer-a-task",
        artifactRef: refs["job-a"], reviewStatus: "needs_revision" } })
    expect(result.witness.graph.nodes).toHaveLength(6)
    const versionReads = state.query.mock.calls.filter(([sql]) => sql.includes('FROM "agent_artifact_version"'))
    expect(versionReads.map(([, values]) => [values?.[2], values?.[5]])).toEqual([
      ["job-a", "writer-a-task"], ["job-a", "writer-a-correction-task"], ["job-b", "writer-b-task"],
    ])
    expect(state.query.mock.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task'))?.[1]?.[0]).toEqual([
      "writer-a-task", "reviewer-a-task", "writer-b-task", "reviewer-b-task", "writer-a-correction-task", "reviewer-a-correction-task",
    ])
  })
})
