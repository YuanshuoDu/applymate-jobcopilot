import { describe, expect, it } from 'vitest'
import { encodeEntitlements, parseEntitlements } from './plan-entitlement-editor'

describe('plan entitlement editor codec', () => {
  it('parses the existing catalogue format into structured rights', () => {
    expect(parseEntitlements(['applications:5/month', 'auto_apply', 'tracker:unlimited', 'cv:tailoring'])).toMatchObject([
      { key: 'applications', kind: 'limit', value: 5, unit: 'month' },
      { key: 'auto_apply', kind: 'boolean' },
      { key: 'tracker', kind: 'unlimited' },
      { key: 'cv', kind: 'text', value: 'tailoring' },
    ])
  })

  it('encodes structured rights back to the runtime catalogue format', () => {
    const drafts = parseEntitlements(['applications:5/month', 'auto_apply', 'tracker:unlimited', 'cv:tailoring'])
    expect(encodeEntitlements(drafts)).toEqual(['applications:5/month', 'auto_apply', 'tracker:unlimited', 'cv:tailoring'])
  })

  it('rejects duplicate or malformed permissions before save', () => {
    const drafts = parseEntitlements(['auto_apply', 'auto_apply'])
    expect(() => encodeEntitlements(drafts)).toThrow('only be added once')
    expect(() => encodeEntitlements([{ id: 'x', key: 'bad key', kind: 'boolean', value: '', unit: '' }])).toThrow('lowercase')
  })
})
