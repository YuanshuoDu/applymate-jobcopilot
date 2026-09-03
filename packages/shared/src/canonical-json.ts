import { createHash } from "node:crypto"

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CanonicalJsonError"
  }
}

/**
 * Serialize JSON-compatible values deterministically across runtimes.
 * Object keys use JavaScript's stable UTF-16 code-unit ordering, rather than
 * locale-sensitive ICU collation.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("Artifact content contains a non-finite number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`
  }
  throw new CanonicalJsonError("Artifact content must be JSON-compatible")
}

export function hashContent(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`
}
