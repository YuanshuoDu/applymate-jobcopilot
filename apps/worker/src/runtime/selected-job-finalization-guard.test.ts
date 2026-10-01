import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import type {
  AgentArtifactDraftHeadScope, AgentArtifactReviewReceipt, AgentArtifactReviewReceiptScope,
} from "../db/agent-artifact-repo.js"
import type { TaskGraphCommandPort, TaskGraphCurrentNode, TaskGraphCurrentState, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import {
  selectedJobArtifactFinalizationGuard, type SelectedJobArtifactFinalizationGuardInput,
  type SelectedJobSourceDigestScope,
} from "./selected-job-finalization-guard.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 4,
  leaseStartedAt: new Date("2026-09-30T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-30T00:01:00.000Z"),
}
const root = { id: "root-1", attemptCount: 3 }
const artifactRef = {
  artifactId: "draft-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}`,
}
const reviewHash = `sha256:${"c".repeat(64)}`

function node(input: Partial<TaskGraphCurrentNode> & Pick<TaskGraphCurrentNode, "key" | "templateId" | "status">): TaskGraphCurrentNode {
  return {
    key: input.key, templateId: input.templateId, status: input.status, goal: "Complete selected-job work",
    successCriteria: ["Persist the result"], dependsOn: input.dependsOn ?? [], taskId: input.taskId ?? `task-${input.key}`,
    readiness: input.readiness ?? "terminal", resultSummary: null, failureReason: null,
    ...(input.resultProjection ? { resultProjection: input.resultProjection } : {}),
  }
}

function graph(revision = 8, reviewerHash = reviewHash): TaskGraphCurrentState {
  return {
    revision,
    nodes: [
      node({ key: "writer", templateId: "cover_letter_writer", status: "completed", resultProjection: {
        schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "writer", status: "completed", artifactRef,
      } }),
      node({ key: "reviewer", templateId: "cover_letter_reviewer", status: "completed", dependsOn: ["writer"], resultProjection: {
        schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash: reviewerHash,
      } }),
    ],
  }
}

function makePort(readWithClient?: (client: PoolClient, scope: TaskGraphReadScope) => Promise<TaskGraphCurrentState>): TaskGraphCommandPort {
  return {
    appendAndSchedule: async () => ({ status: "accepted", revision: 8, nodes: [], readyTaskIds: [] }),
    readCurrent: vi.fn(async () => graph()),
    ...(readWithClient ? { readCurrentWithClient: readWithClient } : {}),
  }
}

function fixture(overrides: Partial<SelectedJobArtifactFinalizationGuardInput> = {}) {
  const currentClient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as PoolClient
  const currentGraph = graph()
  const readGraph = vi.fn(async (client: PoolClient, _scope: TaskGraphReadScope) => currentGraph)
  const readDraftHead = vi.fn(async (_client: PoolClient, scope: AgentArtifactDraftHeadScope) => ({ ...artifactRef, artifactId: scope.artifactId }))
  const readSourceDigest = vi.fn(async (_client: PoolClient, scope: SelectedJobSourceDigestScope) => scope.jobId === "job-1" ? artifactRef.sourceDigest : null)
  const readReviewReceipt = vi.fn(async (_client: PoolClient, scope: AgentArtifactReviewReceiptScope): Promise<AgentArtifactReviewReceipt> => ({
    ...scope, toolCallId: "review-call-1",
  }))
  const input: SelectedJobArtifactFinalizationGuardInput = {
    client: currentClient,
    commandPort: makePort(readGraph),
    lease,
    root,
    selectedJobId: "job-1",
    acceptedGraphWitness: { revision: currentGraph.revision, nodes: currentGraph.nodes },
    readCurrentDraftHead: readDraftHead,
    readCurrentSourceDigest: readSourceDigest,
    readCurrentReviewReceipt: readReviewReceipt,
    ...overrides,
  }
  return { input, client: currentClient, currentGraph, readGraph, readDraftHead, readSourceDigest, readReviewReceipt }
}

describe("selected-job artifact finalization guard", () => {
  it("revalidates graph, source, draft head and receipt through the same transaction client", async () => {
    const state = fixture()

    await expect(selectedJobArtifactFinalizationGuard(state.input)).resolves.toEqual({ ok: true })
    expect(state.readGraph).toHaveBeenCalledWith(state.client, {
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: root.id, parentTaskId: root.id,
      turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: root.attemptCount,
    })
    expect(state.readDraftHead).toHaveBeenCalledWith(state.client, {
      userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1", artifactId: "draft-1",
    })
    expect(state.readSourceDigest).toHaveBeenCalledWith(state.client, { userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1" })
    expect(state.readReviewReceipt).toHaveBeenCalledWith(state.client, {
      userId: lease.userId, sessionId: lease.sessionId, jobId: "job-1", artifactId: "draft-1", version: 2,
      contentHash: artifactRef.contentHash, sourceDigest: artifactRef.sourceDigest, currentSourceDigest: artifactRef.sourceDigest,
      status: "passed", taskId: "task-reviewer", reviewHash,
    })
    expect(state.input.commandPort?.readCurrent).not.toHaveBeenCalled()
  })

  it.each([
    ["graph revision", graph(9)],
    ["graph projection", graph(8, `sha256:${"d".repeat(64)}`)],
    ["new runnable graph node", { ...graph(), nodes: [...graph().nodes, node({ key: "writer-next", templateId: "cover_letter_writer", status: "queued" })] }],
  ] as const)("blocks when the accepted %s changes before terminal writes", async (_change, latestGraph) => {
    const state = fixture({ commandPort: makePort(async () => latestGraph) })

    await expect(selectedJobArtifactFinalizationGuard(state.input)).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
    expect(state.readSourceDigest).not.toHaveBeenCalled()
    expect(state.readDraftHead).not.toHaveBeenCalled()
    expect(state.readReviewReceipt).not.toHaveBeenCalled()
  })

  it("fails closed without a transaction-bound graph reader or accepted witness", async () => {
    const noReader = fixture({ commandPort: makePort() })
    await expect(selectedJobArtifactFinalizationGuard(noReader.input)).resolves.toMatchObject({ ok: false })
    expect(noReader.input.commandPort?.readCurrent).not.toHaveBeenCalled()

    const noWitness = fixture({ acceptedGraphWitness: undefined })
    await expect(selectedJobArtifactFinalizationGuard(noWitness.input)).resolves.toMatchObject({ ok: false })
  })
})
