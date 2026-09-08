import { describe, expect, it } from "vitest"

import {
  MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_READ_BYTES,
  type ToolResultChunk, type ToolResultReadInput, type ToolResultReferenceRecord,
} from "./tool-result-reference-types.js"

describe("tool result reference contracts", () => {
  it("represents a resumable private chunk without exposing storage-only fields", () => {
    const input: ToolResultReadInput = { referenceId: "ref-1", cursor: "4096" }
    const chunk: ToolResultChunk = { ref: input.referenceId, sha256: "a".repeat(64), byteCount: 8192, chunk: "x".repeat(4096), nextCursor: "8192" }
    const record: Pick<ToolResultReferenceRecord, "id" | "sha256" | "byteCount"> = { id: chunk.ref, sha256: chunk.sha256, byteCount: chunk.byteCount }

    expect(chunk.nextCursor).toBe(String(chunk.byteCount))
    expect(record).toEqual({ id: "ref-1", sha256: "a".repeat(64), byteCount: 8192 })
    expect("sanitizedJson" in chunk).toBe(false)
  })

  it("keeps each read chunk budget below the retained result budget", () => {
    expect(MAX_TOOL_RESULT_READ_BYTES).toBeLessThan(MAX_TOOL_RESULT_BYTES)
    expect(MAX_TOOL_RESULT_READ_BYTES).toBe(4096)
  })
})
