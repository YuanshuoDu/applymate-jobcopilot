import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { canonicalJson } from "@jobcopilot/shared"
import { describe, expect, it, vi } from "vitest"

import { MAX_TOOL_RESULT_BYTES, prepareToolResultJson, type CanonicalToolSourceName } from "../tools/tool-result-reference-types.js"
import { ROLE_RESULT_SCHEMA, type PrepareResult } from "./role-results.js"
import { verifyScheduledPrepareToolResultReference } from "./scheduled-prepare-tool-result-verification.js"

const PREPARE_TOOL = "scheduled.application.prepare" as CanonicalToolSourceName
const taskId = "subagent-12345678-1234-4234-9234-123456789012"
const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId,
  attemptCount: 2,
}
const finishMode = { phase: "finish" as const, ownerId: "worker-owner-1" }
const stepId = "step-prepare-1"
const toolCallId = "call-prepare-1"

function largePrepareResult(): PrepareResult {
  const jobs = Array.from({ length: 50 }, (_, index) => ({
    jobId: "c" + index.toString(36).padStart(24, "0"),
    status: "prepared" as const,
  }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "prepare",
    status: "completed",
    taskId,
    attemptCount: scope.attemptCount,
    snapshotDigest: "sha256:" + "a".repeat(64),
    checkpointDigest: "b".repeat(64),
    jobs,
    materials: jobs.map((job, index) => ({
      jobId: job.jobId,
      kind: "resume" as const,
      artifactRef: {
        artifactId: "scheduled-draft:" + index.toString(16).padStart(64, "0"),
        version: 1,
        contentHash: "sha256:" + "c".repeat(64),
        sourceDigest: "sha256:" + "d".repeat(64),
      },
    })),
  }
}

function referenceRow(result: PrepareResult) {
  const prepared = prepareToolResultJson(result, PREPARE_TOOL, taskId)
  return {
    id: "tool-result-12345678-1234-4234-9234-123456789012",
    userId: scope.userId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    stepId,
    taskId,
    toolCallId,
    sanitizedJson: prepared.value,
    sha256: prepared.sha256,
    byteCount: prepared.bytes,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    currentRootTaskId: scope.rootTaskId,
    currentAttemptCount: scope.attemptCount,
    currentTaskStatus: "running",
    currentTaskFailureReason: null,
    currentLeaseOwner: finishMode.ownerId,
    currentLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    currentInterruptRequestedAt: null,
    leaseCheckedAt: new Date("2098-12-31T00:00:00.000Z"),
    currentStepAttempt: scope.attemptCount,
    sourceCallItemId: "tool-item-prepare-1",
    sourceCallStepId: stepId,
    sourceCallTaskId: taskId,
    sourceCallType: "tool_call",
    sourceCallStatus: "completed",
    sourceCallContent: {
      toolCallId, toolName: "scheduled.application.prepare", toolVersion: "1", input: {}, status: "completed", errorCode: null,
    },
  }
}

function referenceFor(row: { id: string; byteCount: number; sha256: string }) {
  return { $ref: row.id, sizeBytes: row.byteCount, sha256: row.sha256 }
}

function clientFor(row: unknown) {
  const query = vi.fn(async () => ({ rows: [row] }))
  return { client: { query } as never, query }
}

describe("scheduled Prepare durable tool result verification", () => {
  it("resolves a large result only through its exact owner, task, attempt, step, and call reference", async () => {
    const expected = largePrepareResult()
    const row = referenceRow(expected)
    const { client, query } = clientFor(row)

    expect(Buffer.byteLength(canonicalJson(expected), "utf8")).toBeGreaterThan(8 * 1024)
    expect(row.byteCount).toBeLessThan(MAX_TOOL_RESULT_BYTES)
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(row), scope, mode: finishMode, stepId, toolCallId, expectedResult: expected,
    })).resolves.toEqual(expected)

    expect(query).toHaveBeenCalledOnce()
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]]
    for (const predicate of [
      'ref."id" = $1', 'ref."userId" = $2', 'ref."sessionId" = $3',
      'ref."turnId" = $4', 'ref."taskId" = $5', 'ref."stepId" = $6',
      'ref."toolCallId" = $7', 'task."attemptCount" = $9', 'step."attempt" = $9',
      'task."status" = \'running\'', 'task."leaseOwner" = $10', 'task."leaseExpiresAt" > clock_timestamp()',
      'task."interruptRequestedAt" IS NULL', "FOR UPDATE OF task",
      "call.\"content\"->>'toolCallId' = ref.\"toolCallId\"",
      "call.\"content\"->>'toolName' = 'scheduled.application.prepare'",
    ]) expect(sql).toContain(predicate)
    expect(values).toEqual([
      row.id, scope.userId, scope.sessionId, scope.turnId, taskId, stepId, toolCallId,
      scope.rootTaskId, scope.attemptCount, finishMode.ownerId,
    ])
  })

  it.each([
    ["user owner", { userId: "user-other" }],
    ["session owner", { sessionId: "session-other" }],
    ["Turn owner", { turnId: "turn-other" }],
    ["task", { taskId: "subagent-fedcbafe-dcba-4abc-8def-fedcbafedcba" }],
    ["reference ID", { id: "tool-result-fedcbafe-dcba-4abc-8def-fedcbafedcba" }],
    ["step", { stepId: "step-other" }],
    ["tool call", { toolCallId: "call-other" }],
    ["root owner", { currentRootTaskId: "root-other" }],
    ["attempt", { currentAttemptCount: scope.attemptCount + 1 }],
    ["lease owner", { currentLeaseOwner: "worker-other" }],
    ["expired owner lease", {
      currentLeaseExpiresAt: new Date("2098-12-30T00:00:00.000Z"),
    }],
    ["interrupted task", { currentInterruptRequestedAt: new Date("2098-12-30T00:00:00.000Z") }],
    ["prior step attempt", { currentStepAttempt: scope.attemptCount - 1 }],
    ["source call", { sourceCallContent: { toolCallId, toolName: "notes.read", toolVersion: "1", input: {}, status: "completed", errorCode: null } }],
    ["source call attempt binding", { sourceCallStepId: "step-prior-attempt" }],
    ["hash", { sha256: "0".repeat(64) }],
    ["size", { byteCount: 1 }],
  ] as const)("rejects a reference with a mismatched %s fence", async (_label, override) => {
    const expected = largePrepareResult()
    const row = { ...referenceRow(expected), ...override }
    const { client } = clientFor(row)
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(referenceRow(expected)), scope, mode: finishMode, stepId, toolCallId, expectedResult: expected,
    })).resolves.toBeNull()
  })

  it("rejects a stale owner supplied by the finisher even when the stored lease is otherwise live", async () => {
    const expected = largePrepareResult()
    const row = referenceRow(expected)
    const { client } = clientFor(row)
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(row), scope, mode: { phase: "finish", ownerId: "stale-worker-owner" },
      stepId, toolCallId, expectedResult: expected,
    })).resolves.toBeNull()
  })

  it("rejects malformed envelopes before querying and rejects receipts outside the byte limit", async () => {
    const row = referenceRow(largePrepareResult())
    const { client, query } = clientFor(row)
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: { ...referenceFor(row), extra: true }, scope, mode: finishMode, stepId, toolCallId, expectedResult: largePrepareResult(),
    })).resolves.toBeNull()
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: { ...referenceFor(row), sizeBytes: MAX_TOOL_RESULT_BYTES + 1 }, scope, mode: finishMode, stepId, toolCallId,
      expectedResult: largePrepareResult(),
    })).resolves.toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it("rejects a correctly hashed row whose Prepare shape contains an unauthorized field", async () => {
    const expected = largePrepareResult()
    const row = referenceRow(expected)
    const unsafe = { ...expected, privateBody: "must not persist" }
    const encoded = canonicalJson(unsafe)
    const invalidRow = {
      ...row,
      sanitizedJson: unsafe,
      sha256: createHash("sha256").update(encoded, "utf8").digest("hex"),
      byteCount: Buffer.byteLength(encoded, "utf8"),
    }
    const { client } = clientFor(invalidRow)
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(invalidRow), scope, mode: finishMode, stepId, toolCallId, expectedResult: expected,
    })).resolves.toBeNull()
  })

  it("rejects a result that differs from the expected attempt or receipt", async () => {
    const expected = largePrepareResult()
    const row = referenceRow(expected)
    const { client } = clientFor(row)
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(row), scope: { ...scope, attemptCount: scope.attemptCount + 1 }, mode: finishMode,
      stepId, toolCallId, expectedResult: expected,
    })).resolves.toBeNull()
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(row), scope, mode: finishMode, stepId, toolCallId,
      expectedResult: { ...expected, snapshotDigest: "sha256:" + "f".repeat(64) },
    })).resolves.toBeNull()
  })

  it("resolves only an exact completed receipt after Worker restart, with the lease cleared", async () => {
    const expected = largePrepareResult(), original = referenceRow(expected)
    const completed = { ...original, currentTaskStatus: "completed", currentLeaseOwner: null, currentLeaseExpiresAt: null }
    const { client, query } = clientFor(completed)
    const mode = { phase: "persisted_gate" as const }
    expect(Buffer.byteLength(canonicalJson(expected), "utf8")).toBeGreaterThan(8 * 1024)
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(original), scope, mode, stepId, toolCallId, expectedResult: expected,
    })).resolves.toEqual(expected)
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain(`task."status" = 'completed'`)
    expect(sql).toContain('task."failureReason" IS NULL')
    expect(sql).toContain('task."leaseOwner" IS NULL')
    expect(sql).toContain('task."leaseExpiresAt" IS NULL')
    expect(sql).not.toContain("FOR UPDATE OF task")
    expect(values).toEqual([original.id, scope.userId, scope.sessionId, scope.turnId, taskId, stepId,
      toolCallId, scope.rootTaskId, scope.attemptCount])

    for (const invalid of [
      { ...completed, currentTaskStatus: "running" },
      { ...completed, currentTaskFailureReason: "failed" },
      { ...completed, currentLeaseOwner: "still-owned" },
      { ...completed, currentLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z") },
    ]) {
      query.mockResolvedValueOnce({ rows: [invalid] })
      await expect(verifyScheduledPrepareToolResultReference(client, {
        reference: referenceFor(original), scope, mode, stepId, toolCallId, expectedResult: expected,
      })).resolves.toBeNull()
    }
    query.mockResolvedValueOnce({ rows: [completed] })
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(original), scope, mode, stepId, toolCallId: "other-call", expectedResult: expected,
    })).resolves.toBeNull()
    query.mockResolvedValueOnce({ rows: [completed] })
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: { ...referenceFor(original), sha256: "e".repeat(64) }, scope, mode, stepId, toolCallId, expectedResult: expected,
    })).resolves.toBeNull()
  })

  it("does not infer completed Gate verification from an omitted mode", async () => {
    const expected = largePrepareResult(), original = referenceRow(expected)
    const { client, query } = clientFor({ ...original, currentTaskStatus: "completed", currentLeaseOwner: null, currentLeaseExpiresAt: null })
    await expect(verifyScheduledPrepareToolResultReference(client, {
      reference: referenceFor(original), scope, mode: undefined as never, stepId, toolCallId, expectedResult: expected,
    })).resolves.toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
})
