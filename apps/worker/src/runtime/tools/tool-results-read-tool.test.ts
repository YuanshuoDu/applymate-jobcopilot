import { describe, expect, it, vi } from "vitest"

import type { ExecutionOwner } from "../execution-owner.js"
import type { ToolExecutionContext } from "./types.js"
import { createToolResultsReadTool } from "./tool-results-read-tool.js"
import type { ToolResultReferenceRepository } from "./tool-result-reference-types.js"

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

function repository(result: Awaited<ReturnType<ToolResultReferenceRepository["read"]>> = {
  ref: "ref-1", sha256: "a".repeat(64), byteCount: 16, chunk: "{\"ok\":true}", nextCursor: null,
}): ToolResultReferenceRepository {
  return { put: vi.fn(), read: vi.fn(async () => result) }
}

describe("tool_results.read", () => {
  it("requires a runtime owner resolver and returns the bounded repository chunk", async () => {
    const repo = repository()
    const resolveOwner = vi.fn(() => owner)
    const tool = createToolResultsReadTool(repo, resolveOwner)
    const result = await tool.execute(context, { referenceId: "ref-1" })

    expect(result).toMatchObject({ ref: "ref-1", nextCursor: null })
    expect(resolveOwner).toHaveBeenCalledWith(context)
    expect(repo.read).toHaveBeenCalledWith(owner, { referenceId: "ref-1" })
    expect(tool.name).toBe("tool_results.read")
    expect(tool.domain).toBe("coordination")
  })

  it("maps missing and repository failures to safe tool errors", async () => {
    const missing = createToolResultsReadTool(repository(null), () => owner)
    await expect(missing.execute(context, { referenceId: "unknown" })).rejects.toMatchObject({ code: "tool_result_not_found", message: "Tool result is unavailable" })

    const failed: ToolResultReferenceRepository = {
      put: vi.fn(), read: vi.fn(async () => { throw Object.assign(new Error("secret payload"), { code: "tool_result_corrupt" }) }),
    }
    const tool = createToolResultsReadTool(failed, () => owner)
    await expect(tool.execute(context, { referenceId: "ref-1" })).rejects.toMatchObject({ code: "tool_result_corrupt", message: "Tool result is unavailable" })
  })
})
