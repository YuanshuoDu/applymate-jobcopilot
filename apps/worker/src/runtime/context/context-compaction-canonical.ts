import { createHash } from "node:crypto"

import { CompactionError } from "./context-compaction-types.js"

export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | { readonly [key: string]: CanonicalJsonValue }

function canonicalValue(value: unknown, path = "$"): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CompactionError("invalid_source", `${path} must contain finite numbers`)
    return value
  }
  if (value === undefined || typeof value !== "object" || value instanceof Date) {
    throw new CompactionError("invalid_source", `${path} is not canonical JSON`)
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`))
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new CompactionError("invalid_source", `${path} must be a plain object`)
  const result: Record<string, CanonicalJsonValue> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) result[key] = canonicalValue((value as Record<string, unknown>)[key], `${path}.${key}`)
  return result
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
}
