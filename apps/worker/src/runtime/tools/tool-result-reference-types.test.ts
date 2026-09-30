import { Value } from "@sinclair/typebox/value"
import { describe, expect, it, vi } from "vitest"

import type { ExecutionOwner } from "../execution-owner.js"
import type { ToolExecutionContext } from "./types.js"
import { createToolResultsReadTool } from "./tool-results-read-tool.js"
import type { ToolResultChunk, ToolResultReferenceRepository } from "./tool-result-reference-types.js"

const owner = {
  kind: "turn" as const,
  taskId: "root-1",
  lease: {
    turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
    leaseStartedAt: new Date("2026-09-08T02:59:00Z"), leaseExpiresAt: new Date("2099-01-01T00:00:00Z"),
  },
} satisfies ExecutionOwner

const context: ToolExecutionContext = {
  scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "root-1",
  signal: new AbortController().signal, capabilities: ["read"], reportProgress: vi.fn(async () => undefined),
}

describe("tool result reference runtime contract", () => {
  it("keeps the declared chunk type aligned with the registered read schema", async () => {
    const chunk: ToolResultChunk = { ref: "ref-1", sha256: "a".repeat(64), byteCount: 16, chunk: '{"ok":true}', nextCursor: null }
    const repository: ToolResultReferenceRepository = { put: vi.fn(), read: vi.fn(async () => chunk) }
    const resolveOwner = vi.fn(() => owner)
    const tool = createToolResultsReadTool(repository, resolveOwner)

    const result = await tool.execute(context, { referenceId: "ref-1" })

    expect(Value.Check(tool.outputSchema, result)).toBe(true)
    expect(result).toEqual(chunk)
    expect(resolveOwner).toHaveBeenCalledWith(context)
    expect(repository.read).toHaveBeenCalledWith(owner, { referenceId: "ref-1" })
  })
})
