export const OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA =
  'agent-harness.v2.objective-application-review-intent.v1' as const

export type ObjectiveApplicationReviewIntent = Readonly<{
  schema: typeof OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA
  sourceTurnId: string
  rootTaskId: string
  graphItemId: string
  graphRevision: number
  slotOrdinals: readonly number[]
}>

const INTENT_KEYS = [
  'schema',
  'sourceTurnId',
  'rootTaskId',
  'graphItemId',
  'graphRevision',
  'slotOrdinals',
] as const
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Parses the exact server-resolved source identity for an Objective review Turn. */
export function parseObjectiveApplicationReviewIntent(value: unknown): ObjectiveApplicationReviewIntent | null {
  const intent = closedRecord(value)
  if (!intent || intent.schema !== OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA
    || !normalId(intent.sourceTurnId) || !normalId(intent.rootTaskId) || !normalId(intent.graphItemId)
    || !Number.isSafeInteger(intent.graphRevision) || Number(intent.graphRevision) < 1) return null

  const rawOrdinals = denseArray(intent.slotOrdinals)
  if (!rawOrdinals || rawOrdinals.length < 1 || rawOrdinals.length > 8) return null
  const slotOrdinals: number[] = []
  let previousOrdinal = 0
  for (const ordinal of rawOrdinals) {
    if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 1 || Number(ordinal) > 8
      || Number(ordinal) <= previousOrdinal) return null
    previousOrdinal = Number(ordinal)
    slotOrdinals.push(previousOrdinal)
  }

  return Object.freeze({
    schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA,
    sourceTurnId: intent.sourceTurnId,
    rootTaskId: intent.rootTaskId,
    graphItemId: intent.graphItemId,
    graphRevision: Number(intent.graphRevision),
    slotOrdinals: Object.freeze(slotOrdinals),
  })
}

function normalId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && ID_PATTERN.test(value)
}

function closedRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== INTENT_KEYS.length
      || keys.some(key => typeof key !== 'string' || !INTENT_KEYS.includes(key as typeof INTENT_KEYS[number]))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of INTENT_KEYS) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function denseArray(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length'
      && (typeof key !== 'string' || !/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= value.length))) return null
    const result: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}
