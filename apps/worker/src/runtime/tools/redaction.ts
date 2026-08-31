import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key|credential|token|email|phone|address|linkedin|github|resume|cv|raw[_-]?(?:content|text|data)|content|value|question|sensitive|confirmed[_-]?answers|\bname\b)/i
const SENSITIVE_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_KEY_TOKEN = /\b(?:sk-|xox[baprs]-)[a-z0-9._~+/=-]{8,}/gi
const SENSITIVE_EMAIL = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi
const SENSITIVE_ASSIGNMENT = /\b(password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi
export const DEFAULT_MAX_LIFECYCLE_BYTES = 8 * 1024

export interface ToolResultReference {
  readonly ref: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface ToolResultReferenceStore {
  put(value: RepositoryJsonValue): Promise<ToolResultReference>
}

export class InMemoryToolResultReferenceStore implements ToolResultReferenceStore {
  private readonly values = new Map<string, RepositoryJsonValue>()

  constructor(private readonly maxEntries = 256) {}

  async put(value: RepositoryJsonValue): Promise<ToolResultReference> {
    const encoded = JSON.stringify(value)
    const sha256 = createHash("sha256").update(encoded).digest("hex")
    const ref = `tool-result:${sha256.slice(0, 24)}`
    if (!this.values.has(ref) && this.values.size >= this.maxEntries) this.values.delete(this.values.keys().next().value as string)
    this.values.set(ref, value)
    return { ref, sizeBytes: Buffer.byteLength(encoded), sha256 }
  }

  get(ref: string): RepositoryJsonValue | undefined {
    return this.values.get(ref)
  }
}

export async function sanitizeForLifecycle(
  value: unknown,
  references: ToolResultReferenceStore,
  maxBytes = DEFAULT_MAX_LIFECYCLE_BYTES,
): Promise<RepositoryJsonValue> {
  const safe = redact(value)
  const encoded = JSON.stringify(safe)
  if (Buffer.byteLength(encoded) <= maxBytes) return safe
  const reference = await references.put(safe)
  return { $ref: reference.ref, sizeBytes: reference.sizeBytes, sha256: reference.sha256 }
}

function redact(value: unknown, key: string | null = null, depth = 0): RepositoryJsonValue {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]"
  if (typeof value === "string") return value.replace(SENSITIVE_TOKEN, "Bearer [REDACTED]").replace(SENSITIVE_KEY_TOKEN, "[REDACTED]").replace(SENSITIVE_EMAIL, "[REDACTED_EMAIL]").replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]"
  if (depth >= 8) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((entry) => redact(entry, null, depth + 1))
  if (typeof value !== "object" || value === undefined) return "[REDACTED]"
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey, depth + 1)]))
}
