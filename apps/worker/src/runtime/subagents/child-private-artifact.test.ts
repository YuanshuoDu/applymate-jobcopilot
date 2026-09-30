import { describe, expect, it, vi } from "vitest"

import { createObservedEvidenceIndex, recordReadToolOutput } from "./child-evidence.js"
import { createChildPrivateArtifactDispatcher, createPrivateArtifactSafeStore } from "./child-private-artifact.js"
import type { SubagentLease } from "./types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { TurnEngineToolExecutor } from "../turns/turn-engine-types.js"
import type { ToolCallRequest, ToolExecutionResult } from "../tools/types.js"

const ref = {
  artifactId: "cover-letter:abc123", version: 1, contentHash: `sha256:${"1".repeat(64)}`, sourceDigest: `sha256:${"2".repeat(64)}`,
}

function lease(role: "writer" | "reviewer"): SubagentLease {
  return {
    id: `${role}-task`, userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    path: `/root-1/${role}-task`, depth: 1, role, taskType: role === "writer" ? "cover_letter_draft" : "cover_letter_review",
    status: "running", goal: "Prepare selected job artifact", constraints: [], successCriteria: [], allowedActions: [], context: {},
    expectedOutputSchema: {}, modelProfileSnapshot: {}, result: null, failureReason: null, attemptCount: 1, maxAttempts: 3,
    leaseOwner: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00Z"), interruptRequestedAt: null,
    budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
  }
}

function taskFence(value: SubagentLease) {
  return { taskId: value.id, userId: value.userId, sessionId: value.sessionId, turnId: value.turnId!, rootTaskId: value.rootTaskId, parentTaskId: value.parentTaskId, leaseOwner: value.ownerId, attemptCount: value.attemptCount }
}

function call(name: string, id: string, input: unknown = {}): ToolCallRequest {
  return { id, toolName: name, toolVersion: "1", input }
}

function executionInput(request: ToolCallRequest): Parameters<TurnEngineToolExecutor>[0] {
  return {
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    taskId: "reviewer-task", rootTaskId: "root-1", actorRole: "subagent", remainingTurnSteps: 5,
    signal: new AbortController().signal, capabilities: ["read", "review"], call: request,
  }
}

function persistenceStore(writes: unknown[]): TurnExecutionStore {
  return {
    startStep: async input => ({ id: input.stepId, ordinal: input.ordinal }), updateStep: async () => undefined,
    createItem: async input => { writes.push(input.content); return { id: input.itemId, revision: 0 } },
    updateItem: async input => { writes.push(input.content); return { id: input.itemId, revision: input.expectedRevision + 1 } },
    appendEvent: async input => { writes.push(input.payload); return { id: input.id } },
    appendEvents: async inputs => { writes.push(...inputs.map(input => input.payload)); return inputs.map(input => ({ id: input.id })) },
    recordFinalResponse: async input => { writes.push({ response: input.response, terminal: input.terminal }) },
  }
}

