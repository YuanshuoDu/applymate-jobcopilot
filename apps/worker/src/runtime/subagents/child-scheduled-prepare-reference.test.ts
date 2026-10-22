import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { canonicalJson } from "@jobcopilot/shared"

import type { ExecutionOwner } from "../execution-owner.js"
import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_READ_BYTES, prepareToolResultJson, type CanonicalToolSourceName, type ToolResultChunk, type ToolResultReadInput, type ToolResultReferenceRepository } from "../tools/tool-result-reference-types.js"
import { ROLE_RESULT_SCHEMA, type PrepareResult } from "./role-results.js"
import { createScheduledPrepareReferenceResolver, parseScheduledPrepareReference, resolveScheduledPrepareReference, resolveScheduledPrepareResumeEvidence, verifyScheduledPrepareReferenceSourceBinding, type VerifyScheduledPrepareSourceBindingInput } from "./child-scheduled-prepare-reference.js"

const TASK_ID = "subagent-00000000-0000-4000-8000-000000000001"
const ATTEMPT = 3
const REF = "tool-result-00000000-0000-4000-8000-000000000001"
const TOOL_CALL_ID = "prepare-call-1"
const SOURCE = "scheduled.application.prepare" as CanonicalToolSourceName
const owner: ExecutionOwner = {
  kind: "task",
  lease: {
    id: TASK_ID, userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: TASK_ID,
    parentTaskId: null, path: "root/prepare", depth: 1, role: "prepare", taskType: "scheduled-prepare",
    status: "running", goal: "prepare", constraints: [], successCriteria: [], allowedActions: [], context: {},
    expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: ATTEMPT, maxAttempts: 3,
    nextAttemptAt: null, leaseOwner: "worker-1", ownerId: "worker-1", leaseExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, signal: new AbortController().signal,
  },
}

