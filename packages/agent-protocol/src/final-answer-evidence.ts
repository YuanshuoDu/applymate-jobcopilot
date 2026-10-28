import { Type, type Static } from '@sinclair/typebox'
import { validate } from './validation.js'

export const ANSWER_EVIDENCE_SCHEMA_VERSION = 1 as const
export const ANSWER_EVIDENCE_MAX_SOURCES = 8
export const ANSWER_EVIDENCE_MAX_LABEL_CHARACTERS = 120
export const ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS = 600
export const ANSWER_EVIDENCE_MAX_TOTAL_EXCERPT_CHARACTERS = 3_000
export const ANSWER_EVIDENCE_MAX_UTF8_BYTES = 18 * 1024

/** The bounded public categories; source identifiers and locators are intentionally absent. */
export const AnswerEvidenceKindSchema = Type.Union([
  Type.Literal('job'),
  Type.Literal('persona'),
  Type.Literal('resume'),
])

/** Structural display contract only. Producers must sanitize projected labels and excerpts. */
export const AnswerEvidenceSourceSchema = Type.Object({
  key: Type.String({ minLength: 2, maxLength: 2, pattern: '^S[1-8]$' }),
  kind: AnswerEvidenceKindSchema,
  label: Type.String({ minLength: 1, maxLength: ANSWER_EVIDENCE_MAX_LABEL_CHARACTERS }),
  excerpt: Type.String({ minLength: 1, maxLength: ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS }),
}, { additionalProperties: false })

export const AnswerEvidenceSchema = Type.Object({
  schemaVersion: Type.Literal(ANSWER_EVIDENCE_SCHEMA_VERSION),
  sources: Type.Array(AnswerEvidenceSourceSchema, { minItems: 1, maxItems: ANSWER_EVIDENCE_MAX_SOURCES }),
}, { additionalProperties: false })

export type AnswerEvidenceKind = Static<typeof AnswerEvidenceKindSchema>
export type AnswerEvidenceSource = Static<typeof AnswerEvidenceSourceSchema>
export type AnswerEvidence = Static<typeof AnswerEvidenceSchema>

interface TextEncoderLike { encode(input: string): Uint8Array }
const RuntimeTextEncoder = (globalThis as typeof globalThis & { TextEncoder?: new () => TextEncoderLike }).TextEncoder

/**
 * Parses the strict display contract and enforces cross-entry and serialized-size bounds.
 * This does not prove provenance or sanitize arbitrary source text; callers must project
 * only allowlisted, redacted fields before creating answer evidence.
 */
export function parseAnswerEvidence(value: unknown): AnswerEvidence | null {
  try {
    const top = snapshotRecord(value, ['schemaVersion', 'sources'])
    if (!top) return null
    const rawSources = snapshotDenseArray(top.sources, ANSWER_EVIDENCE_MAX_SOURCES)
    if (!rawSources) return null

    const sources: AnswerEvidenceSource[] = []
    for (let index = 0; index < rawSources.length; index++) {
      const sourceRecord = snapshotRecord(rawSources[index], ['key', 'kind', 'label', 'excerpt'])
      if (!sourceRecord) return null
      sources[index] = {
        key: sourceRecord.key as AnswerEvidenceSource['key'],
        kind: sourceRecord.kind as AnswerEvidenceKind,
        label: sourceRecord.label as string,
        excerpt: sourceRecord.excerpt as string,
      }
    }

    const candidate = { schemaVersion: top.schemaVersion, sources }
    if (!validate(AnswerEvidenceSchema, candidate)) return null
    const normalized = candidate as AnswerEvidence

    const keys = new Set<string>()
    let totalExcerptCharacters = 0
    for (let index = 0; index < normalized.sources.length; index++) {
      const source = normalized.sources[index]!
      if (keys.has(source.key)) return null
      keys.add(source.key)
      totalExcerptCharacters += characterCount(source.excerpt)
      if (totalExcerptCharacters > ANSWER_EVIDENCE_MAX_TOTAL_EXCERPT_CHARACTERS) return null
    }

    const serialized = JSON.stringify(normalized)
    if (typeof serialized !== 'string' || !RuntimeTextEncoder
      || new RuntimeTextEncoder().encode(serialized).byteLength > ANSWER_EVIDENCE_MAX_UTF8_BYTES) return null

    return normalized
  } catch {
    return null
  }
}

function snapshotRecord(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== expected.length) return null
    const snapshot: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== 'string' || !expectedKey(key, expected)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    return null
  }
}

function snapshotDenseArray(value: unknown, maxItems: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || lengthDescriptor.enumerable || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 1
      || Number(lengthDescriptor.value) > maxItems || keys.length !== Number(lengthDescriptor.value) + 1) return null

    const length = Number(lengthDescriptor.value)
    const snapshot: unknown[] = []
    const seen = new Set<number>()
    let sawLength = false
    for (const key of keys) {
      if (key === 'length') { sawLength = true; continue }
      if (typeof key !== 'string') return null
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key || seen.has(index)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      snapshot[index] = descriptor.value
      seen.add(index)
    }
    if (!sawLength || seen.size !== length) return null
    return snapshot
  } catch {
    return null
  }
}

function expectedKey(key: string, expected: readonly string[]): boolean {
  for (const candidate of expected) if (candidate === key) return true
  return false
}

function characterCount(value: string): number {
  let count = 0
  for (const _character of value) count++
  return count
}
