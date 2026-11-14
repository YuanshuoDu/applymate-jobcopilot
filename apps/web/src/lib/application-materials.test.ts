import { describe, expect, it } from 'vitest'
import type { StoredApplicationAudit } from './application-audit'
import { auditMatchesCurrentMaterials } from './application-materials'

const date = '2026-10-30T01:00:00.000Z'
const record = { resumeId: 'r1', coverLetterId: null, resumeUpdatedAt: date,
  audit: { verdict: 'pass', auditedAt: date, findings: [] } } as unknown as StoredApplicationAudit
const current = (overrides: Partial<StoredApplicationAudit> = {}, resumeAt: string | null = date, letterAt: string | null = null, dirty = false) =>
  auditMatchesCurrentMaterials({ ...record, ...overrides }, 'r1', null, resumeAt, letterAt, dirty)

describe('current application materials', () => {
  it('accepts an audited resume without an optional cover letter', () => expect(current()).toBe(true))
  it('rejects another resume or letter binding', () => {
    expect(current({ resumeId: 'r2' })).toBe(false)
    expect(current({ coverLetterId: 'c1' })).toBe(false)
  })
  it('rejects edits, missing documents, and malformed timestamps', () => {
    expect(current({}, date, null, true)).toBe(false)
    expect(current({}, null)).toBe(false)
    expect(current({}, 'invalid')).toBe(false)
    expect(current({}, '2026-10-30T02:00:00.000Z')).toBe(false)
    expect(current({ audit: { ...record.audit, auditedAt: 'invalid' } })).toBe(false)
  })
  it('checks cover-letter versions when a letter is selected', () => {
    const withLetter = { ...record, coverLetterId: 'c1', coverLetterUpdatedAt: date }
    expect(auditMatchesCurrentMaterials(withLetter, 'r1', 'c1', date, date, false)).toBe(true)
    expect(auditMatchesCurrentMaterials(withLetter, 'r1', 'c1', date, null, false)).toBe(false)
    expect(auditMatchesCurrentMaterials(withLetter, 'r1', 'c1', date, '2026-10-30T02:00:00.000Z', false)).toBe(false)
  })
  it('conservatively supports legacy audits with no exact versions', () => {
    expect(current({ resumeUpdatedAt: undefined })).toBe(true)
    expect(current({ resumeUpdatedAt: undefined }, '2026-10-30T02:00:00.000Z')).toBe(false)
  })
})
