import { describe, expect, it } from 'vitest'
import { renderApplicationPackPrintHtml } from './application-pack-print'
import type { CoverLetter, Resume } from './types'

const resume = { id: 'resume_1', name: 'Resume', content: {
  contact: { name: '张伟 / Олена', email: 'sample@example.invalid', github: 'https://example.invalid/profile' },
  summary: 'Full summary', skills: ['Hidden skill'], experience: [], education: [], sectionOrder: ['summary'],
  custom: [{ id: 'custom_1', title: 'Volunteering', items: [{ title: 'Volunteer', subtitle: 'Community', period: '2025', bullets: ['Contributed every week.'] }] }],
} } as unknown as Resume

describe('audited pack browser print view', () => {
  it('preserves Unicode, selected sections, custom items, contact links and the exact letter body', () => {
    const letter = { content: '尊敬的招聘经理：\nОлена\nSincerely,\n张伟' } as CoverLetter
    const html = renderApplicationPackPrintHtml({ company: '示例公司', role: 'Инженер' }, resume, letter)
    for (const text of ['张伟 / Олена', 'Full summary', 'https://example.invalid/profile', 'Volunteering', 'Volunteer', 'Community', '2025', 'Contributed every week.', letter.content, '示例公司', 'Инженер']) expect(html).toContain(text)
    expect(html).not.toContain('Hidden skill')
    expect(html.match(/Sincerely,/g)).toHaveLength(1)
    expect(html).toContain('break-before:page')
    expect(html).toContain('Ctrl+P')
  })

  it('keeps an explicitly empty section order empty while appending custom sections', () => {
    const html = renderApplicationPackPrintHtml({ company: 'Acme', role: 'Engineer' }, { ...resume, content: { ...resume.content, sectionOrder: [] } }, null)
    expect(html).not.toContain('Full summary')
    expect(html).not.toContain('Hidden skill')
    expect(html).toContain('Volunteering')
    expect(html).not.toContain('<article class="letter">')
  })

  it('uses default sections when no order was saved and escapes all document HTML', () => {
    const malicious = '</div><script>alert(1)</script><img src=x onerror=alert(2)>'
    const html = renderApplicationPackPrintHtml({ company: malicious, role: 'Engineer' }, {
      ...resume, content: { ...resume.content, sectionOrder: undefined, summary: malicious },
    }, { content: malicious } as CoverLetter)
    expect(html).toContain('Hidden skill')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})
