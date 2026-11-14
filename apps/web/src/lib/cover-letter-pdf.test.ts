import { describe, expect, it } from 'vitest'
import { renderCoverLetterDoc } from './cover-letter-pdf'
import { ApplicationPdfUnsupportedCharactersError } from './application-pdf-errors'
import { renderToBuffer } from '@react-pdf/renderer'
import { CoverLetterDoc } from '@/components/resume/templates/cover-letter/CoverLetterFrame'
import React from 'react'

describe('PDF cover-letter text', () => {
  it('passes the complete reviewed content through unchanged', async () => {
    const content = 'Dear Hiring Team,\n\nA supported statement.\n\nKind regards,\nRenée'
    const element = await renderCoverLetterDoc(content, 'clean', {}, { name: 'Renée' }, { company: 'Example', role: 'Engineer' })
    expect((element.props as { content: string }).content).toBe(content)
  })
  it('renders supported multilingual text with bundled fonts', async () => {
    const bytes = await renderToBuffer(React.createElement(CoverLetterDoc, { content: '中文 Олена', applicant: { name: 'Олена' }, templateVariant: 'modern' }) as never)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
  }, 30000)
  it('fails clearly for unsupported applicant, recipient, or body glyphs', async () => {
    for (const [body, name, company] of [['🦄', 'Candidate', 'Acme'], ['Letter', '🦄', 'Acme'], ['Letter', 'Candidate', '🦄']]) {
      await expect(renderCoverLetterDoc(body, 'clean', {}, { name }, { company, role: 'Engineer' })).rejects.toThrow(ApplicationPdfUnsupportedCharactersError)
    }
  })
})
