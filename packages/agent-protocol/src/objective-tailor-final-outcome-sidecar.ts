export const OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA = "agent-harness.v2.objective-tailor-final-outcomes.v1" as const
export const OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA = "agent-harness.v2.objective-tailor-final-outcomes.v2" as const
export const OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_STATUSES = ["ready", "needs_revision", "rejected", "stale", "failed"] as const
const OBJECTIVE_TAILOR_FINAL_OUTCOME_COVERAGES = ["complete", "partial", "unavailable", "not_requested"] as const

export type ObjectiveTailorFinalOutcomeSidecarStatus = typeof OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_STATUSES[number]
type ObjectiveTailorFinalOutcomeCoverage = typeof OBJECTIVE_TAILOR_FINAL_OUTCOME_COVERAGES[number]
type ObjectiveTailorFinalOutcomeCount = Readonly<{ knownCount: number | null; coverage: ObjectiveTailorFinalOutcomeCoverage }>
type Slot = Readonly<{ ordinal: number; status: ObjectiveTailorFinalOutcomeSidecarStatus }>
type ObjectiveTailorFinalOutcomeSidecarV1 = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA
  slots: readonly Slot[]
}>
export type ObjectiveTailorFinalOutcomeSidecarV2 = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA
  graphRevision: number
  slots: readonly Slot[]
  sourceCounts: Readonly<{ discoveredJobs: ObjectiveTailorFinalOutcomeCount; analyzedJobs: ObjectiveTailorFinalOutcomeCount }>
}>
export type ObjectiveTailorFinalOutcomeSidecar = ObjectiveTailorFinalOutcomeSidecarV1 | ObjectiveTailorFinalOutcomeSidecarV2

/** Reads the current closed projection while keeping historical V1 slot-only items valid. */
export function parseObjectiveTailorFinalOutcomeSidecar(value: unknown): ObjectiveTailorFinalOutcomeSidecar | undefined {
  const row = record(value)
  if (!row) return undefined
  if (row.schemaVersion === OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA) return parseV1(row)
  if (row.schemaVersion === OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA) return parseV2(row)
  return undefined
}

function parseV1(row: Record<string, unknown>): ObjectiveTailorFinalOutcomeSidecarV1 | undefined {
  if (!exactKeys(row, "schemaVersion,slots")) return undefined
  const slots = parseSlots(row.slots)
  return slots
    ? { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA, slots } : undefined
}

function parseV2(row: Record<string, unknown>): ObjectiveTailorFinalOutcomeSidecarV2 | undefined {
  if (!exactKeys(row, "graphRevision,schemaVersion,slots,sourceCounts") || !positiveSafeInteger(row.graphRevision)) return undefined
  const slots = parseSlots(row.slots), counts = record(row.sourceCounts)
  if (!slots || !counts || !exactKeys(counts, "analyzedJobs,discoveredJobs")) return undefined
  const discoveredJobs = parseCount(counts.discoveredJobs), analyzedJobs = parseCount(counts.analyzedJobs)
  if (!discoveredJobs || !analyzedJobs) return undefined
  return { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA, graphRevision: row.graphRevision,
    slots, sourceCounts: { discoveredJobs, analyzedJobs } }
}

function parseSlots(value: unknown): readonly Slot[] | undefined {
  if (!dense(value)) return undefined
  const slots: Slot[] = []
  for (let index = 0; index < value.length; index += 1) {
    const slot = record(value[index])
    if (!slot || !exactKeys(slot, "ordinal,status") || slot.ordinal !== index + 1
      || !oneOf(slot.status, OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_STATUSES)) return undefined
    slots.push({ ordinal: index + 1, status: slot.status })
  }
  return slots
}

function parseCount(value: unknown): ObjectiveTailorFinalOutcomeCount | undefined {
  const row = record(value)
  if (!row || !exactKeys(row, "coverage,knownCount") || !oneOf(row.coverage, OBJECTIVE_TAILOR_FINAL_OUTCOME_COVERAGES)) return undefined
  const count = row.knownCount
  if (row.coverage === "complete" || row.coverage === "partial") {
    return nonnegativeSafeInteger(count) ? { knownCount: count, coverage: row.coverage } : undefined
  }
  return count === null ? { knownCount: null, coverage: row.coverage } : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if (keys.length > 4 || prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== "string")) return undefined
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return value as Record<string, unknown>
  } catch { return undefined }
}

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value), allowed = expected.split(",")
  return keys.length === allowed.length && keys.every(key => typeof key === "string" && allowed.includes(key))
}

function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    if (value.length < 1 || value.length > 8) return false
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    return true
  } catch { return false }
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T)
}
function positiveSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonnegativeSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
