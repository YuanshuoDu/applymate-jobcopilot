export const OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE = "agent-harness.v2.objective-tailor-execution-budget.v1" as const

export type ObjectiveTailorWaveBudgetDisposition = "legacy" | "wave" | "invalid"

/** Distinguishes a normal budget snapshot from an explicit but unsupported wave profile. */
export function objectiveTailorWaveBudgetDisposition(value: unknown): ObjectiveTailorWaveBudgetDisposition {
  if (value === undefined || value === null || typeof value !== "object") return "legacy"
  if (!plainRecord(value)) return "invalid"
  try {
    const profile = Object.getOwnPropertyDescriptor(value, "objectiveTailorProfile")
    if (!profile) return "legacy"
    if (!profile.enumerable || !("value" in profile)) return "invalid"
    const row = exactRecord(value, ["limits", "objectiveTailorProfile"])
    const limits = row && exactRecord(row.limits, ["maxSteps"])
    return row?.objectiveTailorProfile === OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE && limits?.maxSteps === 96
      ? "wave" : "invalid"
  } catch { return "invalid" }
}

export function isObjectiveTailorWaveBudgetSnapshot(value: unknown): boolean {
  return objectiveTailorWaveBudgetDisposition(value) === "wave"
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch { return false }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!plainRecord(value)) return undefined
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return undefined
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) copy[key] = Object.getOwnPropertyDescriptor(value, key)!.value
    return copy
  } catch { return undefined }
}
