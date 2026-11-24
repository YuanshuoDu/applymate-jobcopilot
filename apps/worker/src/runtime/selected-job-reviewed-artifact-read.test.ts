import { beforeEach, describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"

const mocks = vi.hoisted(() => ({
  loadTaskGraph: vi.fn(), currentTaskGraph: vi.fn(), readHead: vi.fn(), readReview: vi.fn(), readSource: vi.fn(),
}))
vi.mock("./subagents/task-graph-pg-state.js", () => ({ loadTaskGraph: mocks.loadTaskGraph }))
vi.mock("./subagents/task-graph-pg-current-node.js", () => ({ currentTaskGraph: mocks.currentTaskGraph }))
vi.mock("../db/agent-artifact-repo.js", () => ({
  findCurrentDraftHeadWithClient: mocks.readHead, findReviewReceiptWithClient: mocks.readReview,
}))
vi.mock("./subagents/selected-job-artifact-context.js", () => ({ readSelectedJobSourceDigestWithClient: mocks.readSource }))

import { readSelectedJobReviewedArtifactWithClient } from "./selected-job-reviewed-artifact-read.js"

const scope = { userId: "user-1", sessionId: "session-1", jobId: "job-1", sourceTurnId: "source-turn-1" }
const sourceDigest = `sha256:${"a".repeat(64)}`
const content = "A reviewed cover letter for this role."
const privatePlaceholder = "[Private selected-job response withheld]"
const reference = { artifactId: "draft-1", version: 2, contentHash: hashArtifactContent(content), sourceDigest }
const reviewHash = `sha256:${"b".repeat(64)}`
const writerTaskId = "writer-task-1"
const reviewerTaskId = "reviewer-task-1"
const writerToolCallId = "writer-call-1"
const reviewerToolCallId = "review-call-1"
const snapshotNodes = [
  { key: "writer", taskId: writerTaskId, templateId: "cover_letter_writer", dependsOn: [] },
  { key: "reviewer", taskId: reviewerTaskId, templateId: "cover_letter_reviewer", dependsOn: ["writer"] },
]

function projection(role: "writer" | "reviewer", extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
    role, status: "completed", artifactRef: reference, ...extra,
  }
}
function graphNodes() {
  return [
    { key: "writer", taskId: writerTaskId, templateId: "cover_letter_writer", status: "completed", resultProjection: projection("writer") },
    { key: "reviewer", taskId: reviewerTaskId, templateId: "cover_letter_reviewer", status: "completed",
      resultProjection: projection("reviewer", { reviewStatus: "passed", reviewHash }) },
  ]
}
function toolReceipt(overrides: { call?: Record<string, unknown>; result?: Record<string, unknown>; event?: Record<string, unknown>;
  eventRow?: Record<string, unknown>; rows?: number; eventRows?: number } = {}) {
  const call = {
    errorCode: null, input: { artifactRef: reference, decision: "passed", findings: [{
      id: privatePlaceholder, code: privatePlaceholder, severity: "info", message: privatePlaceholder,
      artifactHash: reference.contentHash, evidence: [{ artifactHash: reference.contentHash, path: "$.text", summary: privatePlaceholder }],
    }] }, status: "completed",
    toolCallId: reviewerToolCallId, toolName: "artifact.review", toolVersion: "1", ...overrides.call,
  }
  const result = {
    errorCode: null, output: { artifactRef: reference }, toolCallId: reviewerToolCallId,
    ...overrides.result,
  }
  const eventPayload = { errorCode: null, status: "completed", taskId: reviewerTaskId,
    toolCallId: reviewerToolCallId, toolName: "artifact.review", ...overrides.event }
  const items = [
    { id: "call-item-1", stepId: "review-step-1", type: "tool_call", status: "completed", revision: 1, content: call },
    { id: "result-item-1", stepId: "review-step-1", type: "tool_result", status: "completed", revision: 1, content: result },
  ]
  const event = { id: "event-1", sessionId: scope.sessionId, turnId: scope.sourceTurnId, taskId: reviewerTaskId,
    actor: "subagent", itemId: "call-item-1", stepId: "review-step-1", type: "tool_call.completed",
    correlationId: reviewerToolCallId, payload: eventPayload, ...overrides.eventRow }
  return { items: Array.from({ length: overrides.rows ?? 1 }, () => items).flat(),
    events: Array.from({ length: overrides.eventRows ?? 1 }, () => event) }
}
function writerToolReceipt() {
  const call = { errorCode: null, input: { baseArtifactId: "base-1", baseHash: `sha256:${"c".repeat(64)}` },
    status: "completed", toolCallId: writerToolCallId, toolName: "cover_letter.draft", toolVersion: "1" }
  const items = [
    { id: "writer-call-item", stepId: "writer-step-1", type: "tool_call", status: "completed", revision: 1, content: call },
    { id: "writer-result-item", stepId: "writer-step-1", type: "tool_result", status: "completed", revision: 1,
      content: { toolCallId: writerToolCallId, output: { artifactRef: reference }, errorCode: null } },
  ]
  const event = { id: "writer-event-1", sessionId: scope.sessionId, turnId: scope.sourceTurnId, taskId: writerTaskId,
    actor: "subagent", itemId: "writer-call-item", type: "tool_call.completed", correlationId: writerToolCallId,
    payload: { errorCode: null, status: "completed", taskId: writerTaskId, toolCallId: writerToolCallId, toolName: "cover_letter.draft" } }
  return { items, events: [event] }
}
function client(options: { turn?: Record<string, unknown> | null; turnInput?: unknown; artifact?: Record<string, unknown> | null; receipt?: ReturnType<typeof toolReceipt> } = {}) {
  const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
    if (sql.includes('FROM "agent_turns" AS turn')) return { rows: options.turn === null ? [] : [options.turn ?? {
      input: options.turnInput === undefined
        ? { goal: "Prepare this selected job", content: [{ type: "text", text: "Prepare this job" }], clientMessageId: "message-1", selectedJobPreparation: { jobId: scope.jobId } }
        : options.turnInput,
      rootTaskId: "root-1", turnStatus: "completed", turnSource: "user", executionMode: "canonical_task_graph",
      rootStatus: "completed", rootRole: "orchestrator", rootTaskType: "root", rootDepth: 0,
    }] }
    if (sql.includes('FROM "agent_artifact_version"')) return { rows: options.artifact === null ? [] : [options.artifact ?? {
      content, contentHash: reference.contentHash, sourceDigest, taskId: writerTaskId, toolCallId: writerToolCallId,
    }] }
    if (sql.includes('FROM "agent_items"')) return { rows: String(_params?.[2]) === writerTaskId ? writerToolReceipt().items : (options.receipt ?? toolReceipt()).items }
    if (sql.includes('FROM "agent_events"')) return { rows: String(_params?.[2]) === writerTaskId ? writerToolReceipt().events : (options.receipt ?? toolReceipt()).events }
    throw new Error("unexpected query")
  })
  return { query }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadTaskGraph.mockResolvedValue({ item: { id: "task-graph:root-1", revision: 7 }, snapshot: { nodes: snapshotNodes }, state: {} })
  mocks.currentTaskGraph.mockReturnValue({ revision: 7, nodes: graphNodes() })
  mocks.readSource.mockResolvedValue(sourceDigest)
  mocks.readHead.mockResolvedValue(reference)
  mocks.readReview.mockResolvedValue({
    userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId, artifactId: reference.artifactId,
    version: reference.version, contentHash: reference.contentHash, sourceDigest, currentSourceDigest: sourceDigest,
    status: "passed", taskId: reviewerTaskId, toolCallId: reviewerToolCallId, reviewHash,
  })
})

