import { describe, expect, it } from 'vitest'
import { validate } from './validation.js'
import {
  ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS,
  ANSWER_EVIDENCE_MAX_LABEL_CHARACTERS,
  ANSWER_EVIDENCE_MAX_SOURCES,
  ANSWER_EVIDENCE_MAX_TOTAL_EXCERPT_CHARACTERS,
  ANSWER_EVIDENCE_MAX_UTF8_BYTES,
  ANSWER_EVIDENCE_SCHEMA_VERSION,
  AnswerEvidenceSchema,
  parseAnswerEvidence,
  type AnswerEvidence,
} from './final-answer-evidence.js'

const source = { key: 'S1', kind: 'job', label: 'Job search result', excerpt: 'Software Engineer in Dublin' } as const
const evidence: AnswerEvidence = { schemaVersion: ANSWER_EVIDENCE_SCHEMA_VERSION, sources: [source] }

describe('final answer evidence contract', () => {
  it('accepts the versioned, bounded display shape and returns a copy', () => {
    const parsed = parseAnswerEvidence(evidence)

    expect(validate(AnswerEvidenceSchema, evidence)).toBe(true)
    expect(parsed).toEqual(evidence)
    expect(parsed).not.toBe(evidence)
    expect(parsed?.sources).not.toBe(evidence.sources)
    expect(new TextEncoder().encode(JSON.stringify(parsed)).byteLength).toBeLessThanOrEqual(ANSWER_EVIDENCE_MAX_UTF8_BYTES)
  })

  it('rejects unknown properties at every object level', () => {
    expect(validate(AnswerEvidenceSchema, { ...evidence, internalMap: {} })).toBe(false)
    expect(parseAnswerEvidence({ ...evidence, internalMap: {} })).toBeNull()
    expect(parseAnswerEvidence({ ...evidence, sources: [{ ...source, sourceId: 'job-42' }] })).toBeNull()
  })

  it('requires the supported version and at least one source entry', () => {
    expect(parseAnswerEvidence({ ...evidence, schemaVersion: 2 })).toBeNull()
    expect(parseAnswerEvidence({ ...evidence, sources: [] })).toBeNull()
  })

  it('rejects empty, malformed, raw-looking, and duplicate display keys', () => {
    for (const key of ['', 'job-42', 'https://example.test/job', 'S0', 'S9', 's1', 'S1-private']) {
      expect(parseAnswerEvidence({ ...evidence, sources: [{ ...source, key }] })).toBeNull()
    }
    expect(parseAnswerEvidence({ ...evidence, sources: [source, { ...source, label: 'Second source' }] })).toBeNull()
  })

  it('rejects unsupported kinds and empty or overlong display strings', () => {
    expect(parseAnswerEvidence({ ...evidence, sources: [{ ...source, kind: 'source' }] })).toBeNull()
    expect(parseAnswerEvidence({ ...evidence, sources: [{ ...source, label: '' }] })).toBeNull()
    expect(parseAnswerEvidence({ ...evidence, sources: [{ ...source, label: 'x'.repeat(ANSWER_EVIDENCE_MAX_LABEL_CHARACTERS + 1) }] })).toBeNull()
    expect(parseAnswerEvidence({ ...evidence, sources: [{ ...source, excerpt: '' }] })).toBeNull()
    expect(parseAnswerEvidence({ ...evidence, sources: [{ ...source, excerpt: 'x'.repeat(ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS + 1) }] })).toBeNull()
  })

  it('enforces the source-count and aggregate excerpt character bounds', () => {
    const maxSources = Array.from({ length: ANSWER_EVIDENCE_MAX_SOURCES }, (_, index) => ({
      ...source, key: `S${index + 1}`,
      excerpt: 'x'.repeat(index < 4 ? ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS : ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS / 4),
    }))
    expect(parseAnswerEvidence({ ...evidence, sources: maxSources })).toMatchObject({ sources: maxSources })
    expect(parseAnswerEvidence({ ...evidence, sources: [...maxSources, { ...source }] })).toBeNull()

    const atAggregateLimit = Array.from({ length: 5 }, (_, index) => ({
      ...source, key: `S${index + 1}`, excerpt: 'x'.repeat(ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS),
    }))
    expect(atAggregateLimit.reduce((total, item) => total + [...item.excerpt].length, 0)).toBe(ANSWER_EVIDENCE_MAX_TOTAL_EXCERPT_CHARACTERS)
    expect(parseAnswerEvidence({ ...evidence, sources: atAggregateLimit })).not.toBeNull()
    expect(parseAnswerEvidence({ ...evidence, sources: [...atAggregateLimit, { ...source, key: 'S6', excerpt: 'x' }] })).toBeNull()
  })

  it('counts Unicode code points for excerpt limits', () => {
    const unicodeSource = { ...source, excerpt: '😀'.repeat(ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS) }
    expect(parseAnswerEvidence({ ...evidence, sources: [unicodeSource] })).not.toBeNull()
  })

  it('rejects serialized payloads over the UTF-8 byte budget', () => {
    const escapedTextSources = Array.from({ length: ANSWER_EVIDENCE_MAX_SOURCES }, (_, index) => ({
      ...source,
      key: `S${index + 1}`,
      label: '\u0000'.repeat(ANSWER_EVIDENCE_MAX_LABEL_CHARACTERS),
      excerpt: '\u0000'.repeat(ANSWER_EVIDENCE_MAX_TOTAL_EXCERPT_CHARACTERS / ANSWER_EVIDENCE_MAX_SOURCES),
    }))
    const oversized = { ...evidence, sources: escapedTextSources }
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(ANSWER_EVIDENCE_MAX_UTF8_BYTES)
    expect(parseAnswerEvidence(oversized)).toBeNull()
  })

  it('rejects sparse arrays and non-plain records instead of coercing them', () => {
    const sparse = new Array(1)
    expect(parseAnswerEvidence({ ...evidence, sources: sparse })).toBeNull()
    expect(parseAnswerEvidence(Object.assign(Object.create({ inherited: true }), evidence))).toBeNull()
  })

  it('rejects non-enumerable fields before projecting or measuring them', () => {
    const hiddenSources = Array.from({ length: ANSWER_EVIDENCE_MAX_SOURCES }, (_, index) => {
      const item = { ...source, key: `S${index + 1}`,
        label: '\u0000'.repeat(ANSWER_EVIDENCE_MAX_LABEL_CHARACTERS),
        excerpt: '\u0000'.repeat(ANSWER_EVIDENCE_MAX_TOTAL_EXCERPT_CHARACTERS / ANSWER_EVIDENCE_MAX_SOURCES) }
      Object.defineProperty(item, 'label', { value: item.label, enumerable: false })
      Object.defineProperty(item, 'excerpt', { value: item.excerpt, enumerable: false })
      return item
    })
    const hidden = { schemaVersion: ANSWER_EVIDENCE_SCHEMA_VERSION, sources: hiddenSources }
    const normalized = { schemaVersion: ANSWER_EVIDENCE_SCHEMA_VERSION,
      sources: hiddenSources.map(({ key, kind, label, excerpt }) => ({ key, kind, label, excerpt })) }

    expect(new TextEncoder().encode(JSON.stringify(hidden)).byteLength).toBeLessThan(ANSWER_EVIDENCE_MAX_UTF8_BYTES)
    expect(new TextEncoder().encode(JSON.stringify(normalized)).byteLength).toBeGreaterThan(ANSWER_EVIDENCE_MAX_UTF8_BYTES)
    expect(parseAnswerEvidence(hidden)).toBeNull()
  })

  it('rejects arrays with a non-native prototype that overrides traversal methods', () => {
    const hostileSources = [source]
    Object.setPrototypeOf(hostileSources, {
      every: () => true,
      map: () => [],
      reduce: () => 0,
    })

    expect(parseAnswerEvidence({ ...evidence, sources: hostileSources })).toBeNull()
  })

  it('captures changing proxy descriptor values once and validates only the plain snapshot', () => {
    const unsafeExcerpt = 'x'.repeat(ANSWER_EVIDENCE_MAX_EXCERPT_CHARACTERS + 1)
    const sourceTarget = { ...source }
    let sourceDescriptorReads = 0
    let sourceGetterReads = 0
    const changingSource = new Proxy(sourceTarget, {
      get(target, property, receiver) {
        if (property === 'excerpt') { sourceGetterReads++; return unsafeExcerpt }
        return Reflect.get(target, property, receiver)
      },
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
        if (property === 'excerpt' && descriptor && Object.hasOwn(descriptor, 'value')) {
          sourceDescriptorReads++
          return { ...descriptor, value: sourceDescriptorReads === 1 ? source.excerpt : unsafeExcerpt }
        }
        return descriptor
      },
    })

    const topTarget = { schemaVersion: ANSWER_EVIDENCE_SCHEMA_VERSION, sources: [changingSource] }
    let topDescriptorReads = 0
    let topGetterReads = 0
    const changingTop = new Proxy(topTarget, {
      get(target, property, receiver) {
        if (property === 'sources') { topGetterReads++; return [{ ...source, excerpt: unsafeExcerpt }] }
        return Reflect.get(target, property, receiver)
      },
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
        if (property === 'sources' && descriptor && Object.hasOwn(descriptor, 'value')) {
          topDescriptorReads++
          return { ...descriptor, value: topDescriptorReads === 1 ? topTarget.sources : [{ ...source, excerpt: unsafeExcerpt }] }
        }
        return descriptor
      },
    })

    const parsed = parseAnswerEvidence(changingTop)
    expect(parsed?.sources[0]?.excerpt).toBe(source.excerpt)
    expect(topDescriptorReads).toBe(1)
    expect(sourceDescriptorReads).toBe(1)
    expect(topGetterReads).toBe(0)
    expect(sourceGetterReads).toBe(0)
  })
})
