import { describe, expect, it } from 'vitest'

import {
  OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA,
  objectiveApplicationApprovalSetItemId,
  parseObjectiveApplicationApprovalSet,
} from './objective-application-approval-set.js'

const approvalSet = {
  schema: OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA,
  waitKind: 'approval_set',
  setId: 'set_01',
  sourceTurnId: 'turn-01',
  intentHash: 'a'.repeat(64),
  expiresAt: '2026-11-24T12:30:00.000Z',
  members: [
    { slotOrdinal: 1, approvalId: 'approval_01' },
    { slotOrdinal: 4, approvalId: 'approval:04' },
  ],
}

describe('objective application approval-set protocol', () => {
  it('parses and freezes a canonical bounded set', () => {
    const parsed = parseObjectiveApplicationApprovalSet(approvalSet)
    expect(parsed).toEqual(approvalSet)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.members)).toBe(true)
    expect(parsed?.members.every(Object.isFrozen)).toBe(true)
  })

  it.each([
    ['unknown schema', { ...approvalSet, schema: 'objective-application-approval-set.v2' }],
    ['wrong wait kind', { ...approvalSet, waitKind: 'approval' }],
    ['extra set property', { ...approvalSet, nonce: 'secret' }],
    ['invalid set ID', { ...approvalSet, setId: 'set/01' }],
    ['invalid source turn ID', { ...approvalSet, sourceTurnId: ' turn-01' }],
    ['uppercase hash', { ...approvalSet, intentHash: 'A'.repeat(64) }],
    ['short hash', { ...approvalSet, intentHash: 'a'.repeat(63) }],
    ['noncanonical expiry', { ...approvalSet, expiresAt: '2026-11-24T12:30:00Z' }],
    ['impossible expiry', { ...approvalSet, expiresAt: '2026-02-30T12:30:00.000Z' }],
    ['empty members', { ...approvalSet, members: [] }],
    ['too many members', { ...approvalSet, members: Array.from({ length: 9 }, (_, index) => ({ slotOrdinal: index + 1, approvalId: `approval-${index}` })) }],
    ['duplicate approval IDs', { ...approvalSet, members: [{ slotOrdinal: 1, approvalId: 'same' }, { slotOrdinal: 2, approvalId: 'same' }] }],
    ['unordered ordinals', { ...approvalSet, members: [{ slotOrdinal: 4, approvalId: 'approval-4' }, { slotOrdinal: 2, approvalId: 'approval-2' }] }],
    ['out of range ordinal', { ...approvalSet, members: [{ slotOrdinal: 9, approvalId: 'approval-9' }] }],
    ['member extra property', { ...approvalSet, members: [{ slotOrdinal: 1, approvalId: 'approval-1', jobId: 'job-1' }] }],
  ])('rejects %s', (_label, value) => {
    expect(parseObjectiveApplicationApprovalSet(value)).toBeNull()
  })

  it('rejects accessors, non-plain objects, and decorated or sparse arrays', () => {
    const accessor = { ...approvalSet }
    Object.defineProperty(accessor, 'setId', { enumerable: true, get: () => 'set_01' })
    const sparse = [{ slotOrdinal: 1, approvalId: 'approval-1' }, , { slotOrdinal: 3, approvalId: 'approval-3' }]
    const decorated = [...approvalSet.members] as typeof approvalSet.members & { extra?: string }
    Object.assign(decorated, { extra: 'hidden-member' })
    expect(parseObjectiveApplicationApprovalSet(accessor)).toBeNull()
    expect(parseObjectiveApplicationApprovalSet(Object.assign(Object.create(null), approvalSet))).toEqual(approvalSet)
    expect(parseObjectiveApplicationApprovalSet({ ...approvalSet, members: sparse })).toBeNull()
    expect(parseObjectiveApplicationApprovalSet({ ...approvalSet, members: decorated })).toBeNull()
    expect(parseObjectiveApplicationApprovalSet({ ...approvalSet, members: Object.assign(Object.create(Array.prototype), approvalSet.members) })).toBeNull()
    expect(parseObjectiveApplicationApprovalSet(Object.create({ ...approvalSet }))).toBeNull()
  })

  it('builds the stable wait-item ID and rejects malformed set IDs', () => {
    expect(objectiveApplicationApprovalSetItemId('set_01')).toBe('agent-wait:approval-set:set_01')
    expect(() => objectiveApplicationApprovalSetItemId('bad/id')).toThrow(TypeError)
  })
})
