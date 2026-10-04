import { Value } from "@sinclair/typebox/value"
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { canonicalJson, redactSensitiveValue } from "@jobcopilot/shared"

import type { ExecutionOwner } from "../execution-owner.js"
import type { ToolExecutionContext } from "./types.js"
import { createToolResultsReadTool } from "./tool-results-read-tool.js"
import { prepareToolResultJson, ToolResultSanitizationError, verifyToolResultSanitization, type CanonicalToolSourceName, type ToolResultChunk, type ToolResultReferenceRepository } from "./tool-result-reference-types.js"

const owner = {
  kind: "turn" as const,
  taskId: "root-1",
  lease: {
    turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
    leaseStartedAt: new Date("2026-09-08T02:59:00Z"), leaseExpiresAt: new Date("2099-01-01T00:00:00Z"),
  },
} satisfies ExecutionOwner

const context: ToolExecutionContext = {
  scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "root-1", toolCallId: "read-call-1",
  signal: new AbortController().signal, capabilities: ["read"], reportProgress: vi.fn(async () => undefined),
}

describe("tool result reference runtime contract", () => {
  it("canonicalizes source-sanitized bytes and verifies the stored digest before read", () => {
    const id = "00000000-0000-4000-8000-000000000001"
    const source = "jobs.search" as CanonicalToolSourceName
    const prepared = prepareToolResultJson({ jobs: [{ id, nested: { id } }], page: 1, hasMore: false }, source)
    expect(prepared.value).toEqual({ jobs: [{ id, nested: { id: "[REDACTED_PHONE]" } }], page: 1, hasMore: false })
    expect(prepared.bytes).toBe(Buffer.byteLength(prepared.encoded, "utf8"))
    expect(prepared.sha256).toBe(createHash("sha256").update(prepared.encoded, "utf8").digest("hex"))
    expect(verifyToolResultSanitization({
      id: "tool-result-ref", userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "root-1", toolCallId: "call-1",
      sanitizedJson: prepared.value, sha256: prepared.sha256, byteCount: prepared.bytes, createdAt: new Date(0), updatedAt: new Date(0),
    }, source)).toEqual(prepared.value)
    expect(() => verifyToolResultSanitization({
      id: "tool-result-ref", userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "root-1", toolCallId: "call-1",
      sanitizedJson: prepared.value, sha256: "0".repeat(64), byteCount: prepared.bytes, createdAt: new Date(0), updatedAt: new Date(0),
    }, source)).toThrowError(ToolResultSanitizationError)
    expect(canonicalJson(prepared.value)).toBe(prepared.encoded)
  })

  it("reads only exact generic-redacted legacy bytes and rejects unsanitized legacy bytes", () => {
    const source = "jobs.search" as CanonicalToolSourceName
    const raw = { jobs: [{ id: "00000000-0000-4000-8000-000000000001", description: "legacy@example.com" }], page: 1, hasMore: false }
    const legacy = redactSensitiveValue(raw)
    const encoded = canonicalJson(legacy)
    const row = {
      id: "tool-result-legacy", userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "root-1", toolCallId: "call-1",
      sanitizedJson: legacy, sha256: createHash("sha256").update(encoded, "utf8").digest("hex"), byteCount: Buffer.byteLength(encoded), createdAt: new Date(0), updatedAt: new Date(0),
    }
    expect(verifyToolResultSanitization(row, source)).toEqual(legacy)
    expect(JSON.stringify(legacy)).not.toContain("00000000-0000-4000-8000-000000000001")
    expect(() => verifyToolResultSanitization({ ...row, sanitizedJson: raw, sha256: createHash("sha256").update(canonicalJson(raw)).digest("hex"), byteCount: Buffer.byteLength(canonicalJson(raw)) }, source))
      .toThrowError(expect.objectContaining({ code: "tool_result_corrupt" }))
  })

  it("keeps the declared chunk type aligned with the registered read schema", async () => {
    const chunk: ToolResultChunk = { ref: "ref-1", sha256: "a".repeat(64), byteCount: 16, chunk: '{"ok":true}', nextCursor: null }
    const repository: ToolResultReferenceRepository = { put: vi.fn(), read: vi.fn(async () => chunk) }
    const resolveOwner = vi.fn(() => owner)
    const tool = createToolResultsReadTool(repository, resolveOwner)

    const result = await tool.execute(context, { referenceId: "ref-1" })

    expect(Value.Check(tool.outputSchema, result)).toBe(true)
    expect(result).toEqual(chunk)
    expect(resolveOwner).toHaveBeenCalledWith(context)
    expect(repository.read).toHaveBeenCalledWith(owner, { referenceId: "ref-1" }, "read-call-1")
  })
})
