import { describe, expect, it, vi } from "vitest"
import { selectedJobArtifactCompletionGate } from "./selected-job-completion-gate.js"
import {
  TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
  type TaskGraphCommandPort,
  type TaskGraphCurrentNode,
  type TaskGraphCurrentState,
  type TaskGraphResultProjection,
} from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import type { AgentArtifactReviewReceipt, AgentArtifactReviewReceiptScope } from "../db/agent-artifact-repo.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 4,
  leaseStartedAt: new Date("2026-09-30T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-30T00:01:00.000Z"),
}
const root = { id: "root-1", attemptCount: 3 }
const reference = (overrides: Partial<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }> = {}) => ({
  artifactId: "draft-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}`, ...overrides,
})

function node(input: Partial<TaskGraphCurrentNode> & Pick<TaskGraphCurrentNode, "key" | "templateId" | "status">): TaskGraphCurrentNode {
  return {
    key: input.key, templateId: input.templateId, status: input.status, goal: "Complete selected-job work",
    successCriteria: ["Persist the result"], dependsOn: input.dependsOn ?? [], taskId: `task-${input.key}`,
    readiness: input.readiness ?? "terminal", resultSummary: null,
    ...(input.resultProjection ? { resultProjection: input.resultProjection } : {}),
    failureReason: null,
  }
}

function writer(artifactRef = reference(), key = "writer"): TaskGraphCurrentNode {
  return node({ key, templateId: "cover_letter_writer", status: "completed", resultProjection: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "writer", status: "completed", artifactRef,
  } })
}

function reviewer(
  artifactRef = reference(),
  reviewStatus: "passed" | "needs_revision" | "rejected" | "stale" = "passed",
  dependsOn = ["writer"],
  key = "reviewer",
): TaskGraphCurrentNode {
  return node({ key, templateId: "cover_letter_reviewer", status: "completed", dependsOn, resultProjection: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "reviewer", status: "completed", artifactRef, reviewStatus, reviewHash: `sha256:${"c".repeat(64)}`,
  } })
}

type DraftHeadReader = (scope: { artifactId: string }) => Promise<ReturnType<typeof reference> | null>
const failingHeadReaders: Array<[string, DraftHeadReader]> = [
  ["missing", async () => null],
  ["stale version", async () => ({ ...reference({ version: 1 }) })],
  ["conflicting content hash", async () => ({ ...reference({ contentHash: `sha256:${"d".repeat(64)}` }) })],
  ["unreadable", async (): Promise<ReturnType<typeof reference> | null> => { throw new Error("private repository detail") }],
]

function current(nodes: readonly TaskGraphCurrentNode[]): TaskGraphCurrentState {
  return { revision: 8, nodes }
}

function persistedReview(scope: AgentArtifactReviewReceiptScope): AgentArtifactReviewReceipt {
  return { ...scope, toolCallId: "review-call-1" }
}

const readPersistedReview = async (scope: AgentArtifactReviewReceiptScope) => persistedReview(scope)

type ReviewReceiptReader = (scope: AgentArtifactReviewReceiptScope) => Promise<AgentArtifactReviewReceipt | null>
const failingReviewReaders: Array<[string, ReviewReceiptReader]> = [
  ["missing", async () => null],
  ["owner mismatch", async scope => ({ ...persistedReview(scope), userId: "other-user" })],
  ["session mismatch", async scope => ({ ...persistedReview(scope), sessionId: "other-session" })],
  ["job mismatch", async scope => ({ ...persistedReview(scope), jobId: "other-job" })],
  ["artifact mismatch", async scope => ({ ...persistedReview(scope), artifactId: "cover-letter:other-draft" })],
  ["version mismatch", async scope => ({ ...persistedReview(scope), version: 1 })],
  ["content hash mismatch", async scope => ({ ...persistedReview(scope), contentHash: `sha256:${"d".repeat(64)}` })],
  ["artifact source digest mismatch", async scope => ({ ...persistedReview(scope), sourceDigest: `sha256:${"e".repeat(64)}` })],
  ["reviewer task mismatch", async scope => ({ ...persistedReview(scope), taskId: "other-reviewer-task" })],
  ["invalid tool-call identity", async scope => ({ ...persistedReview(scope), toolCallId: " " })],
  ["current source digest mismatch", async scope => ({ ...persistedReview(scope), currentSourceDigest: `sha256:${"f".repeat(64)}` })],
  ["review hash mismatch", async scope => ({ ...persistedReview(scope), reviewHash: `sha256:${"d".repeat(64)}` })],
  ["review status mismatch", async scope => ({ ...persistedReview(scope), status: "rejected" })],
  ["stale review status", async scope => ({ ...persistedReview(scope), status: "stale" })],
]

function commandPort(value: unknown) {
  return {
    appendAndSchedule: async () => ({ status: "accepted" as const, revision: 8, nodes: [], readyTaskIds: [] }),
    readCurrent: vi.fn(async () => value as TaskGraphCurrentState),
  } satisfies TaskGraphCommandPort
}

