import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

export const MAX_DURABLE_DISCOVERY_BYTES = 1024 * 1024
const MAX_DURABLE_CHUNK_BYTES = 4096
const MAX_DURABLE_CHUNKS = Math.ceil(MAX_DURABLE_DISCOVERY_BYTES / MAX_DURABLE_CHUNK_BYTES)
const DURABLE_RESULT_REF = /^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

export type DurableDiscoveryReference = { readonly ref: string; readonly byteCount: number; readonly sha256: string }
type DurableDiscoveryChunkDigest = { readonly byteCount: number; readonly sha256: string }
export type DurableDiscoveryAssembly = {
  readonly reference: DurableDiscoveryReference
  readonly chunks: Map<number, Buffer>
  readonly completedChunks: Map<number, DurableDiscoveryChunkDigest>
  nextOffset: number
  bytesStored: number
  invalid: boolean
  complete: boolean
}
export type DurableDiscoveryReduction =
  | { readonly kind: "pending"; readonly addedBytes: number; readonly releasedBytes: 0 }
  | { readonly kind: "duplicate"; readonly addedBytes: 0; readonly releasedBytes: 0 }
  | { readonly kind: "complete"; readonly value: unknown; readonly addedBytes: number; readonly releasedBytes: number }
  | { readonly kind: "invalid"; readonly addedBytes: number; readonly releasedBytes: number }

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
      ? Object.getOwnPropertySymbols(value).length === 0 ? value as Record<string, unknown> : undefined
      : undefined
  } catch { return undefined }
}

export function isPlainJson(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false
  if (!Array.isArray(value)) try { const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) return false } catch { return false }
  seen.add(value)
  try { return (Array.isArray(value) ? value : Object.values(value)).every(child => isPlainJson(child, seen, depth + 1)) } finally { seen.delete(value) }
}

/** Returns undefined for an ordinary result; malformed durable markers fail closed. */
export function parseDurableDiscoveryReference(output: unknown): DurableDiscoveryReference | undefined {
  const value = plainRecord(output)
  if (!value || !["$ref", "sizeBytes", "sha256"].some(key => Object.hasOwn(value, key))) return undefined
  if (Object.keys(value).sort().join(",") !== "$ref,sha256,sizeBytes" || typeof value.$ref !== "string" || !DURABLE_RESULT_REF.test(value.$ref)
    || !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 1 || (value.sizeBytes as number) > MAX_DURABLE_DISCOVERY_BYTES
    || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Error("child_resume_evidence_invalid")
  return { ref: value.$ref, byteCount: value.sizeBytes as number, sha256: value.sha256 }
}

export function createDurableDiscoveryAssembly(reference: DurableDiscoveryReference): DurableDiscoveryAssembly {
  return { reference, chunks: new Map(), completedChunks: new Map(), nextOffset: 0, bytesStored: 0, invalid: false, complete: false }
}

export function invalidateDurableDiscoveryAssembly(assembly: DurableDiscoveryAssembly): number {
  const releasedBytes = assembly.bytesStored
  assembly.bytesStored = 0
  assembly.chunks.clear()
  assembly.completedChunks.clear()
  assembly.invalid = true
  assembly.complete = false
  return releasedBytes
}

function parseCompleteBytes(complete: Buffer): unknown | undefined {
  try {
    const text = complete.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(complete)) return undefined
    const parsed: unknown = JSON.parse(text)
    return isPlainJson(parsed) ? parsed : undefined
  } catch { return undefined }
}

