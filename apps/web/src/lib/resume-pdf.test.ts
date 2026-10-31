import { describe, expect, it } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { renderResumeDoc } from './resume-pdf'
import type { Resume } from './types'

describe('resume PDF rendering', () => {
  it('renders custom, reordered sections and long text into a real PDF', async () => {
    const resume = { name: 'Fixture', templateId: 'clean', templateOptions: { fontFamily: 'mono' }, content: {
      contact: { name: 'Fixture Candidate', email: 'fixture@example.invalid', location: 'Dublin', github: 'https://github.invalid/fixture' },
      summary: 'Hidden summary', experience: [{ role: 'Engineer', company: 'Example', period: '2025', bullets: Array.from({ length: 80 }, (_, i) => `Evidence ${i}`) }],
      education: [{ institution: 'Example University', degree: 'Engineering', year: '2024' }], skills: ['TypeScript'],
      sectionOrder: ['skills', 'custom_awards', 'experience', 'education'], custom: [{ id: 'custom_awards', title: 'Awards', items: [{ title: 'Prize', bullets: ['Honour'] }] }],
    } } as Resume
    const bytes = await renderToBuffer(await renderResumeDoc(resume) as never)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(3000)
  }, 30000)
})