async function check(value: unknown) {
  return selectedJobArtifactCompletionGate({
    commandPort: commandPort(value), lease, root, selectedJobId: "job-1",
    readCurrentDraftHead: async scope => ({ ...reference(), artifactId: scope.artifactId }),
    readCurrentSourceDigest: async () => reference().sourceDigest,
    readCurrentReviewReceipt: readPersistedReview,
  })
}

describe("selected-job artifact completion gate", () => {
  it.each(["passed", "needs_revision", "rejected"] as const)("accepts the exact latest Writer and Reviewer pair with %s status", async reviewStatus => {
    const state = current([writer(), reviewer(reference(), reviewStatus)])
    const port = commandPort(state)
    const readCurrentDraftHead = vi.fn(async (scope: { artifactId: string }) => ({ ...reference(), artifactId: scope.artifactId }))

    const readCurrentReviewReceipt = vi.fn(readPersistedReview)
    await expect(selectedJobArtifactCompletionGate({
      commandPort: port, lease, root, selectedJobId: "job-1", readCurrentDraftHead, readCurrentReviewReceipt,
      readCurrentSourceDigest: async () => reference().sourceDigest,
    })).resolves.toEqual({ ok: true })
    expect(port.readCurrent).toHaveBeenCalledWith({
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: root.id, parentTaskId: root.id,
      turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: root.attemptCount,
    })
    expect(readCurrentDraftHead).toHaveBeenCalledWith({
      userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1", artifactId: "draft-1",
    })
    expect(readCurrentReviewReceipt).toHaveBeenCalledWith({
      userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1", artifactId: "draft-1",
      version: 2, contentHash: reference().contentHash, sourceDigest: reference().sourceDigest,
      currentSourceDigest: reference().sourceDigest, taskId: "task-reviewer", status: reviewStatus,
      reviewHash: `sha256:${"c".repeat(64)}`,
    })
  })

  it.each(failingReviewReaders)("fails closed when the durable review receipt is %s", async (_label, readCurrentReviewReceipt) => {
    const graph = current([writer(), reviewer()])
    await expect(selectedJobArtifactCompletionGate({
      commandPort: commandPort(graph), lease, root, selectedJobId: "job-1",
      readCurrentDraftHead: async scope => ({ ...reference(), artifactId: scope.artifactId }),
      readCurrentSourceDigest: async () => reference().sourceDigest,
      readCurrentReviewReceipt,
    })).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
  })

  const scout = node({ key: "scout", templateId: "scout", status: "completed", resultProjection: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "scout", status: "completed", candidateCount: 0, evidenceCount: 0, candidates: [],
  } })
  const analyst = node({ key: "analyst", templateId: "analyst", status: "completed", resultProjection: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "analyst", status: "completed", findingCount: 0, evidenceCount: 0, findings: [],
  } })
  const unavailable: TaskGraphResultProjection = { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable" }
  const versionOne = reference({ version: 1 })
  const latestWriter = writer(reference({ version: 3 }), "writer-latest")

  const invalidGraphs: Array<{ name: string; graph: TaskGraphCurrentState }> = [
    { name: "empty graph", graph: current([]) },
    { name: "Scout-only graph", graph: current([scout]) },
    { name: "Analyst-only graph", graph: current([analyst]) },
    { name: "missing completed Writer projection", graph: current([node({ key: "writer", templateId: "cover_letter_writer", status: "completed" }), reviewer()]) },
    { name: "unavailable completed Writer projection", graph: current([node({ key: "writer", templateId: "cover_letter_writer", status: "completed", resultProjection: unavailable }), reviewer()]) },
    { name: "missing completed Reviewer projection", graph: current([writer(), node({ key: "reviewer", templateId: "cover_letter_reviewer", status: "completed", dependsOn: ["writer"] })]) },
    { name: "unavailable completed Reviewer projection", graph: current([writer(), node({ key: "reviewer", templateId: "cover_letter_reviewer", status: "completed", dependsOn: ["writer"], resultProjection: unavailable })]) },
    { name: "no direct Reviewer-to-Writer dependency", graph: current([writer(), analyst, reviewer(reference(), "passed", ["analyst"])]) },
    { name: "artifact ID mismatch", graph: current([writer(), reviewer(reference({ artifactId: "draft-2" }))]) },
    { name: "conflicting latest Reviewer reference", graph: current([writer(), reviewer(), reviewer(reference({ contentHash: `sha256:${"d".repeat(64)}` }), "passed", ["writer"], "reviewer-conflict")]) },
    { name: "version mismatch", graph: current([writer(), reviewer(reference({ version: 1 }))]) },
    { name: "content hash mismatch", graph: current([writer(), reviewer(reference({ contentHash: `sha256:${"d".repeat(64)}` }))]) },
    { name: "source digest mismatch", graph: current([writer(), reviewer(reference({ sourceDigest: `sha256:${"e".repeat(64)}` }))]) },
    { name: "stale review status", graph: current([writer(), reviewer(reference(), "stale")]) },
    { name: "latest Writer version lacks its exact review", graph: current([writer(versionOne, "writer-old"), reviewer(versionOne, "passed", ["writer-old"], "reviewer-old"), latestWriter]) },
  ]

  it.each(invalidGraphs)("blocks $name", async ({ graph }) => {
    await expect(check(graph)).resolves.toEqual({
      ok: false,
      blocker: "selected_job_draft_review_required",
      feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
    })
  })

  it("fails closed when the current persisted graph is unavailable", async () => {
    const port = {
      appendAndSchedule: async () => ({ status: "accepted" as const, revision: 0, nodes: [], readyTaskIds: [] }),
      readCurrent: async () => { throw new Error("private store detail") },
    } satisfies TaskGraphCommandPort

    await expect(selectedJobArtifactCompletionGate({
      commandPort: port, lease, root, selectedJobId: "job-1",
      readCurrentDraftHead: async scope => ({ ...reference(), artifactId: scope.artifactId }),
      readCurrentSourceDigest: async () => reference().sourceDigest,
      readCurrentReviewReceipt: readPersistedReview,
    })).resolves.toEqual({
      ok: false,
      blocker: "selected_job_draft_review_required",
      feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
    })
  })

  it("fails closed when the command port is unavailable", async () => {
    await expect(selectedJobArtifactCompletionGate({
      commandPort: undefined, lease, root, selectedJobId: undefined, readCurrentDraftHead: undefined,
      readCurrentSourceDigest: undefined, readCurrentReviewReceipt: undefined,
    })).resolves.toMatchObject({
      ok: false, blocker: "selected_job_draft_review_required",
    })
  })

  it("fails closed when a durable review receipt reader is unavailable", async () => {
    await expect(selectedJobArtifactCompletionGate({
      commandPort: commandPort(current([writer(), reviewer()])), lease, root, selectedJobId: "job-1",
      readCurrentDraftHead: async scope => ({ ...reference(), artifactId: scope.artifactId }),
      readCurrentSourceDigest: async () => reference().sourceDigest, readCurrentReviewReceipt: undefined,
    })).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
  })

  it.each(failingHeadReaders)("fails closed when the persisted draft head is %s", async (_label, readCurrentDraftHead) => {
    const graph = current([writer(), reviewer()])
    await expect(selectedJobArtifactCompletionGate({
      commandPort: commandPort(graph), lease, root, selectedJobId: "job-1", readCurrentDraftHead,
      readCurrentSourceDigest: async () => reference().sourceDigest,
      readCurrentReviewReceipt: readPersistedReview,
    })).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
  })

  it("fails closed without a server-selected job identity or current-source reader", async () => {
    const graph = current([writer(), reviewer()])
    await expect(selectedJobArtifactCompletionGate({
      commandPort: commandPort(graph), lease, root, selectedJobId: "job-1",
      readCurrentDraftHead: async scope => ({ ...reference(), artifactId: scope.artifactId }), readCurrentSourceDigest: undefined,
      readCurrentReviewReceipt: readPersistedReview,
    })).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
  })

  it("blocks completion when selected-job sources change after the Reviewer receipt", async () => {
    const graph = current([writer(), reviewer()])
    await expect(selectedJobArtifactCompletionGate({
      commandPort: commandPort(graph), lease, root, selectedJobId: "job-1",
      readCurrentDraftHead: async scope => ({ ...reference(), artifactId: scope.artifactId }),
      readCurrentSourceDigest: async () => `sha256:${"e".repeat(64)}`,
      readCurrentReviewReceipt: readPersistedReview,
    })).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
  })

  it("fails closed when current selected-job sources are unavailable", async () => {
    const graph = current([writer(), reviewer()])
    await expect(selectedJobArtifactCompletionGate({
      commandPort: commandPort(graph), lease, root, selectedJobId: "job-1",
      readCurrentDraftHead: async scope => ({ ...reference(), artifactId: scope.artifactId }),
      readCurrentSourceDigest: async () => { throw new Error("private source detail") },
      readCurrentReviewReceipt: readPersistedReview,
    })).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
  })

  it("checks the latest artifact reference from every Writer and Reviewer node", async () => {
    const secondArtifact = reference({ artifactId: "draft-2" })
    const graph = current([writer(), reviewer(), reviewer(secondArtifact, "passed", ["writer"], "reviewer-second")])
    const port = commandPort(graph)
    const readCurrentDraftHead = vi.fn(async (scope: { artifactId: string }) => ({ ...reference(), artifactId: scope.artifactId }))

    await expect(selectedJobArtifactCompletionGate({
      commandPort: port, lease, root, selectedJobId: "job-1", readCurrentDraftHead,
      readCurrentSourceDigest: async () => reference().sourceDigest,
      readCurrentReviewReceipt: readPersistedReview,
    })).resolves.toEqual({ ok: true })
    expect(readCurrentDraftHead).toHaveBeenCalledTimes(2)
    expect(readCurrentDraftHead).toHaveBeenNthCalledWith(1, { userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1", artifactId: "draft-1" })
    expect(readCurrentDraftHead).toHaveBeenNthCalledWith(2, { userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1", artifactId: "draft-2" })
  })
})
