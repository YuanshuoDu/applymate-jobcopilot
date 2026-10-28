import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

export const FINAL_ANSWER_EVIDENCE_SOURCE_MAX_BYTES = 8 * 1024
const MAX_DEPTH = 32
const MAX_NODES = 3_000
const MAX_ARRAY_ITEMS = 256
type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }
const INVALID = Symbol("invalid_evidence_json")
const SCOPE_KEYS = ["userId", "sessionId", "turnId", "taskId", "stepId"] as const

export type FinalAnswerEvidenceScope = Readonly<{
  userId: string; sessionId: string; turnId: string; taskId: string; stepId: string
}>
export type EvidenceRequestPair = Readonly<{
  uses: readonly Readonly<{ id: string; name: string; input: unknown }>[]
  results: readonly Readonly<{ toolUseId: string; content: string; isError?: boolean }>[]
}>

export function captureFinalAnswerEvidenceScope(value: unknown): FinalAnswerEvidenceScope | null {
  const row = captureEvidenceRecord(value, SCOPE_KEYS)
  if (!row || SCOPE_KEYS.some(key => !validEvidenceIdentifier(row[key]))) return null
  return Object.freeze({ userId: row.userId as string, sessionId: row.sessionId as string,
    turnId: row.turnId as string, taskId: row.taskId as string, stepId: row.stepId as string })
}

export function sameFinalAnswerEvidenceScope(a: FinalAnswerEvidenceScope, b: FinalAnswerEvidenceScope): boolean {
  return SCOPE_KEYS.every(key => a[key] === b[key])
}

export function finalAnswerEvidenceScopeJson(scope: FinalAnswerEvidenceScope): string {
  return JSON.stringify(SCOPE_KEYS.map(key => scope[key]))
}

export function modelRequestMatchesEvidenceScope(metadataInput: unknown, expected: FinalAnswerEvidenceScope): boolean {
  const metadata = captureEvidenceRecord(metadataInput)
  if (!metadata || Object.keys(metadata).some(key => ![...SCOPE_KEYS, "featureId", "traceId"].includes(key))) return false
  const scope = captureFinalAnswerEvidenceScope({ userId: metadata.userId, sessionId: metadata.sessionId,
    turnId: metadata.turnId, taskId: metadata.taskId, stepId: metadata.stepId })
  return Boolean(scope && sameFinalAnswerEvidenceScope(scope, expected))
}

export function captureEvidenceRequestPairs(messagesInput: unknown): Map<string, EvidenceRequestPair> | null {
  const messages = captureEvidenceArray(messagesInput, 2_048)
  if (!messages) return null
  const pairs = new Map<string, { uses: Array<{ id: string; name: string; input: unknown }>;
    results: Array<{ toolUseId: string; content: string; isError?: boolean }> }>()
  for (const raw of messages) {
    const message = captureEvidenceRecord(raw, ["role", "content"]), parts = message && captureEvidenceArray(message.content, 512)
    if (!message || !parts) return null
    for (const rawPart of parts) {
      const part = captureEvidenceRecord(rawPart)
      if (!part || typeof part.type !== "string") continue
      if (part.type === "tool_use" && message.role === "assistant") {
        const use = captureEvidenceRecord(rawPart, ["type", "id", "name", "input"])
        if (!use || !validEvidenceIdentifier(use.id) || !validEvidenceIdentifier(use.name)) return null
        const pair = pairs.get(use.id) ?? { uses: [], results: [] }
        pair.uses.push({ id: use.id, name: use.name, input: use.input }); pairs.set(use.id, pair)
      } else if (part.type === "tool_result" && message.role === "tool") {
        const fields = Object.hasOwn(part, "isError") ? ["type", "toolUseId", "content", "isError"] : ["type", "toolUseId", "content"]
        const result = captureEvidenceRecord(rawPart, fields)
        if (!result || !validEvidenceIdentifier(result.toolUseId) || typeof result.content !== "string"
          || Object.hasOwn(result, "isError") && typeof result.isError !== "boolean") return null
        const pair = pairs.get(result.toolUseId) ?? { uses: [], results: [] }
        pair.results.push({ toolUseId: result.toolUseId, content: result.content,
          ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}) }); pairs.set(result.toolUseId, pair)
      }
    }
  }
  return pairs
}

