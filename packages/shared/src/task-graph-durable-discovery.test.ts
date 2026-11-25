import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { createDurableDiscoveryAssembly, parseDurableDiscoveryReference, reduceDurableDiscoveryChunk } from "./task-graph-durable-discovery.js"

const reference = { ref: "tool-result-12345678-1234-4234-9234-123456789abc", byteCount: 0, sha256: "0".repeat(64) }

describe("TaskGraph durable discovery", () => {
  it("parses exact references and rejects malformed marked references", () => {
    expect(parseDurableDiscoveryReference({ $ref: reference.ref, sizeBytes: 1, sha256: "a".repeat(64) }))
      .toEqual({ ref: reference.ref, byteCount: 1, sha256: "a".repeat(64) })
    expect(() => parseDurableDiscoveryReference({ $ref: "invalid", sizeBytes: 1, sha256: "a".repeat(64) }))
      .toThrow("child_resume_evidence_invalid")
  })

  it("assembles verified UTF-8 JSON once and treats an identical chunk as a replay", () => {
    const value = { jobs: [], evidence: [], nextCursor: null }
    const bytes = Buffer.from(JSON.stringify(value), "utf8")
    const ref = { ref: reference.ref, byteCount: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
    const assembly = createDurableDiscoveryAssembly(ref)
    const chunk = { ref: ref.ref, sha256: ref.sha256, byteCount: bytes.length, chunk: bytes.toString("utf8"), nextCursor: null }
    const request = { referenceId: ref.ref }

    expect(reduceDurableDiscoveryChunk(assembly, chunk, request)).toMatchObject({ kind: "complete", value })
    expect(reduceDurableDiscoveryChunk(assembly, chunk, request)).toEqual({ kind: "duplicate", addedBytes: 0, releasedBytes: 0 })
  })

  it("invalidates out-of-order chunks", () => {
    const bytes = Buffer.from("{}", "utf8")
    const ref = { ref: reference.ref, byteCount: 2, sha256: createHash("sha256").update(bytes).digest("hex") }
    const assembly = createDurableDiscoveryAssembly(ref)
    const result = reduceDurableDiscoveryChunk(assembly, {
      ref: ref.ref, sha256: ref.sha256, byteCount: 2, chunk: "}", nextCursor: null,
    }, { referenceId: ref.ref, cursor: "1" })
    expect(result.kind).toBe("invalid")
    expect(assembly.invalid).toBe(true)
  })
})
