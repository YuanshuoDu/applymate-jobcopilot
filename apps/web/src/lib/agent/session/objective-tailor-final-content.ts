import { parseObjectiveTailorFinalOutcomeSidecar, type ObjectiveTailorFinalOutcomeSidecar } from '@jobcopilot/agent-protocol'

export const OBJECTIVE_TAILOR_FINAL_OUTCOMES_FIELD = 'objectiveTailorFinalOutcomes' as const

/** Reads only the closed public sidecar from an own data property. */
export function parseObjectiveTailorFinalOutcomesFromContent(value: unknown): ObjectiveTailorFinalOutcomeSidecar | undefined {
  const content = record(value)
  if (!content) return undefined
  const descriptor = ownDataDescriptor(content, OBJECTIVE_TAILOR_FINAL_OUTCOMES_FIELD)
  return descriptor ? parseObjectiveTailorFinalOutcomeSidecar(descriptor.value) : undefined
}

/** Removes the sidecar before passing the remaining wrapper through older strict projectors. */
export function contentWithoutObjectiveTailorFinalOutcomes(value: unknown): Record<string, unknown> | null {
  const content = record(value)
  if (!content) return null
  try {
    const entries: [string, unknown][] = []
    for (const key of Reflect.ownKeys(content)) {
      if (typeof key !== 'string') return null
      const descriptor = Object.getOwnPropertyDescriptor(content, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      if (key !== OBJECTIVE_TAILOR_FINAL_OUTCOMES_FIELD) entries.push([key, descriptor.value])
    }
    return Object.fromEntries(entries)
  } catch { return null }
}

/** Keeps unvalidated sidecars out of generic stream redaction on every event path. */
export function stripObjectiveTailorFinalOutcomes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripObjectiveTailorFinalOutcomes)
  const row = record(value)
  if (!row) return value
  return Object.fromEntries(Object.entries(row).flatMap(([key, child]) => key === OBJECTIVE_TAILOR_FINAL_OUTCOMES_FIELD
    ? [] : [[key, stripObjectiveTailorFinalOutcomes(child)]]))
}

function ownDataDescriptor(value: Record<string, unknown>, key: string): PropertyDescriptor | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor : undefined
  } catch { return undefined }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}
