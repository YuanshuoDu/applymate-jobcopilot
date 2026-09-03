import { ContextSnapshotError } from "./context-snapshot-types.js"

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|client[_-]?secret|private[_-]?key|credential)$/i
const SECRET_TEXT = /\b(?:bearer\s+[a-z0-9._~+/=-]{8,}|(?:sk-|xox[baprs]-)[a-z0-9._~+/=-]{8,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+)/i

function canonicalValue(value: unknown, path = "$"): CanonicalJsonValue {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (SECRET_TEXT.test(value)) throw new ContextSnapshotError("invalid_input", `${path} contains secret material`)
    return value
  }
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContextSnapshotError("invalid_input", `${path} must contain finite numbers`)
    return value
  }
  if (value === undefined) throw new ContextSnapshotError("invalid_input", `${path} is undefined`)
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`))
  if (typeof value !== "object" || value instanceof Date) throw new ContextSnapshotError("invalid_input", `${path} is not JSON serializable`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new ContextSnapshotError("invalid_input", `${path} must be a plain object`)
  const result = Object.create(null) as { [key: string]: CanonicalJsonValue }
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (SECRET_KEY.test(key)) throw new ContextSnapshotError("invalid_input", `${path}.${key} contains secret material`)
    result[key] = canonicalValue((value as Record<string, unknown>)[key], `${path}.${key}`)
  }
  return result
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}
