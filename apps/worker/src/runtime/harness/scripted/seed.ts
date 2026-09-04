import type { JsonValue } from "./types.js"

export function resolveHarnessSeed(raw = process.env.HARNESS_SEED): number {
  if (raw === undefined || raw.trim() === "") return 42
  const seed = Number(raw)
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("HARNESS_SEED must be a non-negative safe integer")
  return seed
}

export function createSeededRandom(seed: number): { next(): number; integer(maxExclusive: number): number } {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("seed must be a non-negative safe integer")
  let value = seed >>> 0
  const next = (): number => {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, integer: (maxExclusive) => {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new TypeError("maxExclusive must be positive")
    return Math.floor(next() * maxExclusive)
  } }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Trace values must contain finite numbers")
    return value
  }
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== "object") throw new TypeError("Trace values must be JSON serializable")
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]))
}
