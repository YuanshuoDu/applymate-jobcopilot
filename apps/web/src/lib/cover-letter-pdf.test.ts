import { describe, expect, it } from 'vitest'
import { renderCoverLetterDoc } from './cover-letter-pdf'
import { UnsupportedPdfTextError } from './pdf-text-support'

describe('PDF cover-letter text', () => {
  it('passes the complete reviewed content through unchanged', async () => {
    const content = 'Dear Hiring Team,\n\nA supported statement.\n\nKind regards,\nRenée'
    const element = await renderCoverLetterDoc(content, 'clean', {}, { name: 'Renée' }, { company: 'Example', role: 'Engineer' })
    expect((element.props as { content: string }).content).toBe(content)
  })
  it('fails clearly for unsupported applicant, recipient, or body glyphs', async () => {
    for (const [body, name, company] of [['中文', 'Candidate', 'Acme'], ['Letter', 'Олена', 'Acme'], ['Letter', 'Candidate', '株式会社']]) {
      await expect(renderCoverLetterDoc(body, 'clean', {}, { name }, { company, role: 'Engineer' })).rejects.toThrow(UnsupportedPdfTextError)
    }
  })
})