export function evidenceDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
}

export function evidenceScopeDigest(scope: FinalAnswerEvidenceScope): string {
  return evidenceDigest(finalAnswerEvidenceScopeJson(scope))
}

export function evidenceReferenceKey(scopeDigest: string, observationId: string, toolCallId: string, toolName: string,
  sourceRef: string, inputDigest: string, resultDigest: string): string {
  return `E-${evidenceDigest(JSON.stringify([scopeDigest, observationId, toolCallId, toolName, sourceRef, inputDigest, resultDigest])).slice(7)}`
}

/** Captures JSON through data descriptors, then bounds the normalized UTF-8 bytes. */
export function captureEvidenceJson(value: unknown, maxBytes = FINAL_ANSWER_EVIDENCE_SOURCE_MAX_BYTES): JsonValue | null {
  try {
    const captured = capture(value, new Set(), { nodes: 0 }, 0)
    if (captured === INVALID) return null
    const encoded = JSON.stringify(captured)
    return typeof encoded === "string" && Buffer.byteLength(encoded, "utf8") <= maxBytes ? captured : null
  } catch { return null }
}

/** Copies one data record without invoking accessors. */
export function captureEvidenceRecord(value: unknown, expected?: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || expected && keys.length !== expected.length) return null
    const result = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      if (typeof key !== "string" || expected && !has(expected, key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      result[key] = descriptor.value
    }
    if (expected) for (const key of expected) if (!Object.hasOwn(result, key)) return null
    return result
  } catch { return null }
}

/** Returns a safe dense snapshot of a native array. */
export function captureEvidenceArray(value: unknown, maxItems = MAX_ARRAY_ITEMS): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxItems) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1) return null
    for (const key of keys) {
      if (key === "length") continue
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return null
    }
    const result: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}

/** Stable JSON matches the serializer used by the actual model request builder. */
export function stableAnswerEvidenceJson(value: unknown): string {
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (let index = 0; index < value.length; index += 1) parts.push(stableAnswerEvidenceJson(value[index]))
    return `[${parts.join(",")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    entries.sort(([left], [right]) => left.localeCompare(right))
    const parts: string[] = []
    for (const [key, child] of entries) parts.push(`${JSON.stringify(key)}:${stableAnswerEvidenceJson(child)}`)
    return `{${parts.join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("answer_evidence_json_invalid")
  return encoded
}

function capture(value: unknown, seen: Set<object>, state: { nodes: number }, depth: number): JsonValue | typeof INVALID {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID
  if (!value || typeof value !== "object" || depth > MAX_DEPTH || state.nodes++ > MAX_NODES || seen.has(value)) return INVALID
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY_ITEMS) return INVALID
      const entries = captureEvidenceArray(value)
      if (!entries) return INVALID
      const result: JsonValue[] = []
      for (const item of entries) { const child = capture(item, seen, state, depth + 1); if (child === INVALID) return INVALID; result.push(child) }
      return result
    }
    const record = captureEvidenceRecord(value)
    if (!record || Object.keys(record).length > 256) return INVALID
    const result = Object.create(null) as Record<string, JsonValue>
    for (const [key, item] of Object.entries(record)) { const child = capture(item, seen, state, depth + 1); if (child === INVALID) return INVALID; result[key] = child }
    return result
  } catch { return INVALID } finally { seen.delete(value) }
}

function has(values: readonly string[], target: string): boolean {
  for (const value of values) if (value === target) return true
  return false
}

function validEvidenceIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}