function receipt(): PrepareResult {
  const jobs = Array.from({ length: 50 }, (_, index) => ({ jobId: `c${String(index + 1).padStart(24, "0")}`, status: "prepared" as const }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: TASK_ID,
    attemptCount: ATTEMPT, snapshotDigest: `sha256:${"a".repeat(64)}`, checkpointDigest: "b".repeat(64), jobs,
    materials: jobs.map((job, index) => ({ jobId: job.jobId, kind: "resume" as const, artifactRef: {
      artifactId: `scheduled-draft:${index.toString(16).padStart(64, "0")}`, version: 1,
      contentHash: `sha256:${"c".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}`,
    } })),
  }
}

function referenceFor(bytes: Buffer): { $ref: string; sizeBytes: number; sha256: string } {
  return { $ref: REF, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
}

type ChunkMutation = (chunk: ToolResultChunk, index: number) => unknown
function repositoryFor(bytes: Buffer, mutate?: ChunkMutation, chunkSize = 3200) {
  const readOffsets: number[] = []
  const repository: ToolResultReferenceRepository = {
    put: vi.fn(async () => { throw new Error("unused") }),
    read: vi.fn(async (_readOwner, input: ToolResultReadInput, _toolCallId?: string) => {
      const offset = input.cursor === undefined ? 0 : Number(input.cursor)
      readOffsets.push(offset)
      const end = Math.min(bytes.length, offset + chunkSize)
      const chunk: ToolResultChunk = {
        ref: REF, sha256: referenceFor(bytes).sha256, byteCount: bytes.length,
        chunk: bytes.subarray(offset, end).toString("utf8"), nextCursor: end === bytes.length ? null : String(end),
      }
      return (mutate ? mutate(chunk, readOffsets.length - 1) : chunk) as ToolResultChunk | null
    }),
  }
  return { repository, readOffsets }
}

function input(output: unknown, repository: ToolResultReferenceRepository,
  verifySourceBinding: (binding: VerifyScheduledPrepareSourceBindingInput) => boolean | Promise<boolean> = async () => true) {
  return { output, repository, owner, originalToolCallId: TOOL_CALL_ID, expectedTaskId: TASK_ID, expectedAttemptCount: ATTEMPT, verifySourceBinding }
}

describe("scheduled Prepare durable references", () => {
  it("resolves a canonical receipt larger than 8 KiB from sequential owner-fenced chunks", async () => {
    const prepared = prepareToolResultJson(receipt(), SOURCE, TASK_ID)
    const bytes = Buffer.from(prepared.encoded, "utf8")
    const reference = referenceFor(bytes)
    const { repository, readOffsets } = repositoryFor(bytes)

    const verifySourceBinding = vi.fn(async () => true)
    const resolved = await resolveScheduledPrepareReference(input(reference, repository, verifySourceBinding))

    expect(bytes.length).toBeGreaterThan(8 * 1024)
    expect(resolved.result).toEqual(receipt())
    expect(resolved.reference).toEqual(reference)
    expect(readOffsets.length).toBeGreaterThan(2)
    expect(readOffsets[0]).toBe(0)
    expect(readOffsets.every((offset, index) => index === 0 || offset === readOffsets[index - 1]! + 3200)).toBe(true)
    expect(repository.read).toHaveBeenNthCalledWith(1, owner, { referenceId: REF })
    expect(repository.read).toHaveBeenNthCalledWith(2, owner, { referenceId: REF, cursor: "3200" })
    expect(verifySourceBinding).toHaveBeenCalledWith({ owner, reference, originalToolCallId: TOOL_CALL_ID,
      expectedTaskId: TASK_ID, expectedAttemptCount: ATTEMPT })
  })

  it("rejects malformed reference envelopes before reading", () => {
    for (const malformed of [
      { $ref: REF, sizeBytes: 1, sha256: "f".repeat(64), extra: true },
      { $ref: "tool-result-not-a-uuid", sizeBytes: 1, sha256: "f".repeat(64) },
      { $ref: REF, sizeBytes: MAX_TOOL_RESULT_BYTES + 1, sha256: "f".repeat(64) },
      { $ref: REF, sizeBytes: 1, sha256: "F".repeat(64) },
    ]) expect(() => parseScheduledPrepareReference(malformed)).toThrow("scheduled_prepare_reference_invalid")
  })

  it.each([
    ["missing chunk", (_chunk: ToolResultChunk) => null],
    ["wrong reference", (chunk: ToolResultChunk) => ({ ...chunk, ref: "tool-result-00000000-0000-4000-8000-000000000099" })],
    ["wrong hash", (chunk: ToolResultChunk) => ({ ...chunk, sha256: "e".repeat(64) })],
    ["wrong total byte count", (chunk: ToolResultChunk) => ({ ...chunk, byteCount: chunk.byteCount - 1 })],
    ["skipped cursor", (chunk: ToolResultChunk) => ({ ...chunk, nextCursor: String(Number(chunk.nextCursor) + 1) })],
    ["invalid UTF-8 string", (chunk: ToolResultChunk) => ({ ...chunk, chunk: "\uD800" })],
    ["oversized chunk", (chunk: ToolResultChunk) => ({ ...chunk, chunk: "x".repeat(MAX_TOOL_RESULT_READ_BYTES + 1) })],
  ])("fails closed for %s", async (_name, mutation) => {
    const bytes = Buffer.from(prepareToolResultJson(receipt(), SOURCE, TASK_ID).encoded, "utf8")
    const { repository } = repositoryFor(bytes, (chunk, index) => index === 0 ? mutation(chunk) : chunk)
    await expect(resolveScheduledPrepareReference(input(referenceFor(bytes), repository))).rejects.toThrow("scheduled_prepare_reference_invalid")
  })

  it("rejects a repeated chunk response and non-canonical JSON", async () => {
    const bytes = Buffer.from(prepareToolResultJson(receipt(), SOURCE, TASK_ID).encoded, "utf8")
    let first: ToolResultChunk | undefined
    const repeated = repositoryFor(bytes, (chunk, index) => {
      if (index === 0) first = chunk
      return index === 1 ? first! : chunk
    })
    await expect(resolveScheduledPrepareReference(input(referenceFor(bytes), repeated.repository))).rejects.toThrow("scheduled_prepare_reference_invalid")

    const nonCanonical = Buffer.from(JSON.stringify(receipt()), "utf8")
    const { repository } = repositoryFor(nonCanonical)
    await expect(resolveScheduledPrepareReference(input(referenceFor(nonCanonical), repository))).rejects.toThrow("scheduled_prepare_reference_invalid")
  })

  it("bounds repository reads when a malformed source returns tiny chunks", async () => {
    const bytes = Buffer.from(prepareToolResultJson(receipt(), SOURCE, TASK_ID).encoded, "utf8")
    const { repository } = repositoryFor(bytes, undefined, 1)
    await expect(resolveScheduledPrepareReference(input(referenceFor(bytes), repository))).rejects.toThrow("scheduled_prepare_reference_invalid")
    expect(repository.read).toHaveBeenCalledTimes(Math.ceil(MAX_TOOL_RESULT_BYTES / (MAX_TOOL_RESULT_READ_BYTES / 2)))
  })

  it("rejects a source-call mismatch or prior source attempt before reading chunks", async () => {
    const bytes = Buffer.from(prepareToolResultJson(receipt(), SOURCE, TASK_ID).encoded, "utf8")
    const reference = referenceFor(bytes)
    const { repository } = repositoryFor(bytes)
    const verifySourceBinding = async (binding: { originalToolCallId: string; expectedAttemptCount: number }) =>
      binding.originalToolCallId === TOOL_CALL_ID && binding.expectedAttemptCount === ATTEMPT
    await expect(resolveScheduledPrepareReference({ ...input(reference, repository, verifySourceBinding), originalToolCallId: "other-call" }))
      .rejects.toThrow("scheduled_prepare_reference_invalid")
    await expect(resolveScheduledPrepareReference({ ...input(reference, repository, verifySourceBinding), expectedAttemptCount: ATTEMPT - 1 }))
      .rejects.toThrow("scheduled_prepare_reference_invalid")
    expect(repository.read).not.toHaveBeenCalled()
  })

  it("checks the exact persisted call, result marker, and active owner inside tenant-scoped RLS", async () => {
    const bytes = Buffer.from(prepareToolResultJson(receipt(), SOURCE, TASK_ID).encoded, "utf8")
    const reference = referenceFor(bytes)
    const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.includes('FROM "agent_tool_result_references"')
      ? [{ id: REF, byteCount: bytes.length, sha256: reference.sha256, stepAttempt: ATTEMPT }] : [] }))
    const release = vi.fn()
    const pool = { connect: vi.fn(async () => ({ query, release })) } as never

    await expect(verifyScheduledPrepareReferenceSourceBinding(pool, {
      owner, reference, originalToolCallId: TOOL_CALL_ID, expectedTaskId: TASK_ID, expectedAttemptCount: ATTEMPT,
    })).resolves.toBe(true)

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", "SELECT set_config('app.user_id', $1, true)", expect.stringContaining('FROM "agent_tool_result_references"'), "COMMIT",
    ])
    expect(query.mock.calls[1]?.[1]).toEqual(["user-1"])
    expect(query.mock.calls[2]?.[1]).toEqual([
      REF, "user-1", "session-1", "turn-1", TASK_ID, TOOL_CALL_ID, bytes.length, ATTEMPT,
      reference.sha256, TASK_ID, "worker-1", JSON.stringify(reference),
    ])
    expect(query.mock.calls[2]?.[0]).toContain('result."content"->\'output\' = $12::jsonb')
    expect(query.mock.calls[2]?.[0]).toContain('call."content"->\'input\' = \'{}\'::jsonb')
    expect(query.mock.calls[2]?.[0]).toContain('result."content"->\'errorCode\' = \'null\'::jsonb')
    expect(release).toHaveBeenCalledOnce()
  })

  it("wires the production source verifier before owner-fenced chunk reads", async () => {
    const bytes = Buffer.from(prepareToolResultJson(receipt(), SOURCE, TASK_ID).encoded, "utf8")
    const reference = referenceFor(bytes), { repository } = repositoryFor(bytes)
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM "agent_tool_result_references"')
      ? [{ id: REF, byteCount: bytes.length, sha256: reference.sha256, stepAttempt: ATTEMPT }] : [] }))
    const client = { query, release: vi.fn() }, pool = { connect: async () => client } as never
    const resolver = createScheduledPrepareReferenceResolver(pool, repository, owner)

    const result = await resolver({ output: reference, originalToolCallId: TOOL_CALL_ID, expectedTaskId: TASK_ID, expectedAttemptCount: ATTEMPT })

    expect(result.result).toEqual(receipt())
    expect(repository.read).toHaveBeenCalledWith(owner, { referenceId: REF })
    expect(query).toHaveBeenCalledWith("SELECT set_config('app.user_id', $1, true)", ["user-1"])
  })

  it("rejects absent durable rows and stale attempts before hydrating chunks", async () => {
    const bytes = Buffer.from(prepareToolResultJson(receipt(), SOURCE, TASK_ID).encoded, "utf8")
    const reference = referenceFor(bytes)
    const query = vi.fn(async () => ({ rows: [] }))
    const connect = vi.fn(async () => ({ query, release: vi.fn() }))
    const pool = { connect } as unknown as Parameters<typeof verifyScheduledPrepareReferenceSourceBinding>[0]
    const binding = { owner, reference, originalToolCallId: TOOL_CALL_ID, expectedTaskId: TASK_ID, expectedAttemptCount: ATTEMPT }
    await expect(verifyScheduledPrepareReferenceSourceBinding(pool, binding)).resolves.toBe(false)
    expect(query).toHaveBeenLastCalledWith("ROLLBACK")

    const stale = await verifyScheduledPrepareReferenceSourceBinding(pool, { ...binding, expectedAttemptCount: ATTEMPT - 1 })
    expect(stale).toBe(false)
    expect(connect).toHaveBeenCalledOnce()
  })

  it("keeps a stale prior marker in history but excludes it from current-attempt evidence", async () => {
    const bytes = Buffer.from(prepareToolResultJson(receipt(), SOURCE, TASK_ID).encoded, "utf8")
    const reference = referenceFor(bytes)
    const observations = [{ id: "child-resume:prior", content: {
      toolCallId: TOOL_CALL_ID, toolName: "scheduled.application.prepare", input: {}, status: "completed", output: reference, errorCode: null,
    } }]
    const resolver = vi.fn(async () => { throw new Error("stale source attempt") })
    const evidence = await resolveScheduledPrepareResumeEvidence(observations, resolver, TASK_ID, ATTEMPT)

    expect(evidence).toEqual([])
    expect(resolver).toHaveBeenCalledWith({ output: reference, originalToolCallId: TOOL_CALL_ID, expectedTaskId: TASK_ID, expectedAttemptCount: ATTEMPT })
    expect(observations[0]?.content.output).toEqual(reference)
  })

  it("rejects stale task and attempt identities and unsafe Prepare fields", async () => {
    const staleTask = { ...receipt(), taskId: "subagent-00000000-0000-4000-8000-000000000002" }
    const staleAttempt = { ...receipt(), attemptCount: ATTEMPT - 1 }
    const unsafe = { ...receipt(), privateBody: "must not persist" }
    const unsafeJson = canonicalJson(unsafe)
    const inputs = [
      Buffer.from(prepareToolResultJson(staleTask, SOURCE, staleTask.taskId).encoded, "utf8"),
      Buffer.from(prepareToolResultJson(staleAttempt, SOURCE, TASK_ID).encoded, "utf8"),
      Buffer.from(unsafeJson, "utf8"),
    ]
    for (const bytes of inputs) {
      const { repository } = repositoryFor(bytes)
      await expect(resolveScheduledPrepareReference(input(referenceFor(bytes), repository))).rejects.toThrow("scheduled_prepare_reference_invalid")
    }
  })
})
