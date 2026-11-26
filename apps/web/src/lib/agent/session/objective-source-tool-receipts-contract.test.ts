import { describe, expect, it } from 'vitest'

import {
  OBJECTIVE_SOURCE_TOOL_RECEIPT_SCHEMA,
  parseObjectiveSourceToolReceiptEvidence,
} from './objective-source-tool-receipts-contract'

const sourceKey = `src_${'a'.repeat(43)}`
const receiptKey = `rcp_${'b'.repeat(43)}`
const base = {
  schemaVersion: OBJECTIVE_SOURCE_TOOL_RECEIPT_SCHEMA,
  graphRevision: 7,
  sourceKey,
  role: 'analyst',
  receipts: [{ ordinal: 1, receiptKey, toolName: 'jobs.get', delivery: 'fresh' }],
}

describe('Objective source tool receipt contract', () => {
  it('accepts the bounded fresh and replayed receipt projection', () => {
    expect(parseObjectiveSourceToolReceiptEvidence(base)).toEqual(base)
    expect(parseObjectiveSourceToolReceiptEvidence({ ...base, role: 'scout', receipts: [
      base.receipts[0], { ordinal: 2, receiptKey: `rcp_${'c'.repeat(43)}`, toolName: 'tool_results.read', delivery: 'replayed' },
    ] })).toMatchObject({ role: 'scout', receipts: [{ delivery: 'fresh' }, { delivery: 'replayed' }] })
  })

  it.each([
    { ...base, graphRevision: 0 },
    { ...base, graphRevision: 1_000_001 },
    { ...base, role: ['analyst'] },
    { ...base, sourceKey: 'src_foreign' },
    { ...base, receipts: [] },
    { ...base, receipts: [{ ...base.receipts[0], ordinal: 2 }] },
    { ...base, receipts: [{ ...base.receipts[0], toolName: 'persona.retrieve' }] },
    { ...base, receipts: [{ ...base.receipts[0], receiptKey: `${receiptKey}x` }] },
    { ...base, privateTaskId: 'task-secret' },
  ])('rejects malformed or private evidence', value => expect(parseObjectiveSourceToolReceiptEvidence(value)).toBeUndefined())

  it('rejects duplicate keys and accessor-backed values', () => {
    expect(parseObjectiveSourceToolReceiptEvidence({ ...base, receipts: [base.receipts[0], { ...base.receipts[0], ordinal: 2 }] })).toBeUndefined()
    const value = { ...base, receipts: [{ ...base.receipts[0] }] }
    Object.defineProperty(value.receipts[0], 'toolName', { enumerable: true, get: () => 'jobs.get' })
    expect(parseObjectiveSourceToolReceiptEvidence(value)).toBeUndefined()
  })
})
