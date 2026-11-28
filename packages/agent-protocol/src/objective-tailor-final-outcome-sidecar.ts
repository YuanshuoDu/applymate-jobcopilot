export const OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA = "agent-harness.v2.objective-tailor-final-outcomes.v1" as const
export const OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_STATUSES = ["ready", "needs_revision", "rejected", "stale", "failed"] as const

export type ObjectiveTailorFinalOutcomeSidecarStatus = typeof OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_STATUSES[number]
export type ObjectiveTailorFinalOutcomeSidecar = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA
  slots: readonly Readonly<{ ordinal: number; status: ObjectiveTailorFinalOutcomeSidecarStatus }>[]
}>

/** Parses only the small public final projection; private proof material is never accepted. */
export function parseObjectiveTailorFinalOutcomeSidecar(value: unknown): ObjectiveTailorFinalOutcomeSidecar | undefined {
  const row = record(value)
  if (!row || !exactKeys(row, "schemaVersion,slots") || row.schemaVersion !== OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA
    || !dense(row.slots)) return undefined
  const slots: ObjectiveTailorFinalOutcomeSidecar["slots"][number][] = []
  for (let index = 0; index < row.slots.length; index += 1) {
    const slot = record(row.slots[index])
    if (!slot || !exactKeys(slot, "ordinal,status") || slot.ordinal !== index + 1
      || !oneOf(slot.status, OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_STATUSES)) return undefined
    slots.push({ ordinal: index + 1, status: slot.status })
  }
  return { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA, slots }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
  const keys = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if (keys.length > 2 || prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== "string")) return undefined
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
