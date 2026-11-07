import { describe, expect, it } from 'vitest'
import { parseApplicationAuditView } from './application-audit-view'

describe('application audit response', () => {
  it.each(['pending', 'failed', 'stale', 'unavailable'] as const)('keeps %s separate from a missing audit', state => {
    expect(parseApplicationAuditView({ state })).toEqual({ state, record: null })
  })

  it('treats malformed results as unavailable instead of ready', () => {
    for (const value of [undefined, {}, { state: 'unknown' }, { resumeId: 'resume', coverLetterId: null, audit: null }]) {
      expect(parseApplicationAuditView(value)).toEqual({ state: 'unavailable', record: null })
    }
    expect(parseApplicationAuditView(null)).toEqual({ state: 'none', record: null })
  })

  it('retains a correctly shaped audit response', () => {
    const record = { resumeId: 'resume', coverLetterId: null, operationId: '123e4567-e89b-42d3-a456-426614174000', audit: { verdict: 'pass', auditedAt: '2026-11-05T12:00:00.000Z', findings: [] } }
    expect(parseApplicationAuditView(record)).toEqual({ state: 'complete', record })
  })

  it('fails closed when a completed response lacks a valid operation identity', () => {
    const record = { resumeId: 'resume', coverLetterId: null, audit: { verdict: 'pass', auditedAt: '2026-11-05T12:00:00.000Z', findings: [] } }
    expect(parseApplicationAuditView(record)).toEqual({ state: 'unavailable', record: null })
    expect(parseApplicationAuditView({ ...record, operationId: 'invalid' })).toEqual({ state: 'unavailable', record: null })
  })
})