describe("private child artifact boundary", () => {
  it("redacts draft input content and stores only exact artifact refs in all item/event writes", async () => {
    const body = "private cover letter body"
    const writes: unknown[] = []
    const store = createPrivateArtifactSafeStore(persistenceStore(writes), new Set(["draft-call", "read-call", "review-call"]))
    await store.createItem({
      content: { toolCallId: "draft-call", toolName: "cover_letter.draft", input: { content: body, baseArtifactId: "base", constraints: { nested: [{ note: body }] } } },
    } as never)
    await store.updateItem({
      content: { toolCallId: "draft-call", toolName: "cover_letter.draft", output: { artifactRef: ref }, input: { content: body, constraints: { nested: body } } },
    } as never)
    await store.createItem({
      content: { toolCallId: "read-call", toolName: "artifact.version.read", output: { artifactRef: ref, content: body } },
    } as never)
    await store.appendEvent({
      payload: { content: { toolCallId: "review-call", toolName: "artifact.review", output: { artifactRef: ref, reviewHash: "private" } } },
    } as never)
    await store.appendEvents?.([{
      payload: { toolCallId: "read-call", toolName: "artifact.version.read", output: { artifactRef: ref, content: body } },
    } as never])

    const serialized = JSON.stringify(writes)
    expect(serialized).not.toContain(body)
    expect(writes[0]).toMatchObject({ toolCallId: "draft-call", toolName: "cover_letter.draft", input: { baseArtifactId: "base" } })
    expect(writes[0]).not.toHaveProperty("input.constraints")
    expect(writes[1]).toMatchObject({ output: { artifactRef: ref } })
    expect(writes[2]).toMatchObject({ output: { artifactRef: ref } })
    expect(writes[3]).toMatchObject({ content: { output: { artifactRef: ref } } })
    expect(writes[4]).toMatchObject({ output: { artifactRef: ref } })
  })

  it("suppresses nested draft constraints and unsafe review fields in in-progress and terminal projections", async () => {
    const secret = "PRIVATE source excerpt that must never persist in an event or item"
    const writes: unknown[] = []
    const store = createPrivateArtifactSafeStore(persistenceStore(writes), new Set(["review-call"]), { redactModelText: true })
    const draftInput = { content: secret, baseArtifactId: "base", baseHash: ref.contentHash, constraints: { nested: [{ note: secret }] } }
    const reviewInput = {
      artifactRef: ref,
      decision: "passed",
      findings: [{
        id: "john-smith", code: "john-smith", severity: "warning", message: secret, artifactHash: ref.contentHash,
        evidence: [{ artifactHash: ref.contentHash, path: secret, summary: secret }],
      }],
    }

    await store.createItem({
      type: "tool_call", status: "started", content: { toolCallId: "draft-call", toolName: "cover_letter.draft", input: draftInput },
    } as never)
    await store.appendEvent({
      type: "tool_call.started", payload: { toolCallId: "draft-call", toolName: "cover_letter.draft", input: draftInput },
    } as never)
    await store.updateItem({
      type: "tool_call", status: "completed", content: { toolCallId: "draft-call", toolName: "cover_letter.draft", input: draftInput, output: { artifactRef: ref } },
    } as never)
    await store.appendEvent({
      type: "tool_call.completed", payload: { toolCallId: "draft-call", toolName: "cover_letter.draft", input: draftInput, output: { artifactRef: ref } },
    } as never)

    await store.createItem({
      type: "tool_call", status: "started", content: { toolCallId: "review-call", toolName: "artifact.review", input: reviewInput },
    } as never)
    await store.appendEvents?.([{
      type: "tool_call.started", payload: { toolCallId: "review-call", toolName: "artifact.review", input: reviewInput },
    } as never])
    await store.updateItem({
      type: "tool_call", status: "completed", content: { toolCallId: "review-call", toolName: "artifact.review", input: reviewInput, output: { artifactRef: ref, status: "passed" } },
    } as never)
    await store.appendEvent({
      type: "tool_call.completed", payload: { toolCallId: "review-call", toolName: "artifact.review", input: reviewInput, output: { artifactRef: ref, status: "passed" } },
    } as never)

    const serialized = JSON.stringify(writes)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("john-smith")
    expect(serialized).not.toContain("constraints")
    expect(serialized).toContain(JSON.stringify({ artifactRef: ref }))
    expect(serialized).toContain("[Private selected-job response withheld]")
  })

  it("withholds selected-job Writer and Reviewer model text from items and events while preserving safe projections", async () => {
    const canary = "MALICIOUS_PRIVATE_LETTER_CANARY"
    const writes: unknown[] = []
    const store = createPrivateArtifactSafeStore(persistenceStore(writes), new Set(), { redactModelText: true })
    await store.createItem({
      type: "agent_message", phase: "commentary", content: { text: canary },
    } as never)
    await store.updateItem({
      phase: "final_answer", content: { text: canary, final: { response: canary } },
    } as never)
    await store.appendEvent({
      type: "task.item.completed", payload: { itemId: "final-item", content: { text: canary, final: { response: canary } } },
    } as never)
    await store.appendEvents?.([{
      type: "task.item.delta", payload: { itemId: "commentary-item", content: { text: canary } },
    } as never])
    await store.appendEvent({
      type: "task.artifact.reviewed", payload: { artifactRef: ref, status: "passed", reviewHash: `sha256:${"3".repeat(64)}` },
    } as never)
    await store.appendEvent({
      type: "task.finalized",
      payload: { nested: { terminal: { finalResponse: { response: canary }, finalContent: { text: canary, final: { response: canary } } } }, projection: { artifactRef: ref, reviewStatus: "passed" } },
    } as never)
    await store.appendEvents?.([{
      type: "task.finalized.batch",
      payload: { finalResponse: { response: canary }, projection: { artifactRef: ref, reviewStatus: "passed" } },
    } as never])
    await store.recordFinalResponse?.({
      response: canary,
      terminal: {
        finalResponse: { nestedNarrative: canary }, finalContent: canary,
        projection: { artifactRef: ref, reviewStatus: "passed", reviewHash: `sha256:${"3".repeat(64)}` },
      },
    } as never)

    const serialized = JSON.stringify(writes)
    expect(serialized).not.toContain(canary)
    expect(serialized).toContain("[Private selected-job response withheld]")
    expect(writes[4]).toMatchObject({ artifactRef: ref, status: "passed", reviewHash: `sha256:${"3".repeat(64)}` })
    expect(serialized).toContain(JSON.stringify({ artifactRef: ref, reviewStatus: "passed" }))
    expect(writes[7]).toMatchObject({
      response: "[Private selected-job response withheld]",
      terminal: {
        projection: { artifactRef: ref, reviewStatus: "passed", reviewHash: `sha256:${"3".repeat(64)}` },
        finalResponse: { nestedNarrative: "[Private selected-job response withheld]" },
        finalContent: "[Private selected-job response withheld]",
      },
    })
  })

  it("dispatches only role-bound private artifacts and requires the exact Writer read before review", async () => {
    const selectedJobPreparation = { jobId: "job-1", sourceDigest: ref.sourceDigest, evidenceRefs: ["job:job-1"] }
    const observedEvidence = createObservedEvidenceIndex()
    const privateCallIds = new Set<string>()
    const privateCalls: ToolCallRequest[] = []
    const reviewerLease = lease("reviewer")
    const exactDraftBody = "PRIVATE_EXACT_DRAFT_BODY_for_reviewer_only"
    const executePrivateTool = vi.fn(async (_context, request): Promise<ToolExecutionResult> => {
      privateCalls.push(request)
      return {
        ...request, status: "completed", errorCode: null,
        output: request.toolName === "artifact.version.read" ? { artifactRef: ref, content: exactDraftBody } : { artifactRef: ref },
      }
    })
    const executeRoutedTool = vi.fn(async (input: Parameters<TurnEngineToolExecutor>[0]) => ({ ...input.call, status: "completed" as const, errorCode: null }))
    const reviewer = createChildPrivateArtifactDispatcher({
      lease: reviewerLease,
      definitions: ["artifact.version.read", "artifact.review"].map(name => ({ name, version: "1" })),
      executeRoutedTool, executePrivateTool, selectedJobPreparation, taskFence: taskFence(reviewerLease), reviewerArtifactRef: ref, observedEvidence, privateCallIds,
    })

    const mismatched = await reviewer(executionInput(call("artifact.version.read", "wrong-ref", { artifactRef: { ...ref, version: 2 } })))
    expect(mismatched).toMatchObject({ status: "failed", errorCode: "private_artifact_read_unavailable" })
    expect(executePrivateTool).not.toHaveBeenCalled()

    const read = await reviewer(executionInput(call("artifact.version.read", "read-call", { artifactRef: ref })))
    expect(read).toMatchObject({ status: "completed", output: { artifactRef: ref, content: exactDraftBody } })
    const writes: unknown[] = []
    const safeStore = createPrivateArtifactSafeStore(persistenceStore(writes), privateCallIds)
    await safeStore.createItem({
      type: "tool_call", status: "completed", content: { toolCallId: "read-call", toolName: "artifact.version.read", output: read.output },
    } as never)
    expect(JSON.stringify(writes)).not.toContain(exactDraftBody)
    expect(writes[0]).toMatchObject({ toolCallId: "read-call", toolName: "artifact.version.read", output: { artifactRef: ref } })
    expect(writes[0]).not.toHaveProperty("output.content")
    recordReadToolOutput(observedEvidence, "artifact.version.read", read.output)
    const secret = "private reviewer excerpt must not reach artifact storage"
    const unsafeReview = await reviewer(executionInput(call("artifact.review", "unsafe-review-call", {
      artifactRef: ref, decision: "passed", findings: [{
        id: secret, code: secret, severity: "warning", message: secret, artifactHash: ref.contentHash,
        evidence: [{ artifactHash: ref.contentHash, path: secret, summary: secret }],
      }],
    })))
    expect(unsafeReview).toMatchObject({ status: "failed", errorCode: "private_artifact_review_input_invalid" })
    const reviewInput = {
      artifactRef: ref, decision: "passed", findings: [{
        id: "john-smith", code: "john-smith", severity: "info", message: "Clear", artifactHash: ref.contentHash,
        evidence: [{ artifactHash: ref.contentHash, path: "$.text", summary: "Opening is clear" }],
      }],
    }
    const review = await reviewer(executionInput(call("artifact.review", "review-call", reviewInput)))
    expect(review).toMatchObject({ status: "completed", output: { artifactRef: ref } })
    expect(executePrivateTool.mock.calls.at(-1)?.[1].input).toEqual(reviewInput)
    expect(executePrivateTool).toHaveBeenCalledTimes(2)
    expect(executePrivateTool.mock.calls[0]?.[0]).toMatchObject({
      scope: { userId: reviewerLease.userId }, sessionId: reviewerLease.sessionId, turnId: reviewerLease.turnId,
      taskId: reviewerLease.id, rootTaskId: reviewerLease.rootTaskId, taskFence: taskFence(reviewerLease),
    })
    expect(privateCallIds).toEqual(new Set(["wrong-ref", "read-call", "unsafe-review-call", "review-call"]))

    const writerLease = lease("writer")
    const writer = createChildPrivateArtifactDispatcher({
      lease: writerLease, definitions: [{ name: "cover_letter.draft", version: "1" }],
      executeRoutedTool, executePrivateTool, selectedJobPreparation, taskFence: taskFence(writerLease), observedEvidence, privateCallIds: new Set(),
    })
    const writerInput = { content: "letter", constraints: { nested: [{ note: "transient private constraint" }] } }
    const writerCall = await writer(executionInput(call("cover_letter.draft", "draft-call", writerInput)))
    expect(writerCall.status).toBe("completed")
    expect(executePrivateTool.mock.calls.at(-1)?.[0]).toMatchObject({ taskId: writerLease.id, taskFence: taskFence(writerLease) })
    expect(executePrivateTool.mock.calls.at(-1)?.[1].input).toEqual(writerInput)

    const noFence = createChildPrivateArtifactDispatcher({
      lease: writerLease, definitions: [{ name: "cover_letter.draft", version: "1" }],
      executeRoutedTool, executePrivateTool, selectedJobPreparation, observedEvidence, privateCallIds: new Set(),
    })
    await expect(noFence(executionInput(call("cover_letter.draft", "unfenced-draft", { content: "letter" }))))
      .resolves.toMatchObject({ status: "failed", errorCode: "task_fence_denied" })
    const denied = await reviewer(executionInput(call("application.submit", "submit-call")))
    expect(denied).toMatchObject({ status: "failed", errorCode: "child_action_denied" })
    expect(executeRoutedTool).not.toHaveBeenCalled()
  })
})
