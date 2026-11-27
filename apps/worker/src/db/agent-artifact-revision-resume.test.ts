import { describe, expect, it, vi } from "vitest"
import { hasExactCorrectionDraftResumeReceiptWithClient } from "./agent-artifact-revision-resume.js"

const input = () => ({
  taskFence: {
    taskId: "writer-task", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a",
    parentTaskId: "root-a", leaseOwner: "worker-a", attemptCount: 2,
  },
  jobId: "job-a", artifactId: "draft-a", predecessorVersion: 2, predecessorContentHash: "hash-v2",
  sourceDigest: "source-a", liveHeadVersion: 3, liveHeadHash: "hash-v3",
})

const evidence = () => ({
  artifactId: "draft-a", version: 3, userId: "user-a", sessionId: "session-a", jobId: "job-a",
  artifactType: "cover_letter", contentHash: "hash-v3", sourceDigest: "source-a", previousHash: "hash-v2",
  baseId: "base-a", baseHash: "base-hash", taskId: "writer-task", toolCallId: "draft-call",
  sessionUserId: "user-a", taskSessionId: "session-a", taskTurnId: "turn-a", taskRootTaskId: "root-a",
  taskParentTaskId: "root-a", taskRole: "writer", taskType: "cover_letter_draft", taskStatus: "running",
  taskLeaseOwner: "worker-a", taskAttemptCount: 2, taskInterruptRequestedAt: null, taskLeaseLive: true,
  headVersion: 3, headHash: "hash-v3", callStepId: "step-a", callAttempt: 1, resultStepId: "step-a", resultAttempt: 1,
  callItemId: "call-item", callRevision: 1, callItemStatus: "completed", callToolCallId: "draft-call",
  callToolName: "cover_letter.draft", callStatus: "completed", callErrorCode: null, callInputPresent: true,
  callBaseId: "base-a", callBaseHash: "base-hash", resultItemId: "result-item", resultRevision: 1,
  resultItemStatus: "completed", resultToolCallId: "draft-call", resultHasErrorCode: true, resultErrorCode: null,
  resultArtifactRef: { artifactId: "draft-a", version: 3, contentHash: "hash-v3", sourceDigest: "source-a" },
})

function reader(rows: readonly Record<string, unknown>[]) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      return { rows, rowCount: rows.length }
    }),
  }
  return { client, calls }
}

describe("exact correction draft resume receipt", () => {
  it("accepts one task-owned immediate successor with its completed earlier-attempt pair", async () => {
    const { client, calls } = reader([evidence()])

    await expect(hasExactCorrectionDraftResumeReceiptWithClient(client as never, input())).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.values).toEqual([
      "writer-task", "user-a", "session-a", "turn-a", "root-a", "root-a", "worker-a", 2,
      "job-a", "draft-a", 2, "hash-v2", "source-a", 3, "hash-v3",
    ])
    expect(calls[0]?.sql).toContain('call_item."content"->\'input\'->>\'baseArtifactId\'')
    expect(calls[0]?.sql).toContain('call_step."attempt"<$8')
    expect(calls[0]?.sql).toContain('result_item."content"->\'output\'->\'artifactRef\'')
    expect(calls[0]?.sql).not.toContain('version_row."content"')
    expect(JSON.stringify(await hasExactCorrectionDraftResumeReceiptWithClient(client as never, input()))).not.toContain("PRIVATE")
  })

  it.each([
    ["foreign writer", { taskId: "other-task" }],
    ["foreign user", { userId: "other-user" }],
    ["foreign session", { taskSessionId: "other-session" }],
    ["foreign turn", { taskTurnId: "other-turn" }],
    ["foreign root", { taskRootTaskId: "other-root" }],
    ["foreign parent", { taskParentTaskId: "other-parent" }],
    ["wrong writer role", { taskRole: "reviewer" }],
    ["wrong task type", { taskType: "other-task-type" }],
    ["stale writer lease", { taskLeaseLive: false }],
    ["changed lease owner", { taskLeaseOwner: "other-worker" }],
    ["interrupted writer", { taskInterruptRequestedAt: new Date() }],
    ["wrong attempt", { taskAttemptCount: 3 }],
    ["non-running writer", { taskStatus: "completed" }],
    ["not the immediate version", { version: 4, headVersion: 4 }],
    ["foreign source", { sourceDigest: "source-b" }],
    ["wrong predecessor chain", { previousHash: "other-hash" }],
    ["head mismatch", { headHash: "other-hash" }],
    ["different artifact", { artifactId: "other-artifact" }],
    ["different base", { callBaseId: "other-base" }],
    ["missing call input", { callInputPresent: false }],
    ["wrong call name", { callToolName: "artifact.review" }],
    ["failed call item", { callItemStatus: "failed" }],
    ["failed call result", { callStatus: "failed" }],
    ["call error", { callErrorCode: "tool_execution_failed" }],
    ["result item error", { resultErrorCode: "tool_execution_failed" }],
    ["failed result item", { resultItemStatus: "failed" }],
    ["wrong call identity", { callToolCallId: "other-call" }],
    ["wrong result identity", { resultToolCallId: "other-call" }],
    ["different step", { resultStepId: "other-step" }],
    ["current-attempt pair", { callAttempt: 2, resultAttempt: 2 }],
    ["wrong artifact reference", { resultArtifactRef: { artifactId: "draft-a", version: 2, contentHash: "hash-v2", sourceDigest: "source-a" } }],
  ])("denies %s", async (_name, patch) => {
    const { client } = reader([{ ...evidence(), ...patch }])
    await expect(hasExactCorrectionDraftResumeReceiptWithClient(client as never, input())).resolves.toBe(false)
  })

  it("denies absent or ambiguous pairs and does not query a first attempt", async () => {
    const missing = reader([])
    await expect(hasExactCorrectionDraftResumeReceiptWithClient(missing.client as never, input())).resolves.toBe(false)
    const ambiguous = reader([evidence(), evidence()])
    await expect(hasExactCorrectionDraftResumeReceiptWithClient(ambiguous.client as never, input())).resolves.toBe(false)
    const firstAttempt = reader([evidence()])
    await expect(hasExactCorrectionDraftResumeReceiptWithClient(firstAttempt.client as never, {
      ...input(), taskFence: { ...input().taskFence, attemptCount: 1 },
    })).resolves.toBe(false)
    expect(firstAttempt.client.query).not.toHaveBeenCalled()
  })
})
