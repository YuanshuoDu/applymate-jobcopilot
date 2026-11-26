export const OBJECTIVE_TAILOR_SOURCE_GROUPS_FIELD = "objectiveTailorSourceGroups" as const
export const OBJECTIVE_TAILOR_SOURCE_GROUPS_SCHEMA = "agent-harness.v2.objective-tailor-source-groups.v1" as const

export type ObjectiveTailorSourceGroups = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_SOURCE_GROUPS_SCHEMA
  graphRevision: number
  groups: Readonly<{
    discoveredJobs: readonly string[]
    analyzedJobs: readonly string[]
  }>
}>

const SOURCE_KEY = /^src_[A-Za-z0-9_-]{43}$/
const MAX_SOURCES = 8

/** Parses the closed, opaque Objective count-to-source projection. */
export function parseObjectiveTailorSourceGroups(value: unknown): ObjectiveTailorSourceGroups | undefined {
  try {
    const row = record(value)
    if (!row || !exactKeys(row, ["graphRevision", "groups", "schemaVersion"])
      || row.schemaVersion !== OBJECTIVE_TAILOR_SOURCE_GROUPS_SCHEMA
      || !positiveSafeInteger(row.graphRevision)) return undefined
    const groups = record(row.groups)
    if (!groups || !exactKeys(groups, ["analyzedJobs", "discoveredJobs"])) return undefined
    const discoveredJobs = sourceKeys(groups.discoveredJobs), analyzedJobs = sourceKeys(groups.analyzedJobs)
    if (!discoveredJobs || !analyzedJobs || discoveredJobs.length + analyzedJobs.length > MAX_SOURCES) return undefined
    const seen = new Set<string>()
    for (const key of [...discoveredJobs, ...analyzedJobs]) {
      if (seen.has(key)) return undefined
      seen.add(key)
    }
    return { schemaVersion: OBJECTIVE_TAILOR_SOURCE_GROUPS_SCHEMA, graphRevision: row.graphRevision,
      groups: { discoveredJobs, analyzedJobs } }
  } catch { return undefined }
}

function sourceKeys(value: unknown): readonly string[] | undefined {
  if (!dense(value, MAX_SOURCES)) return undefined
  const keys: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))?.value
    if (typeof item !== "string" || !SOURCE_KEY.test(item)) return undefined
    keys.push(item)
  }
  return keys
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if (prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== "string")) return undefined
    const stringKeys = keys as string[]
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of stringKeys) copy[key] = Object.getOwnPropertyDescriptor(value, key)!.value
    return copy
  } catch { return undefined }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key))
}

function dense(value: unknown, maximum: number): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return false
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || !keys.includes("length")
      || keys.some(key => typeof key !== "string" || key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) return false
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    return true
  } catch { return false }
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}
