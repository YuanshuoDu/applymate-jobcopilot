import { describe, expect, it } from 'vitest'

import {
  OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA,
  parseObjectiveApplicationReviewIntent,
} from './objective-application-review-intent.js'

const intent = {
  schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA,
  sourceTurnId: 'turn-01',
  rootTaskId: 'root-01',
  graphItemId: 'item-01',
  graphRevision: 23,
  slotOrdinals: [1, 3, 8],
}

describe('Objective application review intent protocol', () => {
  it('parses and freezes the exact bounded selection identity', () => {
    const parsed = parseObjectiveApplicationReviewIntent(intent)
    expect(parsed).toEqual(intent)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.slotOrdinals)).toBe(true)
  })

  it.each([
    ['unknown schema', { ...intent, schema: 'agent-harness.v2.objective-application-review-intent.v2' }],
    ['extra property', { ...intent, jobId: 'job-01' }],
    ['missing property', { schema: intent.schema, sourceTurnId: intent.sourceTurnId, rootTaskId: intent.rootTaskId, graphItemId: intent.graphItemId, graphRevision: intent.graphRevision }],
    ['invalid source turn ID', { ...intent, sourceTurnId: ' turn-01' }],
    ['invalid root task ID', { ...intent, rootTaskId: 'root/01' }],
    ['invalid graph item ID', { ...intent, graphItemId: '' }],
    ['non-positive revision', { ...intent, graphRevision: 0 }],
    ['fractional revision', { ...intent, graphRevision: 1.5 }],
    ['unsafe revision', { ...intent, graphRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['empty slots', { ...intent, slotOrdinals: [] }],
    ['more than eight slots', { ...intent, slotOrdinals: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
    ['duplicate slots', { ...intent, slotOrdinals: [1, 1] }],
    ['unordered slots', { ...intent, slotOrdinals: [2, 1] }],
    ['out of range slot', { ...intent, slotOrdinals: [9] }],
    ['string slot', { ...intent, slotOrdinals: ['1'] }],
  ])('rejects %s', (_label, value) => {
    expect(parseObjectiveApplicationReviewIntent(value)).toBeNull()
  })

  it('rejects accessors, non-plain objects, and sparse or decorated arrays', () => {
    const accessor = { ...intent }
    Object.defineProperty(accessor, 'graphRevision', { enumerable: true, get: () => 23 })
    const sparse = [1, , 3]
    const decorated = Object.assign([...intent.slotOrdinals], { extra: true })
    expect(parseObjectiveApplicationReviewIntent(accessor)).toBeNull()
    expect(parseObjectiveApplicationReviewIntent(Object.create({ ...intent }))).toBeNull()
    expect(parseObjectiveApplicationReviewIntent(Object.assign(Object.create(null), intent))).toEqual(intent)
    expect(parseObjectiveApplicationReviewIntent({ ...intent, slotOrdinals: sparse })).toBeNull()
    expect(parseObjectiveApplicationReviewIntent({ ...intent, slotOrdinals: decorated })).toBeNull()
    expect(parseObjectiveApplicationReviewIntent({ ...intent, slotOrdinals: Object.assign(Object.create(Array.prototype), intent.slotOrdinals) })).toBeNull()
  })
})
