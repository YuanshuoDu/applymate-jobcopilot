import { Type, type Static } from '@sinclair/typebox'

import { validate } from './validation.js'

export const VERIFIED_SHORTLIST_SELECTION_SCHEMA = 'agent-harness.v2.verified-shortlist-selection.v1' as const
const SOURCE_ID = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' })
const JOB_ID = Type.String({ minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' })

export const VerifiedShortlistSourceIdentitySchema = Type.Object({
  sessionId: SOURCE_ID,
  sourceTurnId: SOURCE_ID,
  rootTaskId: SOURCE_ID,
  graphItemId: SOURCE_ID,
  graphRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const VerifiedShortlistSelectionBindingSchema = Type.Object({
  schemaVersion: Type.Literal(VERIFIED_SHORTLIST_SELECTION_SCHEMA),
  source: VerifiedShortlistSourceIdentitySchema,
  selectedJobIds: Type.Array(JOB_ID, { minItems: 2, maxItems: 3, uniqueItems: true }),
}, { additionalProperties: false, $id: 'agent.verified-shortlist-selection' })

export type VerifiedShortlistSourceIdentity = Readonly<Static<typeof VerifiedShortlistSourceIdentitySchema>>
export type VerifiedShortlistSelectionBinding = Readonly<{
  schemaVersion: typeof VERIFIED_SHORTLIST_SELECTION_SCHEMA
  source: VerifiedShortlistSourceIdentity
  selectedJobIds: readonly string[]
}>

const SOURCE_KEYS = ['sessionId', 'sourceTurnId', 'rootTaskId', 'graphItemId', 'graphRevision'] as const
const BINDING_KEYS = ['schemaVersion', 'source', 'selectedJobIds'] as const
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

/** Parses the exact source identity. The Web/Worker owner readers verify its persisted graph binding. */
export function parseVerifiedShortlistSourceIdentity(value: unknown): VerifiedShortlistSourceIdentity | null {
  const source = dataRecord(value, SOURCE_KEYS)
  if (!source || !safeId(source.sessionId, ID_PATTERN) || !safeId(source.sourceTurnId, ID_PATTERN)
    || !safeId(source.rootTaskId, ID_PATTERN) || !safeId(source.graphItemId, ID_PATTERN)
    || !Number.isSafeInteger(source.graphRevision) || Number(source.graphRevision) < 1) return null
  const parsed = { sessionId: source.sessionId, sourceTurnId: source.sourceTurnId, rootTaskId: source.rootTaskId,
    graphItemId: source.graphItemId, graphRevision: Number(source.graphRevision) }
  return validate(VerifiedShortlistSourceIdentitySchema, parsed) ? Object.freeze(parsed) : null
}

/** Parses a bounded, unique selection; canonical source ranking is applied by the owner-scoped verifier. */
export function parseVerifiedShortlistJobIds(value: unknown): readonly string[] | null {
  const rows = denseValues(value, 3)
  if (!rows || rows.length < 2 || rows.some(id => !safeId(id, JOB_PATTERN))) return null
  const ids = rows as string[]
  if (new Set(ids).size !== ids.length) return null
  return Object.freeze([...ids])
}

/** Rejects unknown keys and non-data objects before returning a frozen protocol binding. */
export function parseVerifiedShortlistSelectionBinding(value: unknown): VerifiedShortlistSelectionBinding | null {
  const binding = dataRecord(value, BINDING_KEYS)
  if (!binding || binding.schemaVersion !== VERIFIED_SHORTLIST_SELECTION_SCHEMA) return null
  const source = parseVerifiedShortlistSourceIdentity(binding.source)
  const selectedJobIds = parseVerifiedShortlistJobIds(binding.selectedJobIds)
  if (!source || !selectedJobIds) return null
  const parsed = { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source, selectedJobIds }
  return validate(VerifiedShortlistSelectionBindingSchema, parsed) ? Object.freeze(parsed) : null
}

/** Replays only the exact source revision and canonical selection order. */
export function sameVerifiedShortlistSelectionBinding(leftValue: unknown, rightValue: unknown): boolean {
  const left = parseVerifiedShortlistSelectionBinding(leftValue), right = parseVerifiedShortlistSelectionBinding(rightValue)
  return Boolean(left && right && SOURCE_KEYS.every(key => left.source[key] === right.source[key])
    && left.selectedJobIds.length === right.selectedJobIds.length
    && left.selectedJobIds.every((id, index) => id === right.selectedJobIds[index]))
}

function safeId(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && value.trim() === value && pattern.test(value)
}

function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key as string))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function denseValues(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string'
      || !/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= value.length))) return null
    const rows: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      rows.push(descriptor.value)
    }
    return rows
  } catch { return null }
}
