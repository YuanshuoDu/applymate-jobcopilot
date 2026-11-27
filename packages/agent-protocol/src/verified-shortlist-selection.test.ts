import { describe, expect, it } from 'vitest'

import { validate } from './validation.js'
import {
  VERIFIED_SHORTLIST_SELECTION_SCHEMA,
  VerifiedShortlistSelectionBindingSchema,
  parseVerifiedShortlistJobIds,
  parseVerifiedShortlistSelectionBinding,
  parseVerifiedShortlistSourceIdentity,
  sameVerifiedShortlistSelectionBinding,
} from './verified-shortlist-selection.js'

const source = { sessionId: 'session-1', sourceTurnId: 'turn-1', rootTaskId: 'root-1', graphItemId: 'task-graph:root-1', graphRevision: 4 }
const binding = { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source, selectedJobIds: ['job-1', 'job-2'] }

describe('verified shortlist selection contract', () => {
  it('parses the closed binding and freezes its exact Job order', () => {
    expect(validate(VerifiedShortlistSelectionBindingSchema, binding)).toBe(true)
    const parsed = parseVerifiedShortlistSelectionBinding(binding)
    expect(parsed).toEqual(binding)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.source)).toBe(true)
    expect(Object.isFrozen(parsed?.selectedJobIds)).toBe(true)
  })

  it.each([
    ['extra binding key', { ...binding, userId: 'user-1' }],
    ['wrong version', { ...binding, schemaVersion: 'future' }],
    ['extra source key', { ...binding, source: { ...source, userId: 'user-1' } }],
    ['empty source id', { ...binding, source: { ...source, sessionId: '' } }],
    ['unsafe source id', { ...binding, source: { ...source, sourceTurnId: 'turn/1' } }],
    ['whitespace source id', { ...binding, source: { ...source, rootTaskId: ' root-1' } }],
    ['zero revision', { ...binding, source: { ...source, graphRevision: 0 } }],
    ['fractional revision', { ...binding, source: { ...source, graphRevision: 1.5 } }],
    ['unsafe revision', { ...binding, source: { ...source, graphRevision: Number.MAX_SAFE_INTEGER + 1 } }],
    ['one Job', { ...binding, selectedJobIds: ['job-1'] }],
    ['duplicate Jobs', { ...binding, selectedJobIds: ['job-1', 'job-1'] }],
    ['four Jobs beyond shortlist maximum', { ...binding, selectedJobIds: ['job-1', 'job-2', 'job-3', 'job-4'] }],
    ['unsafe Job id', { ...binding, selectedJobIds: ['job/1', 'job-2'] }],
    ['whitespace Job id', { ...binding, selectedJobIds: ['job-1\n', 'job-2'] }],
  ])('rejects %s', (_label, value) => {
    expect(parseVerifiedShortlistSelectionBinding(value)).toBeNull()
  })

  it('rejects accessor-backed and non-plain records', () => {
    const accessor = { ...source }
    Object.defineProperty(accessor, 'sessionId', { enumerable: true, get: () => 'session-1' })
    expect(parseVerifiedShortlistSourceIdentity(accessor)).toBeNull()
    expect(parseVerifiedShortlistSelectionBinding({ ...binding, source: new Date() })).toBeNull()
  })

  it('requires a dense ordinary Job array', () => {
    const sparse = ['job-1', , 'job-2']
    const decorated = ['job-1', 'job-2'] as string[] & { extra?: string }
    decorated.extra = 'job-3'
    expect(parseVerifiedShortlistJobIds([])).toBeNull()
    expect(parseVerifiedShortlistJobIds(sparse)).toBeNull()
    expect(parseVerifiedShortlistJobIds(decorated)).toBeNull()
    expect(parseVerifiedShortlistJobIds(Object.assign(Object.create(Array.prototype), ['job-1', 'job-2']))).toBeNull()
  })

  it('compares exact source revision and canonical Job order on replay', () => {
    const otherRevision = { ...binding, source: { ...source, graphRevision: 5 } }
    const reversed = { ...binding, selectedJobIds: ['job-2', 'job-1'] }
    expect(sameVerifiedShortlistSelectionBinding(binding, binding)).toBe(true)
    expect(sameVerifiedShortlistSelectionBinding(otherRevision, binding)).toBe(false)
    expect(sameVerifiedShortlistSelectionBinding(reversed, binding)).toBe(false)
    expect(sameVerifiedShortlistSelectionBinding({ ...binding, extra: true }, binding)).toBe(false)
  })
})
