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

import { ApplicationPdfUnsupportedCharactersError } from './application-pdf-errors'
import type { ResumeContent } from './types'

const content: ResumeContent = {
  contact: { name: 'Renée Example', email: 'sample@example.invalid', location: 'Dublin', phone: '+353 123', linkedin: 'linkedin.example.invalid', github: 'github.example.invalid', website: 'portfolio.example.invalid' },
  summary: 'Builds useful systems.',
  experience: [{ company: 'Employer', role: 'Engineer', period: '2020–2024', bullets: ['Delivered supported results.'] }],
  education: [{ institution: 'University', degree: 'Computer Science', year: '2019' }],
  skills: ['TypeScript', 'SQL'], languages: [{ lang: 'French', level: 'Fluent' }],
  projects: [{ name: 'Project name', role: 'Maintainer', period: '2025', url: 'project.example.invalid', bullets: ['Project result.'] }],
  certifications: [{ name: 'Credential', issuer: 'Issuer', date: '2023', url: 'credential.example.invalid' }],
  custom: [{ id: 'custom-volunteer', title: 'Volunteering', items: [{ title: 'Tutor', subtitle: 'Community', period: '2022', bullets: ['Taught classes.'] }] }],
}
function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(strings)
  if (node && typeof node === 'object' && 'props' in node) return strings((node.props as { children?: unknown }).children)
  return []
}
async function render(overrides: Partial<ResumeContent> = {}) {
  return strings(await renderResumeDoc({ name: 'Resume', templateId: 'clean', content: { ...content, ...overrides } } as Resume)).join('\n')
}

describe('PDF resume content preservation', () => {
  it('includes every visible field, custom section, bullet and URL without truncating text', async () => {
    const text = await render()
    for (const field of [
      ...Object.values(content.contact), content.summary, 'Employer', 'Engineer', '2020–2024', 'Delivered supported results.',
      'University', 'Computer Science', '2019', 'TypeScript', 'SQL', 'French', 'Fluent', 'Project name', 'Maintainer',
      '2025', 'project.example.invalid', 'Project result.', 'Credential', 'Issuer', '2023', 'credential.example.invalid',
      'Volunteering', 'Tutor', 'Community', '2022', 'Taught classes.',
    ]) expect(text).toContain(field)
  })

  it('honors explicit section order and omission while appending existing custom sections', async () => {
    const text = await render({ sectionOrder: ['education', 'summary'] })
    expect(text.indexOf('Computer Science')).toBeLessThan(text.indexOf('Builds useful systems.'))
    expect(text).not.toContain('Delivered supported results.')
    expect(text).not.toContain('TypeScript')
    expect(text).toContain('Taught classes.')
  })

  it('does not restore deliberately hidden standard sections when the order is empty', async () => {
    const text = await render({ sectionOrder: [] })
    expect(text).toContain('Renée Example')
    expect(text).toContain('Taught classes.')
    expect(text).not.toContain('Builds useful systems.')
    expect(text).not.toContain('Computer Science')
  })

  it('never silently substitutes unsupported visible glyphs and ignores intentionally hidden text', async () => {
    await expect(render({ summary: '🦄' })).rejects.toThrow(ApplicationPdfUnsupportedCharactersError)
    await expect(render({ summary: '🦄', sectionOrder: [] })).resolves.not.toContain('🦄')
    await expect(render({ contact: { ...content.contact, name: '🦄' } })).rejects.toThrow(ApplicationPdfUnsupportedCharactersError)
  })
})
