import { describe, expect, it } from 'vitest'
import type { CoverLetter } from './types'
import { applicationMaterialAssignment, selectApplicationCoverLetter } from './application-material-selection'

const selection = { jobId: 'j1', resumeId: 'r1', finalResumeId: 'r1', finalCoverLetterId: null }
const letter = { id: 'c1', jobId: 'j1', resumeId: 'r1', updatedAt: '2026-10-30T00:00:00.000Z' } as CoverLetter

describe('application cover letter selection', () => {
  it('preserves an explicitly confirmed resume-only package even when drafts exist', () => {
    expect(selectApplicationCoverLetter(selection, [letter])).toBeNull()
  })

  it('does not substitute a draft when the confirmed letter has not loaded', () => {
    expect(selectApplicationCoverLetter({ ...selection, finalCoverLetterId: 'missing' }, [letter])).toBeNull()
  })

  it('uses the exact confirmed letter rather than the first draft', () => {
    expect(selectApplicationCoverLetter({ ...selection, finalCoverLetterId: 'c2' }, [letter, { ...letter, id: 'c2' }])?.id).toBe('c2')
  })

  it('keeps the user’s explicit new edit selected without treating it as already bound', () => {
    const edited = { ...letter, id: 'new-draft' }
    expect(selectApplicationCoverLetter(selection, [letter], edited)).toBe(edited)
    expect(selection.finalCoverLetterId).toBeNull()
  })

  it('rejects letters from another job or resume, including a stale edited value', () => {
    expect(selectApplicationCoverLetter(selection, [letter], { ...letter, jobId: 'other' })).toBeNull()
    expect(selectApplicationCoverLetter({ ...selection, finalResumeId: null }, [{ ...letter, resumeId: 'other' }])).toBeNull()
  })

  it('allows an available matching draft while preparing an unconfirmed resume', () => {
    expect(selectApplicationCoverLetter({ ...selection, finalResumeId: null }, [letter])).toBe(letter)
  })
})

describe('material binding request', () => {
  it('does not touch the letter revision when the same letter is already bound', () => {
    expect(applicationMaterialAssignment('r1', 'c1', 'c1')).toEqual({ finalResumeId: 'r1' })
  })

  it('also omits an unchanged optional null letter', () => {
    expect(applicationMaterialAssignment('r1', null, null)).toEqual({ finalResumeId: 'r1' })
  })

  it('explicitly binds or clears a changed selection', () => {
    expect(applicationMaterialAssignment('r1', 'c2', 'c1')).toEqual({ finalResumeId: 'r1', finalCoverLetterId: 'c2' })
    expect(applicationMaterialAssignment('r1', null, 'c1')).toEqual({ finalResumeId: 'r1', finalCoverLetterId: null })
  })
})
