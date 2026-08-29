import { describe, expect, it } from 'vitest'
import { resumePdfFilename } from '@/lib/resume-export'

describe('resumePdfFilename', () => {
  it('creates a safe PDF filename from the resume name', () => {
    expect(resumePdfFilename('Tailored for Example Corp / Support?', 'Alex Example')).toBe('Alex Example - Example Corp - Support-.pdf')
  })

  it('does not duplicate the applicant name for a general resume', () => {
    expect(resumePdfFilename('Alex Example - General', 'Alex Example')).toBe('Alex Example - General.pdf')
  })

  it('falls back to Resume when the name is empty', () => {
    expect(resumePdfFilename('   ')).toBe('Resume.pdf')
  })
})