/** Adds one bounded chunk to a single durable result and returns parsed JSON only after full verification. */
export function reduceDurableDiscoveryChunk(
  assembly: DurableDiscoveryAssembly,
  value: unknown,
  request?: unknown,
  maxBufferedBytes = MAX_DURABLE_DISCOVERY_BYTES,
): DurableDiscoveryReduction {
  if (assembly.invalid) return { kind: "invalid", addedBytes: 0, releasedBytes: 0 }
  const reject = (addedBytes = 0): DurableDiscoveryReduction => ({ kind: "invalid", addedBytes, releasedBytes: invalidateDurableDiscoveryAssembly(assembly) })
  const reference = assembly.reference
  const chunk = plainRecord(value)
  if (!chunk || Object.keys(chunk).sort().join(",") !== "byteCount,chunk,nextCursor,ref,sha256"
    || chunk.ref !== reference.ref || chunk.sha256 !== reference.sha256 || chunk.byteCount !== reference.byteCount
    || typeof chunk.chunk !== "string" || Buffer.from(chunk.chunk, "utf8").toString("utf8") !== chunk.chunk) return reject()
  const bytes = Buffer.from(chunk.chunk, "utf8")
  const end = chunk.nextCursor === null ? reference.byteCount
    : typeof chunk.nextCursor === "string" && /^(0|[1-9]\d*)$/.test(chunk.nextCursor) ? Number(chunk.nextCursor) : NaN
  const start = end - bytes.length
  if (!Number.isSafeInteger(end) || end < 1 || end > reference.byteCount || (chunk.nextCursor !== null && end >= reference.byteCount)
    || !Number.isSafeInteger(start) || start < 0 || bytes.length > MAX_DURABLE_CHUNK_BYTES) return reject()
  if (request !== undefined) {
    const input = plainRecord(request)
    const cursor = input?.cursor === undefined ? 0
      : typeof input.cursor === "string" && /^(0|[1-9]\d*)$/.test(input.cursor) ? Number(input.cursor) : NaN
    if (!input || input.referenceId !== reference.ref || Object.keys(input).some(key => key !== "referenceId" && key !== "cursor") || !Number.isSafeInteger(cursor) || cursor !== start) return reject()
  }
  if (bytes.length === 0) {
    return chunk.nextCursor === null && start === reference.byteCount && assembly.nextOffset === reference.byteCount && assembly.complete
      ? { kind: "duplicate", addedBytes: 0, releasedBytes: 0 }
      : reject()
  }
  const previous = assembly.chunks.get(start)
  if (previous) return previous.equals(bytes) ? { kind: "duplicate", addedBytes: 0, releasedBytes: 0 } : reject()
  const completed = assembly.completedChunks.get(start)
  if (completed) return completed.byteCount === bytes.length && completed.sha256 === createHash("sha256").update(bytes).digest("hex")
    ? { kind: "duplicate", addedBytes: 0, releasedBytes: 0 } : reject()
  if (assembly.complete) return reject()
  if (start !== assembly.nextOffset || assembly.chunks.size >= MAX_DURABLE_CHUNKS
    || !Number.isSafeInteger(maxBufferedBytes) || assembly.bytesStored + bytes.length > maxBufferedBytes) return reject()
  assembly.chunks.set(start, bytes)
  assembly.bytesStored += bytes.length
  assembly.nextOffset = end
  if (end < reference.byteCount) return { kind: "pending", addedBytes: bytes.length, releasedBytes: 0 }
  const complete = Buffer.concat([...assembly.chunks.entries()].sort(([left], [right]) => left - right).map(([, part]) => part), reference.byteCount)
  if (complete.length !== reference.byteCount || createHash("sha256").update(complete).digest("hex") !== reference.sha256) return reject(bytes.length)
  const parsed = parseCompleteBytes(complete)
  if (parsed === undefined) return reject(bytes.length)
  for (const [offset, part] of assembly.chunks) {
    assembly.completedChunks.set(offset, { byteCount: part.length, sha256: createHash("sha256").update(part).digest("hex") })
  }
  const releasedBytes = assembly.bytesStored
  assembly.chunks.clear()
  assembly.bytesStored = 0
  assembly.complete = true
  return { kind: "complete", value: parsed, addedBytes: bytes.length, releasedBytes }
}
