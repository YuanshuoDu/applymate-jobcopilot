import { describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

import {
  createDurableDiscoveryAssembly,
  parseDurableDiscoveryReference,
  reduceDurableDiscoveryChunk,
  type DurableDiscoveryReference,
} from "./child-durable-discovery.js"

const REF = "tool-result-12345678-1234-4234-9234-123456789abc"
const MAX_BYTES = 1024 * 1024
const CHUNK_BYTES = 4096

function fixture(text: string) {
  const bytes = Buffer.from(text, "utf8")
  const reference: DurableDiscoveryReference = { ref: REF, byteCount: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
  return { bytes, reference }
}

function chunk(reference: DurableDiscoveryReference, text: string, nextCursor: string | null, ref = reference.ref, byteCount = reference.byteCount, sha256 = reference.sha256) {
  return { ref, sha256, byteCount, chunk: text, nextCursor }
}

function request(referenceId: string, cursor?: number) {
  return { referenceId, ...(cursor === undefined ? {} : { cursor: String(cursor) }) }
}

describe("durable jobs.discover result reducer", () => {
  it("parses only the exact durable reference envelope", () => {
    const { reference } = fixture("{\"jobs\":[]}")
    expect(parseDurableDiscoveryReference({ $ref: reference.ref, sizeBytes: reference.byteCount, sha256: reference.sha256 })).toEqual(reference)
    expect(parseDurableDiscoveryReference({ jobs: [] })).toBeUndefined()
    expect(() => parseDurableDiscoveryReference({ $ref: reference.ref, sizeBytes: reference.byteCount })).toThrow("child_resume_evidence_invalid")
  })

  it("keeps an incomplete chunk set pending without producing JSON", () => {
    const text = "{\"jobs\":[{\"id\":\"job-1\"}]}"
    const { reference } = fixture(text)
    const split = 10
    const assembly = createDurableDiscoveryAssembly(reference)

    const result = reduceDurableDiscoveryChunk(assembly, chunk(reference, text.slice(0, split), String(Buffer.byteLength(text.slice(0, split)))), request(REF))

    expect(result).toMatchObject({ kind: "pending", addedBytes: split, releasedBytes: 0 })
    expect(assembly.complete).toBe(false)
  })

  it("rejects a chunk with a mismatched reference id", () => {
    const { bytes, reference } = fixture("{\"jobs\":[]}")
    const assembly = createDurableDiscoveryAssembly(reference)

    const result = reduceDurableDiscoveryChunk(assembly, chunk(reference, bytes.toString("utf8"), null, "tool-result-87654321-4321-4321-8321-cba987654321"), request(REF))

    expect(result.kind).toBe("invalid")
    expect(assembly.invalid).toBe(true)
  })

  it("rejects a chunk with a mismatched byte count", () => {
    const { bytes, reference } = fixture("{\"jobs\":[]}")
    const assembly = createDurableDiscoveryAssembly(reference)

    const result = reduceDurableDiscoveryChunk(assembly, chunk(reference, bytes.toString("utf8"), null, reference.ref, reference.byteCount + 1), request(REF))

    expect(result.kind).toBe("invalid")
    expect(assembly.invalid).toBe(true)
  })

  it("rejects a reassembled result whose SHA-256 does not match", () => {
    const text = "{\"jobs\":[]}"
    const { bytes, reference } = fixture(text)
    const mismatched = { ...reference, sha256: "f".repeat(64) }
    const assembly = createDurableDiscoveryAssembly(mismatched)

    const result = reduceDurableDiscoveryChunk(assembly, chunk(mismatched, bytes.toString("utf8"), null), request(REF))

    expect(result.kind).toBe("invalid")
    expect(assembly.invalid).toBe(true)
  })

  it("rejects malformed JSON after all chunks are reassembled", () => {
    const text = "{not-json"
    const { bytes, reference } = fixture(text)
    const assembly = createDurableDiscoveryAssembly(reference)

    const result = reduceDurableDiscoveryChunk(assembly, chunk(reference, bytes.toString("utf8"), null), request(REF))

    expect(result.kind).toBe("invalid")
    expect(assembly.complete).toBe(false)
  })

  it("returns JSON only after valid full reassembly", () => {
    const value = { jobs: [{ id: "c123456789012345678901234", title: "Engineer" }] }
    const text = JSON.stringify(value)
    const { reference } = fixture(text)
    const split = 12
    const firstText = text.slice(0, split)
    const firstBytes = Buffer.byteLength(firstText, "utf8")
    const assembly = createDurableDiscoveryAssembly(reference)
    const first = reduceDurableDiscoveryChunk(assembly, chunk(reference, firstText, String(firstBytes)), request(REF))
    const second = reduceDurableDiscoveryChunk(assembly, chunk(reference, text.slice(split), null), request(REF, firstBytes))

    expect(first.kind).toBe("pending")
    expect(second).toMatchObject({ kind: "complete", value })
    expect(assembly.complete).toBe(true)
  })

  it("releases completed chunk buffers while retaining compact replay validation", () => {
    const text = JSON.stringify({ payload: "x".repeat(9_000) })
    const { bytes, reference } = fixture(text)
    const assembly = createDurableDiscoveryAssembly(reference)
    let final: ReturnType<typeof reduceDurableDiscoveryChunk> | undefined

    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, bytes.length)
      const chunkText = bytes.subarray(offset, end).toString("utf8")
      final = reduceDurableDiscoveryChunk(
        assembly, chunk(reference, chunkText, end === bytes.length ? null : String(end)), request(REF, offset),
      )
    }

    expect(final).toMatchObject({ kind: "complete", releasedBytes: bytes.length })
    expect(assembly.bytesStored).toBe(0)
    expect(assembly.chunks.size).toBe(0)
    expect(assembly.completedChunks.size).toBe(3)
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, bytes.length)
      expect(reduceDurableDiscoveryChunk(
        assembly,
        chunk(reference, bytes.subarray(offset, end).toString("utf8"), end === bytes.length ? null : String(end)),
        request(REF, offset),
      ).kind).toBe("duplicate")
    }

    const conflicting = `!${bytes.subarray(0, CHUNK_BYTES).toString("utf8").slice(1)}`
    expect(reduceDurableDiscoveryChunk(
      assembly, chunk(reference, conflicting, String(CHUNK_BYTES)), request(REF),
    )).toMatchObject({ kind: "invalid", releasedBytes: 0 })
    expect(assembly.invalid).toBe(true)
  })

  it("accepts exactly 1 MiB across 256 chunks and rejects a reference above the bound", () => {
    const prefix = '{"payload":"'
    const payloadLength = MAX_BYTES - Buffer.byteLength(prefix, "utf8") - 2
    const text = `${prefix}${"x".repeat(payloadLength)}"}`
    const { bytes } = fixture(text)
    const reference = parseDurableDiscoveryReference({
      $ref: REF, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    })
    if (!reference) throw new Error("test_durable_reference_not_parsed")
    const assembly = createDurableDiscoveryAssembly(reference)
    let final: ReturnType<typeof reduceDurableDiscoveryChunk> | undefined
    let chunks = 0

    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, bytes.length)
      final = reduceDurableDiscoveryChunk(assembly, chunk(
        reference, bytes.subarray(offset, end).toString("utf8"), end === bytes.length ? null : String(end),
      ), request(REF, offset))
      chunks += 1
    }

    expect(bytes.length).toBe(MAX_BYTES)
    expect(chunks).toBe(256)
    expect(final?.kind).toBe("complete")
    if (final?.kind === "complete") expect(final.value).toEqual({ payload: "x".repeat(payloadLength) })
    expect(() => parseDurableDiscoveryReference({
      $ref: REF, sizeBytes: MAX_BYTES + 1, sha256: "a".repeat(64),
    })).toThrow("child_resume_evidence_invalid")
  })

  it("rebuilds the same result from persisted chunks after a restart", () => {
    const text = JSON.stringify({ jobs: [{ id: "c123456789012345678901234" }] })
    const { reference } = fixture(text)
    const split = 9
    const firstText = text.slice(0, split)
    const firstBytes = Buffer.byteLength(firstText, "utf8")
    const persisted = [
      { output: chunk(reference, firstText, String(firstBytes)), input: request(REF) },
      { output: chunk(reference, text.slice(split), null), input: request(REF, firstBytes) },
    ]
    const beforeRestart = createDurableDiscoveryAssembly(reference)
    expect(reduceDurableDiscoveryChunk(beforeRestart, persisted[0]!.output, persisted[0]!.input).kind).toBe("pending")

    const restarted = createDurableDiscoveryAssembly(reference)
    let restored: unknown
    for (const item of persisted) {
      const result = reduceDurableDiscoveryChunk(restarted, item.output, item.input)
      if (result.kind === "complete") restored = result.value
    }

    expect(restored).toEqual(JSON.parse(text))
  })

  it("accepts an identical replay and rejects a conflicting replay", () => {
    const text = "{\"jobs\":[{\"id\":\"job-1\"}]}"
    const { reference } = fixture(text)
    const firstText = text.slice(0, 10)
    const firstBytes = Buffer.byteLength(firstText, "utf8")
    const assembly = createDurableDiscoveryAssembly(reference)
    const firstChunk = chunk(reference, firstText, String(firstBytes))

    expect(reduceDurableDiscoveryChunk(assembly, firstChunk, request(REF)).kind).toBe("pending")
    expect(reduceDurableDiscoveryChunk(assembly, firstChunk, request(REF)).kind).toBe("duplicate")
    const conflict = reduceDurableDiscoveryChunk(assembly, chunk(reference, `!${firstText.slice(1)}`, String(firstBytes)), request(REF))

    expect(conflict.kind).toBe("invalid")
    expect(assembly.invalid).toBe(true)
  })
})