describe("readSelectedJobReviewedArtifactWithClient", () => {
  it("returns the exact current reviewed version from a completed owned selected-job Turn", async () => {
    const pg = client()
    await expect(readSelectedJobReviewedArtifactWithClient(pg as never, scope)).resolves.toEqual({
      sourceTurnId: scope.sourceTurnId, rootTaskId: "root-1", graphRevision: 7, jobId: scope.jobId,
      writerTaskId, reviewerTaskId, reviewerToolCallId, reviewHash, ...reference, content,
    })
    expect(mocks.loadTaskGraph).toHaveBeenCalledWith(expect.anything(), {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.sourceTurnId, rootTaskId: "root-1", parentTaskId: "root-1",
    }, false)
    const turnQuery = pg.query.mock.calls[0]
    expect(turnQuery?.[0]).toContain('turn."userId" = $3 AND session."userId" = $3')
    expect(turnQuery?.[1]).toEqual([scope.sourceTurnId, scope.sessionId, scope.userId])
    const versionQuery = pg.query.mock.calls.find(([sql]) => sql.includes('FROM "agent_artifact_version"'))
    expect(versionQuery?.[0]).toContain('AND "taskId"=$8')
    expect(versionQuery?.[1]?.[7]).toBe(writerTaskId)
  })

  it("keeps accepting the exact historical Objective-shaped selected-job input", async () => {
    const pg = client({ turnInput: {
      goal: "Prepare this selected job", content: [{ type: "text", text: "Prepare this job" }], clientMessageId: "message-1",
      intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, selectedJobPreparation: { jobId: scope.jobId },
    } })
    await expect(readSelectedJobReviewedArtifactWithClient(pg as never, scope)).resolves.toMatchObject({ sourceTurnId: scope.sourceTurnId, jobId: scope.jobId })
  })

  it.each([
    ["a different intent", { goal: "Prepare", content: [], clientMessageId: "message-1", intent: { kind: "interactive_discovery_shortlist", version: 1 }, selectedJobPreparation: { jobId: scope.jobId } }],
    ["a malformed Objective intent", { goal: "Prepare", content: [], clientMessageId: "message-1", intent: { kind: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind, version: 2 }, selectedJobPreparation: { jobId: scope.jobId } }],
    ["an absent-intent input with extra fields", { goal: "Prepare", content: [], clientMessageId: "message-1", extra: true, selectedJobPreparation: { jobId: scope.jobId } }],
    ["a malformed selected-job marker", { goal: "Prepare", content: [], clientMessageId: "message-1", selectedJobPreparation: { jobId: scope.jobId, extra: true } }],
    ["a historical unpinned Turn", { goal: "Prepare", content: [], clientMessageId: "message-1" }],
  ])("rejects %s", async (_name, turnInput) => {
    const pg = client({ turnInput })
    await expect(readSelectedJobReviewedArtifactWithClient(pg as never, scope)).resolves.toBeNull()
    expect(mocks.loadTaskGraph).not.toHaveBeenCalled()
  })

  it.each([
    ["missing source Turn", { turn: null }],
    ["noncanonical source mode", { turn: {
      rootTaskId: "root-1", turnStatus: "completed", turnSource: "user", executionMode: null,
      rootStatus: "completed", rootRole: "orchestrator", rootTaskType: "root", rootDepth: 0,
      input: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, selectedJobPreparation: { jobId: scope.jobId } },
    } }],
    ["wrong selected job", { turn: {
      rootTaskId: "root-1", turnStatus: "completed", turnSource: "user", executionMode: "canonical_task_graph",
      rootStatus: "completed", rootRole: "orchestrator", rootTaskType: "root", rootDepth: 0,
      input: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, selectedJobPreparation: { jobId: "other-job" } },
    } }],
    ["ambiguous source Turn", { turn: { duplicate: true } }],
  ])("fails closed for %s", async (_name, options) => {
    const pg = client(options as { turn?: Record<string, unknown> | null })
    if ((_name as string) === "ambiguous source Turn") pg.query.mockImplementation(async sql => sql.includes('FROM "agent_turns" AS turn') ? { rows: [{}, {}] } : { rows: [] })
    await expect(readSelectedJobReviewedArtifactWithClient(pg as never, scope)).resolves.toBeNull()
    expect(mocks.loadTaskGraph).not.toHaveBeenCalled()
  })

  it.each([
    ["review not passed", graphNodes().map(node => node.key === "reviewer" ? { ...node, resultProjection: projection("reviewer", { reviewStatus: "needs_revision", reviewHash }) } : node), snapshotNodes],
    ["reviewer no longer completed", graphNodes().map(node => node.key === "reviewer" ? { ...node, status: "failed" } : node), snapshotNodes],
    ["reviewer dependency changed", graphNodes(), [snapshotNodes[0], { ...snapshotNodes[1], dependsOn: [] }]],
  ])("rejects %s graph evidence", async (_name, nodes, snapshot) => {
    mocks.currentTaskGraph.mockReturnValue({ revision: 7, nodes })
    mocks.loadTaskGraph.mockResolvedValue({ item: { id: "task-graph:root-1", revision: 7 }, snapshot: { nodes: snapshot }, state: {} })
    await expect(readSelectedJobReviewedArtifactWithClient(client() as never, scope)).resolves.toBeNull()
    expect(mocks.readReview).not.toHaveBeenCalled()
  })

  it.each([
    ["duplicate tool items", { rows: 2 }],
    ["missing tool event", { eventRows: 0 }],
    ["foreign event owner", { eventRow: { taskId: "other-task" } }],
    ["wrong event actor", { eventRow: { actor: "orchestrator" } }],
    ["failed reviewer event", { event: { status: "failed" } }],
    ["tool reviewed another version", { result: { output: { artifactRef: { ...reference, version: 1 }, reviewHash, status: "passed" } } }],
  ])("rejects %s", async (_name, overrides) => {
    const pg = client({ receipt: toolReceipt(overrides as never) })
    await expect(readSelectedJobReviewedArtifactWithClient(pg as never, scope)).resolves.toBeNull()
  })

  it("rejects a changed source, stale head, missing version, or altered immutable content", async () => {
    mocks.readSource.mockResolvedValueOnce(`sha256:${"c".repeat(64)}`)
    await expect(readSelectedJobReviewedArtifactWithClient(client() as never, scope)).resolves.toBeNull()
    mocks.readSource.mockReset().mockResolvedValue(sourceDigest)
    mocks.readHead.mockResolvedValueOnce({ ...reference, version: 1 })
    await expect(readSelectedJobReviewedArtifactWithClient(client() as never, scope)).resolves.toBeNull()
    mocks.readHead.mockReset().mockResolvedValue(reference)
    await expect(readSelectedJobReviewedArtifactWithClient(client({ artifact: null }) as never, scope)).resolves.toBeNull()
    await expect(readSelectedJobReviewedArtifactWithClient(client({ artifact: { content: "changed", contentHash: reference.contentHash, sourceDigest } }) as never, scope)).resolves.toBeNull()
  })

  it("rejects an immutable version created by a different Writer task", async () => {
    const pg = client({ artifact: { content, contentHash: reference.contentHash, sourceDigest, taskId: "other-writer", toolCallId: writerToolCallId } })
    await expect(readSelectedJobReviewedArtifactWithClient(pg as never, scope)).resolves.toBeNull()
    expect(pg.query.mock.calls.some(([sql]) => sql.includes('FROM "agent_items"'))).toBe(false)
  })
})
